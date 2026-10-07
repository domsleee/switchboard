use super::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Store {
    path: PathBuf,
}
impl Store {
    pub(super) fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?;
        let store = Self {
            path: path.to_owned(),
        };
        let conn = store.connection()?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        anyhow::ensure!(version <= 2, "Unsupported message board database version");
        conn.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS participants (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                machine_id TEXT NOT NULL, machine_name TEXT NOT NULL, name TEXT NOT NULL,
                project TEXT NOT NULL, terminal TEXT, active INTEGER NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS participants_project ON participants(project, active, seq);
            CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, project TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                sender TEXT NOT NULL REFERENCES participants(id), send_key TEXT NOT NULL, request_hash BLOB NOT NULL,
                sender_name TEXT NOT NULL, sender_machine_id TEXT NOT NULL, sender_machine_name TEXT NOT NULL,
                project TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), reply_to TEXT,
                body TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(sender, send_key));
            CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
            CREATE TABLE IF NOT EXISTS deliveries (
                message_seq INTEGER NOT NULL REFERENCES messages(seq), recipient TEXT NOT NULL REFERENCES participants(id),
                name TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL, acknowledged_at INTEGER,
                PRIMARY KEY(message_seq, recipient));
            CREATE INDEX IF NOT EXISTS deliveries_unread ON deliveries(recipient, acknowledged_at, message_seq);
            CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS machine_deliveries (
                message_seq INTEGER NOT NULL REFERENCES messages(seq), recipient TEXT NOT NULL REFERENCES machines(id),
                name TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL, acknowledged_at INTEGER,
                PRIMARY KEY(message_seq, recipient));
            CREATE INDEX IF NOT EXISTS machine_deliveries_unread ON machine_deliveries(recipient, acknowledged_at, message_seq);
            PRAGMA user_version=2;")?;
        Ok(store)
    }

    fn connection(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(conn)
    }

    pub(super) fn configure_machines(&self, machines: &[Machine]) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE machines SET active=0", [])?;
        for machine in machines {
            tx.execute("INSERT INTO machines VALUES (?1,?2,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1", params![machine.id,machine.name])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn inboxes(&self, machine: &Machine, page: ReadPage) -> Result<serde_json::Value> {
        validate_page(&page)?;
        let conn = self.connection()?;
        let mut query =
            conn.prepare("SELECT id,name FROM machines WHERE active=1 ORDER BY name,id")?;
        let machines = query
            .query_map([], |r| {
                Ok(Machine {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut result = vec![];
        for computer in machines {
            let count: u64 = conn.query_row("SELECT COUNT(*) FROM machine_deliveries d JOIN messages m ON m.seq=d.message_seq WHERE d.recipient=?1 AND d.acknowledged_at IS NULL AND (?2 IS NULL OR m.project=?2)", params![computer.id,page.project], |r|r.get(0))?;
            let mut agents = conn.prepare("SELECT seq,id,machine_id,machine_name,name,project,terminal,active,created_at FROM participants WHERE machine_id=?1 AND (?2 IS NULL OR project=?2 OR EXISTS (SELECT 1 FROM deliveries d JOIN messages m ON m.seq=d.message_seq WHERE d.recipient=participants.id AND m.project=?2)) ORDER BY active DESC,seq")?;
            let participants = agents
                .query_map(params![computer.id, page.project], participant_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut entries = vec![];
            for participant in participants {
                let count: u64 = conn.query_row("SELECT COUNT(*) FROM deliveries d JOIN messages m ON m.seq=d.message_seq WHERE d.recipient=?1 AND d.acknowledged_at IS NULL AND (?2 IS NULL OR m.project=?2)", params![participant.id,page.project], |r|r.get(0))?;
                let mut value = serde_json::to_value(participant).unwrap();
                value["unread_count"] = json!(count);
                entries.push(value);
            }
            result.push(json!({"id":computer.id,"name":computer.name,"unread_count":count,"participants":entries}));
        }
        Ok(json!({"machine_id":machine.id,"machines":result}))
    }

    pub(super) fn inbox(
        &self,
        id: &str,
        computer: bool,
        unread: bool,
        page: ReadPage,
    ) -> Result<Page<Message>> {
        validate_page(&page)?;
        let conn = self.connection()?;
        if computer {
            conn.query_row(
                "SELECT 1 FROM machines WHERE id=?1 AND active=1",
                [id],
                |_| Ok(()),
            )
            .optional()?
            .ok_or_else(BoardError::missing)?;
        } else {
            participant(&conn, id)?;
        }
        let table = if computer {
            "machine_deliveries"
        } else {
            "deliveries"
        };
        let mut query = conn.prepare(&format!("SELECT m.seq FROM {table} d JOIN messages m ON m.seq=d.message_seq WHERE d.recipient=?1 AND m.seq>?2 AND (?3=0 OR d.acknowledged_at IS NULL) AND (?4 IS NULL OR m.project=?4) ORDER BY m.seq LIMIT ?5"))?;
        let ids = query
            .query_map(
                params![id, page.after, unread, page.project, page.limit as u32 + 1],
                |r| r.get(0),
            )?
            .collect::<rusqlite::Result<Vec<u64>>>()?;
        message_page(&conn, ids, page.limit)
    }

    pub(super) fn machine_ack(
        &self,
        machine: &Machine,
        id: &str,
        message_id: &str,
    ) -> Result<Delivery> {
        if machine.id != id {
            return Err(BoardError::forbidden());
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let seq = message_seq(&tx, message_id)?;
        if tx.execute("UPDATE machine_deliveries SET acknowledged_at=COALESCE(acknowledged_at,?1) WHERE message_seq=?2 AND recipient=?3", params![now(),seq,id])? == 0 { return Err(BoardError::forbidden()); }
        let result = message(&tx, seq)?
            .deliveries
            .into_iter()
            .find(|d| d.recipient_kind == "computer" && d.recipient == id)
            .unwrap();
        tx.commit()?;
        Ok(result)
    }

    pub(super) fn register(&self, machine: &Machine, request: Register) -> Result<Participant> {
        label(&request.name, "Agent name")?;
        label(&request.project, "Project")?;
        if let Some(terminal) = &request.terminal {
            label(&terminal.host, "Terminal host")?;
            label(&terminal.session, "Terminal session")?;
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = match &request.resume {
            Some(id) => {
                owned(&tx, machine, id)?;
                id.clone()
            },
            None => Uuid::new_v4().to_string(),
        };
        let terminal = request.terminal.map(|t| serde_json::to_string(&t).unwrap());
        tx.execute("INSERT INTO participants (id,machine_id,machine_name,name,project,terminal,active,created_at)
            VALUES (?1,?2,?3,?4,?5,?6,1,?7) ON CONFLICT(id) DO UPDATE SET
            machine_name=excluded.machine_name,name=excluded.name,project=excluded.project,terminal=excluded.terminal,active=1",
            params![id,machine.id,machine.name,request.name,request.project,terminal,now()])?;
        let participant = participant(&tx, &id)?;
        tx.commit()?;
        Ok(participant)
    }

    pub(super) fn retire(&self, machine: &Machine, id: &str) -> Result<Participant> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        owned(&tx, machine, id)?;
        tx.execute("UPDATE participants SET active=0 WHERE id=?1", [id])?;
        let result = participant(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    pub(super) fn participants(&self, page: ReadPage) -> Result<Page<Participant>> {
        validate_page(&page)?;
        let conn = self.connection()?;
        let mut query = conn.prepare("SELECT seq,id,machine_id,machine_name,name,project,terminal,active,created_at
            FROM participants WHERE active=1 AND seq>?1 AND (?2 IS NULL OR project=?2) ORDER BY seq LIMIT ?3")?;
        let rows = query.query_map(
            params![page.after, page.project, page.limit as u32 + 1],
            participant_row,
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let next_cursor = if items.len() > page.limit as usize {
            items.pop();
            items.last().map(|p| p.cursor)
        } else {
            None
        };
        Ok(Page { items, next_cursor })
    }

    pub(super) fn send(&self, machine: &Machine, request: SendMessage) -> Result<Message> {
        label(&request.send_key, "Send key")?;
        if request.body.is_empty() || request.body.len() > MAX_BODY {
            return Err(BoardError::invalid(
                "Message body must contain 1–65536 bytes",
            ));
        }
        if request.reply_to.is_some() {
            if request.to.is_some() || request.broadcast.is_some() || request.to_machine.is_some() {
                return Err(BoardError::invalid(
                    "Reply chooses the original sender automatically",
                ));
            }
        } else if [
            request.to.is_some(),
            request.broadcast.is_some(),
            request.to_machine.is_some(),
        ]
        .into_iter()
        .filter(|v| *v)
        .count()
            != 1
        {
            return Err(BoardError::invalid(
                "Choose one agent, computer, or project broadcast",
            ));
        }
        let hash = Sha256::digest(serde_json::to_vec(&request).unwrap());
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let sender = owned(&tx, machine, &request.sender)?;
        if let Some((seq, previous_hash)) = tx
            .query_row(
                "SELECT seq,request_hash FROM messages WHERE sender=?1 AND send_key=?2",
                params![request.sender, request.send_key],
                |r| Ok((r.get::<_, u64>(0)?, r.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?
        {
            if previous_hash != hash.as_slice() {
                return Err(BoardError::conflict(
                    "Send key already belongs to a different message",
                ));
            }
            return message(&tx, seq);
        }
        if !sender.active {
            return Err(BoardError::conflict(
                "Resume this retired agent before sending",
            ));
        }
        let (project, thread, recipients) = if let Some(reply_id) = &request.reply_to {
            let seq = message_seq(&tx, reply_id)?;
            let original = message(&tx, seq)?;
            if !original.deliveries.iter().any(|d| {
                (d.recipient_kind == "agent" && d.recipient == sender.id)
                    || (d.recipient_kind == "computer" && d.machine_id == machine.id)
            }) {
                return Err(BoardError::forbidden());
            }
            let recipient = participant(&tx, &original.sender)?;
            active_recipient(&tx, &recipient)?;
            (original.project, original.thread_id, vec![recipient])
        } else {
            let recipients = if request.to_machine.is_some() {
                vec![]
            } else if let Some(project) = &request.broadcast {
                if project != &sender.project {
                    return Err(BoardError::forbidden());
                }
                let mut query = tx.prepare("SELECT p.id FROM participants p JOIN machines c ON c.id=p.machine_id WHERE p.active=1 AND c.active=1 AND p.project=?1 AND p.id<>?2 ORDER BY p.seq LIMIT ?3")?;
                let ids = query
                    .query_map(params![project, sender.id, MAX_RECIPIENTS + 1], |r| {
                        r.get::<_, String>(0)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if ids.is_empty() || ids.len() > MAX_RECIPIENTS {
                    return Err(BoardError::conflict(
                        "Broadcast needs 1–256 other active participants",
                    ));
                }
                ids.iter()
                    .map(|id| participant(&tx, id))
                    .collect::<Result<Vec<_>>>()?
            } else {
                vec![resolve(&tx, request.to.as_ref().unwrap(), &sender.project)?]
            };
            let thread = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO threads VALUES (?1,?2,?3)",
                params![thread, sender.project, now()],
            )?;
            (sender.project.clone(), thread, recipients)
        };
        let id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO messages (id,sender,send_key,request_hash,sender_name,sender_machine_id,sender_machine_name,project,thread_id,reply_to,body,created_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id,sender.id,request.send_key,hash.as_slice(),sender.name,sender.machine_id,sender.machine_name,project,thread,request.reply_to,request.body,now()])?;
        let seq = tx.last_insert_rowid() as u64;
        for recipient in recipients {
            tx.execute("INSERT INTO deliveries (message_seq,recipient,name,machine_id,machine_name) VALUES (?1,?2,?3,?4,?5)",
                params![seq,recipient.id,recipient.name,recipient.machine_id,recipient.machine_name])?;
        }
        if let Some(id) = &request.to_machine {
            let name: String = tx
                .query_row(
                    "SELECT name FROM machines WHERE id=?1 AND active=1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(BoardError::missing)?;
            tx.execute("INSERT INTO machine_deliveries (message_seq,recipient,name,machine_id,machine_name) VALUES (?1,?2,?3,?2,?3)", params![seq,id,name])?;
        }
        let result = message(&tx, seq)?;
        tx.commit()?;
        Ok(result)
    }

    pub(super) fn unread(
        &self,
        machine: &Machine,
        id: &str,
        page: ReadPage,
    ) -> Result<Page<Message>> {
        validate_page(&page)?;
        let conn = self.connection()?;
        owned(&conn, machine, id)?;
        let mut query = conn.prepare(
            "SELECT message_seq FROM deliveries WHERE recipient=?1 AND acknowledged_at IS NULL
            AND message_seq>?2 ORDER BY message_seq LIMIT ?3",
        )?;
        let ids = query
            .query_map(params![id, page.after, page.limit as u32 + 1], |r| {
                r.get::<_, u64>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        message_page(&conn, ids, page.limit)
    }

    pub(super) fn thread(&self, id: &str, page: ReadPage) -> Result<Page<Message>> {
        validate_page(&page)?;
        let conn = self.connection()?;
        let exists = conn
            .query_row("SELECT 1 FROM threads WHERE id=?1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(BoardError::missing());
        }
        let mut query = conn.prepare(
            "SELECT seq FROM messages WHERE thread_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
        )?;
        let ids = query
            .query_map(params![id, page.after, page.limit as u32 + 1], |r| {
                r.get::<_, u64>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        message_page(&conn, ids, page.limit)
    }

    pub(super) fn ack(&self, machine: &Machine, id: &str, message_id: &str) -> Result<Delivery> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        owned(&tx, machine, id)?;
        let seq = message_seq(&tx, message_id)?;
        if tx.execute("UPDATE deliveries SET acknowledged_at=COALESCE(acknowledged_at,?1) WHERE message_seq=?2 AND recipient=?3",
            params![now(),seq,id])?==0 { return Err(BoardError::forbidden()); }
        let result = message(&tx, seq)?
            .deliveries
            .into_iter()
            .find(|d| d.recipient == id)
            .unwrap();
        tx.commit()?;
        Ok(result)
    }
}

fn participant_row(row: &rusqlite::Row) -> rusqlite::Result<Participant> {
    let terminal: Option<String> = row.get(6)?;
    let terminal = terminal
        .map(|text| {
            serde_json::from_str(&text).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .transpose()?;
    Ok(Participant {
        cursor: row.get(0)?,
        id: row.get(1)?,
        machine_id: row.get(2)?,
        machine_name: row.get(3)?,
        name: row.get(4)?,
        project: row.get(5)?,
        terminal,
        active: row.get(7)?,
        created_at: row.get(8)?,
    })
}
fn participant(conn: &Connection, id: &str) -> Result<Participant> {
    conn.query_row("SELECT seq,id,machine_id,machine_name,name,project,terminal,active,created_at FROM participants WHERE id=?1",
        [id], participant_row).optional()?.ok_or_else(BoardError::missing)
}
fn owned(conn: &Connection, machine: &Machine, id: &str) -> Result<Participant> {
    let result = participant(conn, id)?;
    if result.machine_id != machine.id {
        return Err(BoardError::forbidden());
    }
    Ok(result)
}
fn active_recipient(conn: &Connection, recipient: &Participant) -> Result<()> {
    if !recipient.active {
        return Err(BoardError::conflict("Recipient is retired"));
    }
    let configured = conn
        .query_row(
            "SELECT 1 FROM machines WHERE id=?1 AND active=1",
            [&recipient.machine_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !configured {
        return Err(BoardError::conflict(
            "Recipient computer is no longer in this board",
        ));
    }
    Ok(())
}
fn resolve(conn: &Connection, address: &str, project: &str) -> Result<Participant> {
    match participant(conn, address) {
        Ok(result) => {
            active_recipient(conn, &result)?;
            return Ok(result);
        },
        Err(error) if error.0 == StatusCode::NOT_FOUND => {},
        Err(error) => return Err(error),
    }
    label(address, "Recipient")?;
    let mut query = conn.prepare("SELECT p.id FROM participants p JOIN machines c ON c.id=p.machine_id WHERE p.active=1 AND c.active=1 AND p.name=?1 AND p.project=?2 ORDER BY p.seq LIMIT 257")?;
    let ids = query
        .query_map(params![address, project], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.len() > 1 {
        let candidates = ids
            .iter()
            .take(10)
            .map(|id| participant(conn, id).map(|p| format!("{} · {}", p.id, p.machine_name)))
            .collect::<Result<Vec<_>>>()?
            .join(", ");
        return Err(BoardError::conflict(format!(
            "Ambiguous recipient; use a session ID: {candidates}"
        )));
    }
    ids.first()
        .map(|id| participant(conn, id))
        .unwrap_or_else(|| Err(BoardError::missing()))
}
fn message_seq(conn: &Connection, id: &str) -> Result<u64> {
    conn.query_row("SELECT seq FROM messages WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(BoardError::missing)
}
fn message(conn: &Connection, seq: u64) -> Result<Message> {
    let mut result = conn.query_row("SELECT seq,id,sender,sender_name,sender_machine_id,sender_machine_name,project,thread_id,reply_to,body,created_at
        FROM messages WHERE seq=?1", [seq], |r| Ok(Message { cursor:r.get(0)?,id:r.get(1)?,sender:r.get(2)?,sender_name:r.get(3)?,
            sender_machine_id:r.get(4)?,sender_machine_name:r.get(5)?,project:r.get(6)?,thread_id:r.get(7)?,reply_to:r.get(8)?,
            body:r.get(9)?,created_at:r.get(10)?,deliveries:vec![] })).optional()?.ok_or_else(BoardError::missing)?;
    let mut query = conn.prepare("SELECT recipient,name,machine_id,machine_name,acknowledged_at,'agent' FROM deliveries WHERE message_seq=?1 UNION ALL SELECT recipient,name,machine_id,machine_name,acknowledged_at,'computer' FROM machine_deliveries WHERE message_seq=?1 ORDER BY recipient")?;
    result.deliveries = query
        .query_map([seq], |r| {
            Ok(Delivery {
                recipient_kind: r.get(5)?,
                recipient: r.get(0)?,
                name: r.get(1)?,
                machine_id: r.get(2)?,
                machine_name: r.get(3)?,
                acknowledged_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}
fn message_page(conn: &Connection, mut ids: Vec<u64>, limit: u16) -> Result<Page<Message>> {
    let next_cursor = if ids.len() > limit as usize {
        ids.pop();
        ids.last().copied()
    } else {
        None
    };
    let items = ids
        .into_iter()
        .map(|id| message(conn, id))
        .collect::<Result<Vec<_>>>()?;
    Ok(Page { items, next_cursor })
}
