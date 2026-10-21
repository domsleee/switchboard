//! Exchange signed group membership and recipient-encrypted credentials directly
//! between trusted computers. Every member can invite; no central server is needed.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Update {
    #[serde(default)]
    board_hosts: Vec<board_host::Selection>,
    #[serde(default)]
    categories: BTreeMap<String, Category>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tab_order: Option<TabOrder>,
    membership: Signed<Membership>,
    credential: Envelope,
    /// The sender's network name, trusted only from a reply over its pinned TLS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
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
            categories: db.categories.clone(),
            tab_order: db.tab_order.clone(),
            // Keep the inviter's signature: an existing peer may not know this
            // newly joined computer yet, but already trusts its inviter.
            membership: membership.clone(),
            credential: self.identity.seal(local, member, 1, &db.outgoing[peer])?,
            hostname: None,
        })
    }

    pub(super) async fn prepare_sync(&self, peer: &str) -> anyhow::Result<Update> {
        let system_hostname = hostname::system().await;
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let mut update = self.sync_payload(&mut db, peer)?;
        update.hostname = system_hostname;
        if db.outgoing.len() != committed.outgoing.len() {
            self.save(&db)?;
            *committed = db;
        }
        Ok(update)
    }

    pub(super) async fn exchange(&self, update: Update) -> anyhow::Result<Update> {
        let system_hostname = hostname::system().await;
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
        let categories_changed = Self::merge_categories(&mut db, &update.categories);
        let order_changed = Self::merge_tab_order(&mut db, update.tab_order.as_ref());
        let mut response = self.sync_payload(&mut db, peer)?;
        response.hostname = system_hostname;
        if changed
            || board_changed
            || categories_changed
            || order_changed
            || credential_changed
            || db.outgoing.len() != committed.outgoing.len()
        {
            self.save(&db)?;
            *committed = db;
        }
        Ok(response)
    }

    /// Persist routing hints. An address is learned only after the peer's pinned TLS
    /// handshake succeeded there, so an unauthenticated DNS answer never sticks.
    pub(super) async fn learn_route(
        &self,
        peer: &str,
        name: Option<&str>,
        address: Option<SocketAddr>,
    ) -> anyhow::Result<()> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        if let Some(name) = name.and_then(hostname::local_hostname) {
            db.hostnames.insert(peer.to_owned(), name);
        }
        if let Some(address) = address {
            db.addresses.insert(peer.to_owned(), address);
        }
        if db.hostnames != committed.hostnames || db.addresses != committed.addresses {
            self.save(&db)?;
            *committed = db;
        }
        Ok(())
    }

    async fn learn_routes(&self) {
        let clients: Vec<_> = self
            .peer_clients
            .read()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for host in self.hosts().into_iter().chain(clients) {
            let route = *host.route_hint.lock().await;
            if let Some((address, _)) =
                route.filter(|(address, _)| host.config.address != Some(*address))
            {
                let id = host
                    .config
                    .id
                    .strip_prefix("mesh-")
                    .unwrap_or(&host.config.id);
                let _ = self.learn_route(id, None, Some(address)).await;
            }
        }
    }

    pub(super) async fn synchronize(&self) {
        self.learn_routes().await;
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
                let name = response.hostname.clone();
                self.exchange(response).await?;
                self.learn_route(&peer.id, name.as_deref(), None).await?;
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

/// A computer's sidebar category, the same on every computer in the group.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Category {
    pub(super) name: String,
    updated: u64,
}

fn valid_category(name: &str) -> bool {
    matches!(name, "" | "work" | "home")
}

impl Mesh {
    /// The latest change wins; a tie keeps the larger name, so every computer agrees.
    pub(super) fn merge_categories(
        db: &mut Database,
        incoming: &BTreeMap<String, Category>,
    ) -> bool {
        let Some(membership) = &db.membership else {
            return false;
        };
        let mut changed = false;
        for (id, category) in incoming {
            if !membership.value.members.contains_key(id) || !valid_category(&category.name) {
                continue;
            }
            if db
                .categories
                .get(id)
                .is_none_or(|old| (category.updated, &category.name) > (old.updated, &old.name))
            {
                db.categories.insert(id.clone(), category.clone());
                changed = true;
            }
        }
        changed
    }

    pub(super) async fn set_category(&self, member: &str, name: &str) -> anyhow::Result<()> {
        anyhow::ensure!(valid_category(name), "Use work, home or no category");
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        anyhow::ensure!(
            db.membership
                .as_ref()
                .is_some_and(|m| m.value.members.contains_key(member)),
            "Unknown computer"
        );
        // Newer than the change it replaces, even one stamped by a computer whose clock runs ahead.
        let updated = now().max(db.categories.get(member).map_or(0, |c| c.updated + 1));
        db.categories.insert(
            member.to_owned(),
            Category {
                name: name.to_owned(),
                updated,
            },
        );
        self.save(&db)?;
        *committed = db;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SetCategory {
    member_id: String,
    name: String,
}
pub(super) async fn category(
    State(state): State<RelayState>,
    Json(input): Json<SetCategory>,
) -> Response {
    let Some(mesh) = state.mesh else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Pair computers before sharing categories"})),
        )
            .into_response();
    };
    match mesh.set_category(&input.member_id, &input.name).await {
        Ok(()) => {
            tokio::spawn(async move { mesh.synchronize().await });
            StatusCode::NO_CONTENT.into_response()
        },
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}

/// The sidebar's manual tab order, the same in every browser on every computer in the group.
/// Keys name a tab by its computer's group member ID, so they mean the same tab everywhere.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct TabOrder {
    keys: Vec<String>,
    updated: u64,
}

fn valid_tab_order(keys: &[String]) -> bool {
    keys.len() <= 2000 && keys.iter().all(|key| key.len() <= 512)
}

impl Mesh {
    /// The latest change wins; a tie keeps the larger order, so every computer agrees.
    pub(super) fn merge_tab_order(db: &mut Database, incoming: Option<&TabOrder>) -> bool {
        let Some(order) = incoming.filter(|order| valid_tab_order(&order.keys)) else {
            return false;
        };
        if db.membership.is_none()
            || db
                .tab_order
                .as_ref()
                .is_some_and(|old| (old.updated, &old.keys) >= (order.updated, &order.keys))
        {
            return false;
        }
        db.tab_order = Some(order.clone());
        true
    }

    pub(super) async fn set_tab_order(&self, keys: Vec<String>) -> anyhow::Result<u64> {
        anyhow::ensure!(valid_tab_order(&keys), "Too many tabs to share their order");
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        anyhow::ensure!(db.membership.is_some(), "Group unavailable");
        let updated = now().max(db.tab_order.as_ref().map_or(0, |o| o.updated + 1));
        db.tab_order = Some(TabOrder { keys, updated });
        self.save(&db)?;
        *committed = db;
        Ok(updated)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SetTabOrder {
    keys: Vec<String>,
}
pub(super) async fn tab_order(
    State(state): State<RelayState>,
    Json(input): Json<SetTabOrder>,
) -> Response {
    let Some(mesh) = state.mesh else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Pair computers before sharing tab order"})),
        )
            .into_response();
    };
    match mesh.set_tab_order(input.keys).await {
        Ok(updated) => {
            tokio::spawn(async move { mesh.synchronize().await });
            Json(json!({ "updated": updated })).into_response()
        },
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
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
