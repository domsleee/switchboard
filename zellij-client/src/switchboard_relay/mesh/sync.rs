//! Exchange signed group membership and recipient-encrypted credentials directly
//! between trusted computers. Every member can invite; no central server is needed.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Update {
    #[serde(default)]
    board_hosts: Vec<board_host::Selection>,
    membership: Signed<Membership>,
    credential: Envelope,
}

pub(super) async fn exchange(
    State(mesh): State<Arc<Mesh>>,
    Json(update): Json<Update>,
) -> Result<Json<Update>, Error> {
    mesh.exchange(update).await.map(Json).map_err(|_| {
        (
            StatusCode::FORBIDDEN,
            "Group identity or credential verification failed",
        )
    })
}

impl Mesh {
    fn sync_payload(&self, db: &mut Database, peer: &str) -> anyhow::Result<Update> {
        let local = db
            .local
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Computer unavailable"))?;
        let membership = db
            .membership
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Group unavailable"))?;
        let member = membership
            .value
            .members
            .get(peer)
            .ok_or_else(|| anyhow::anyhow!("Unknown computer"))?;
        anyhow::ensure!(member.id != local.id, "Cannot sync with this computer");
        if !db.outgoing.contains_key(peer) {
            db.outgoing.insert(
                peer.to_owned(),
                Credential {
                    terminal: self.issuer.issue(peer)?,
                    gateway: secret(),
                },
            );
        }
        Ok(Update {
            board_hosts: db.board_hosts.clone(),
            // Keep the inviter's signature: an existing peer may not know this
            // newly joined computer yet, but already trusts its inviter.
            membership: membership.clone(),
            credential: self.identity.seal(local, member, 1, &db.outgoing[peer])?,
        })
    }

    pub(super) async fn prepare_sync(&self, peer: &str) -> anyhow::Result<Update> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let update = self.sync_payload(&mut db, peer)?;
        if db.outgoing.len() != committed.outgoing.len() {
            self.save(&db)?;
            *committed = db;
        }
        Ok(update)
    }

    pub(super) async fn exchange(&self, update: Update) -> anyhow::Result<Update> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let current = &db
            .membership
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Group unavailable"))?
            .value;
        let next = &update.membership.value;
        let local = db
            .local
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Computer unavailable"))?;
        anyhow::ensure!(
            next.id == current.id
                && next.name == current.name
                && next.administrator == current.administrator
                && next.members.get(&local.id) == Some(local),
            "Unrelated group or changed local identity"
        );
        anyhow::ensure!(
            current
                .members
                .values()
                .any(|member| verify(&update.membership, member).is_ok()),
            "Membership was not signed by a trusted computer"
        );
        let mut merged = current.clone();
        for (id, member) in &next.members {
            member.validate()?;
            anyhow::ensure!(id == &member.id, "Member identity key mismatch");
            if let Some(existing) = merged.members.get(id) {
                anyhow::ensure!(existing == member, "Conflicting computer identity");
            } else {
                anyhow::ensure!(
                    !merged
                        .members
                        .values()
                        .any(|m| m.name.eq_ignore_ascii_case(&member.name)),
                    "Duplicate computer name"
                );
                merged.members.insert(id.clone(), member.clone());
            }
        }
        // A stale snapshot can add a concurrently approved computer, but cannot
        // discard computers learned from another peer or roll back credentials.
        let changed = merged.members.len() != current.members.len();
        if changed {
            merged.version = current
                .version
                .max(next.version)
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Group version exhausted"))?;
        }
        let peer = &update.credential.header.issuer;
        let issuer = merged
            .members
            .get(peer)
            .ok_or_else(|| anyhow::anyhow!("Unknown credential issuer"))?;
        anyhow::ensure!(peer != &local.id, "Cannot sync with this computer");
        let credential = self.identity.open(issuer, local, &update.credential)?;
        let credential_changed = db
            .incoming
            .get(peer)
            .is_none_or(|old| old.version != update.credential.header.version);
        Self::install_credential(&mut db, &update.credential, credential)?;
        if changed {
            db.membership = Some(self.identity.sign(merged)?);
        }
        let board_changed = self.merge_board_hosts(&mut db, &update.board_hosts)?;
        let response = self.sync_payload(&mut db, peer)?;
        if changed
            || board_changed
            || credential_changed
            || db.outgoing.len() != committed.outgoing.len()
        {
            self.save(&db)?;
            *committed = db;
        }
        Ok(response)
    }

    pub(super) async fn synchronize(&self) {
        let peers = {
            let db = self.database.lock().await;
            match (&db.membership, &db.local) {
                (Some(membership), Some(local)) => membership
                    .value
                    .members
                    .values()
                    .filter(|m| m.id != local.id)
                    .cloned()
                    .collect::<Vec<_>>(),
                _ => return,
            }
        };
        // One offline computer must not delay updates from every other computer.
        let now = std::time::Instant::now();
        let peers = peers
            .into_iter()
            .filter(|peer| self.sync_backoff.ready(&peer.id, now));
        futures_util::future::join_all(peers.map(|peer| async move {
            let result = async {
                let update = self.prepare_sync(&peer.id).await?;
                let response: Update = self.remote(&peer, "/mesh/sync", &update).await?;
                self.exchange(response).await?;
                Ok::<_, anyhow::Error>(())
            };
            let result = tokio::time::timeout(Duration::from_secs(5), result).await;
            let now = std::time::Instant::now();
            self.sync_backoff
                .record(&peer.id, matches!(result, Ok(Ok(()))), now);
            match result {
                Ok(Ok(())) => {},
                Ok(Err(error)) => logs::record(
                    &peer.name,
                    &format!("Group sync failed: {error:#}; will retry"),
                ),
                Err(_) => logs::record(&peer.name, "Group sync timed out; will retry"),
            }
        }))
        .await;
    }
}

