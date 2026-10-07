//! An explicitly selected computer owns the durable board. Existing paired
//! gateway credentials authenticate callers; a disconnected host never forks it.
use super::*;

const LOCAL_PREFIX: &str = "/api/message-board/";
const PEER_PREFIX: &str = "/mesh/board/";
const BODY_LIMIT: usize = 64 * 1024 * 6 + 16 * 1024;

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"The selected message board computer is unavailable. Connect to that computer; no local fallback board is started."}))).into_response()
}

async fn bounded(request: Request) -> Result<Request, Response> {
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Message board request is too large",
        )
            .into_response()
    })?;
    Ok(Request::from_parts(parts, Body::from(body)))
}

impl Mesh {
    pub(in crate::switchboard_relay) async fn board(&self, request: Request) -> Response {
        let request = match bounded(request).await {
            Ok(request) => request,
            Err(response) => return response,
        };
        let host = {
            let db = self.database.lock().await;
            let (Some(local), Some(membership)) = (&db.local, &db.membership) else {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"configured":false,"error":"Pair your computers to use their shared message board."}))).into_response();
            };
            if membership.value.members.get(&local.id) != Some(local) {
                return unavailable();
            }
            let Some(board_host) = Self::board_host_id(&db) else {
                let status = self.board_host_status(&db);
                let error = match status["state"].as_str() {
                    Some("legacy_database") => {
                        "An existing board database requires migration before selecting a host."
                    },
                    Some("conflict") => {
                        "Conflicting board host selections; the board is blocked to prevent a fork."
                    },
                    _ => "Select the initial shared message board computer in Computers.",
                };
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"configured":false,"board_host":status,"error":error})),
                )
                    .into_response();
            };
            if board_host == local.id {
                drop(db);
                return self.hosted_board(request, None).await;
            }
            if !membership.value.members.contains_key(board_host) {
                return unavailable();
            }
            self.host(&format!("mesh-{board_host}"))
        };
        let Some(host) = host else {
            return unavailable();
        };
        let (parts, body) = request.into_parts();
        let Some(suffix) = parts
            .uri
            .path_and_query()
            .and_then(|p| p.as_str().strip_prefix(LOCAL_PREFIX))
        else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let path = format!("{PEER_PREFIX}{suffix}");
        let content_type = parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json");
        let body = match to_bytes(body, BODY_LIMIT).await {
            Ok(body) => body,
            Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        };
        match tokio::time::timeout(
            Duration::from_secs(5),
            host.raw_request(parts.method, &path, body, content_type, None),
        )
        .await
        {
            Ok(Ok(upstream)) => {
                let mut response = (upstream.status, upstream.body).into_response();
                if let Some(content_type) = upstream.headers.get(header::CONTENT_TYPE) {
                    response
                        .headers_mut()
                        .insert(header::CONTENT_TYPE, content_type.clone());
                }
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                response
            },
            _ => unavailable(),
        }
    }

    async fn hosted_board(&self, mut request: Request, authorization: Option<&str>) -> Response {
        // Hold the membership lock through dispatch so a credential cannot be
        // revoked between checking the caller and committing its board mutation.
        let db = self.database.lock().await;
        let (Some(local), Some(signed)) = (&db.local, &db.membership) else {
            return unavailable();
        };
        let membership = &signed.value;
        if Self::board_host_id(&db) != Some(local.id.as_str())
            || membership.members.get(&local.id) != Some(local)
        {
            return unavailable();
        }
        let caller = match authorization {
            None => Some(local),
            Some(authorization) => authorization.strip_prefix("Bearer ").and_then(|bearer| {
                db.outgoing.iter().find_map(|(id, credential)| {
                    if crypto::same(bearer, &credential.gateway) {
                        membership.members.get(id)
                    } else {
                        None
                    }
                })
            }),
        };
        let Some(caller) = caller else {
            return (StatusCode::UNAUTHORIZED, "Peer authorization required").into_response();
        };
        let machines = membership
            .members
            .values()
            .map(|m| (m.id.clone(), m.name.clone()))
            .collect();
        let database = self.board_database(&membership.id);
        // This request is entering a separate router. Its gateway/relay wildcard
        // parameters must not be combined with the board's resource parameters.
        request.extensions_mut().clear();
        crate::message_board::dispatch(
            database,
            (caller.id.clone(), caller.name.clone()),
            machines,
            request,
        )
        .await
    }
}

pub(super) async fn peer_board(State(mesh): State<Arc<Mesh>>, request: Request) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .count()
        != 1
    {
        return (StatusCode::UNAUTHORIZED, "Peer authorization required").into_response();
    }
    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if mesh.authorized(&authorization).await.is_none() {
        return (StatusCode::UNAUTHORIZED, "Peer authorization required").into_response();
    }
    let mut request = match bounded(request).await {
        Ok(request) => request,
        Err(response) => return response,
    };
    let Some(suffix) = request
        .uri()
        .path_and_query()
        .and_then(|p| p.as_str().strip_prefix(PEER_PREFIX))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let uri = format!("{LOCAL_PREFIX}{suffix}").parse().unwrap();
    *request.uri_mut() = uri;
    mesh.hosted_board(request, Some(&authorization)).await
}
