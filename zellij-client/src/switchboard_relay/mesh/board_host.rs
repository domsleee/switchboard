//! Explicit initial board placement. Membership authority and storage location are separate.
use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Choice {
    group_id: String,
    host_id: String,
    selector_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Selection {
    request: Signed<Choice>,
    approval: Signed<Choice>,
}
impl Selection {
    fn validate(&self, membership: &Membership) -> anyhow::Result<()> {
        let choice = &self.request.value;
        anyhow::ensure!(
            choice == &self.approval.value && choice.group_id == membership.id,
            "Board selection belongs to a different group"
        );
        let selector = membership
            .members
            .get(&choice.selector_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown board selector"))?;
        let host = membership
            .members
            .get(&choice.host_id)
            .ok_or_else(|| anyhow::anyhow!("Board host must be paired"))?;
        verify(&self.request, selector)?;
        verify(&self.approval, host)?;
        Ok(())
    }
}
impl Mesh {
    pub(super) fn board_database(&self, group: &str) -> PathBuf {
        self.storage
            .root
            .join(format!("board-{}.sqlite3", hash(group.as_bytes())))
    }
    fn legacy_board(&self, db: &Database) -> bool {
        db.board_hosts.is_empty()
            && db
                .membership
                .as_ref()
                .is_some_and(|m| self.board_database(&m.value.id).exists())
    }
    pub(super) fn board_host_id<'a>(db: &'a Database) -> Option<&'a str> {
        if db.board_hosts.len() == 1 {
            Some(&db.board_hosts[0].request.value.host_id)
        } else {
            None
        }
    }
    pub(super) fn board_host_status(&self, db: &Database) -> Value {
        let host_id = Self::board_host_id(db);
        let membership = db.membership.as_ref().map(|m| &m.value);
        let host = membership.and_then(|m| host_id.and_then(|id| m.members.get(id)));
        let legacy = self.legacy_board(db);
        let state = if legacy {
            "legacy_database"
        } else if db.board_hosts.len() > 1 {
            "conflict"
        } else if host.is_some() {
            "selected"
        } else {
            "unconfigured"
        };
        let candidates = membership
            .map(|m| {
                m.members
                    .values()
                    .map(|member| json!({"id":member.id,"name":member.name}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        json!({"state":state,"host_id":host_id,"host_name":host.map(|m|&m.name),"can_select":membership.is_some() && db.board_hosts.is_empty() && !legacy,"candidates":candidates})
    }
    pub(super) fn merge_board_hosts(
        &self,
        db: &mut Database,
        incoming: &[Selection],
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(incoming.len() <= 2, "Too many board selections");
        if incoming.is_empty() {
            return Ok(false);
        }
        let membership = &db
            .membership
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Group unavailable"))?
            .value;
        for selection in incoming {
            selection.validate(membership)?;
        }
        anyhow::ensure!(
            !self.legacy_board(db),
            "Existing board database requires migration; initial host selection is blocked"
        );
        let before = db.board_hosts.len();
        let mut choices = BTreeMap::new();
        for selection in db.board_hosts.iter().chain(incoming) {
            choices
                .entry(selection.request.value.host_id.clone())
                .or_insert_with(|| selection.clone());
        }
        // Keep two signed choices as durable conflict evidence. Never use last-writer-wins.
        db.board_hosts = choices.into_values().take(2).collect();
        Ok(db.board_hosts.len() != before)
    }
    pub(super) async fn approve_board_host(
        &self,
        request: Signed<Choice>,
    ) -> anyhow::Result<Selection> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let local = db
            .local
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Computer unavailable"))?;
        let membership = &db
            .membership
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Group unavailable"))?
            .value;
        anyhow::ensure!(
            request.value.group_id == membership.id
                && request.value.host_id == local.id
                && membership.members.get(&local.id) == Some(local),
            "Board approval belongs to another computer or group"
        );
        let selector = membership
            .members
            .get(&request.value.selector_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown board selector"))?;
        verify(&request, selector)?;
        if let Some(existing) = db.board_hosts.first() {
            anyhow::ensure!(
                db.board_hosts.len() == 1 && existing.request.value.host_id == local.id,
                "Board host is already selected; migration is unsupported"
            );
            return Ok(existing.clone());
        }
        anyhow::ensure!(
            !self.legacy_board(&db),
            "Existing board database requires migration; initial host selection is blocked"
        );
        let selection = Selection {
            approval: self.identity.sign(request.value.clone())?,
            request,
        };
        self.merge_board_hosts(&mut db, &[selection.clone()])?;
        self.save(&db)?;
        *committed = db;
        Ok(selection)
    }
    pub(super) async fn select_board_host(&self, host_id: &str) -> anyhow::Result<Value> {
        let (request, host, local_id) = {
            let db = self.database.lock().await;
            let local = db
                .local
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Pair computers before selecting a board host"))?;
            let membership = &db
                .membership
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Pair computers before selecting a board host"))?
                .value;
            if !db.board_hosts.is_empty() {
                anyhow::ensure!(
                    Self::board_host_id(&db) == Some(host_id),
                    "Board host is already selected or conflicting; migration is unsupported"
                );
                return Ok(self.board_host_status(&db));
            }
            anyhow::ensure!(
                !self.legacy_board(&db),
                "Existing board database requires migration; initial host selection is blocked"
            );
            let host = membership
                .members
                .get(host_id)
                .ok_or_else(|| anyhow::anyhow!("Board host must be a paired computer"))?
                .clone();
            let request = self.identity.sign(Choice {
                group_id: membership.id.clone(),
                host_id: host.id.clone(),
                selector_id: local.id.clone(),
            })?;
            (request, host, local.id.clone())
        };
        let selection = if host.id == local_id {
            self.approve_board_host(request).await?
        } else {
            tokio::time::timeout(
                Duration::from_secs(5),
                self.remote::<_, Selection>(&host, "/mesh/board-host/approve", &request),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!("Board host did not approve in time; retry the same computer")
            })?
            .map_err(|_| anyhow::anyhow!("Selected computer could not approve this initial board host. Check connectivity, relay version, existing selection and database migration."))?
        };
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        self.merge_board_hosts(&mut db, &[selection])?;
        self.save(&db)?;
        *committed = db;
        anyhow::ensure!(
            Self::board_host_id(&committed) == Some(host_id),
            "Conflicting board selections; the board is blocked to prevent a fork"
        );
        Ok(self.board_host_status(&committed))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Select {
    host_id: String,
}
pub(super) async fn status(State(state): State<RelayState>) -> Response {
    let Some(mesh) = state.mesh else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Pair computers before selecting a board host"})),
        )
            .into_response();
    };
    let db = mesh.database.lock().await;
    Json(mesh.board_host_status(&db)).into_response()
}
pub(super) async fn select(State(state): State<RelayState>, Json(input): Json<Select>) -> Response {
    let Some(mesh) = state.mesh else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Pair computers before selecting a board host"})),
        )
            .into_response();
    };
    match mesh.select_board_host(&input.host_id).await {
        Ok(value) => {
            mesh.synchronize().await;
            Json(value).into_response()
        },
        Err(error) => (
            StatusCode::CONFLICT,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}
pub(super) async fn approve(State(mesh): State<Arc<Mesh>>, request: Request) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let body = match to_bytes(request.into_body(), 16 * 1024).await {
        Ok(body) => body,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let request: Signed<Choice> = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    match mesh.approve_board_host(request).await {
        Ok(selection)=>Json(selection).into_response(),
        Err(_)=>(StatusCode::CONFLICT,Json(json!({"error":"Board host approval rejected; check pairing, existing selection and database migration"}))).into_response(),
    }
}