/// Per-computer retry delay, so an offline computer is not contacted every
/// sync tick. The first failures retry at once: enrollment converges through them.
#[derive(Default)]
pub(super) struct Backoff(std::sync::Mutex<BTreeMap<String, (u32, std::time::Instant)>>);

impl Backoff {
    const FREE_FAILURES: u32 = 3;
    const MAX_DELAY: Duration = Duration::from_secs(60);

    pub(super) fn ready(&self, peer: &str, now: std::time::Instant) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(peer)
            .is_none_or(|(_, next)| now >= *next)
    }

    pub(super) fn record(&self, peer: &str, succeeded: bool, now: std::time::Instant) {
        let mut peers = self.0.lock().unwrap();
        if succeeded {
            peers.remove(peer);
            return;
        }
        let failures = peers.get(peer).map_or(0, |(failures, _)| *failures) + 1;
        let doublings = failures.saturating_sub(Self::FREE_FAILURES).min(5);
        let delay = if failures < Self::FREE_FAILURES {
            Duration::ZERO
        } else {
            (Duration::from_secs(3) * 2u32.pow(doublings)).min(Self::MAX_DELAY)
        };
        peers.insert(peer.to_owned(), (failures, now + delay));
    }
}

#[cfg(test)]
mod backoff_tests {
    use super::*;

    #[test]
    fn offline_computer_backs_off_and_recovers_on_success() {
        let backoff = Backoff::default();
        let start = std::time::Instant::now();
        for _ in 0..2 {
            backoff.record("peer", false, start);
            assert!(backoff.ready("peer", start), "early failures retry at once");
        }
        let delays: Vec<_> = (0..6)
            .map(|_| {
                backoff.record("peer", false, start);
                assert!(!backoff.ready("peer", start));
                let next = backoff.0.lock().unwrap()["peer"].1;
                next - start
            })
            .collect();
        let secs: Vec<_> = delays.iter().map(Duration::as_secs).collect();
        assert_eq!(secs, [3, 6, 12, 24, 48, 60]);
        assert!(backoff.ready("other", start));
        backoff.record("peer", true, start);
        assert!(backoff.ready("peer", start));
    }
}
