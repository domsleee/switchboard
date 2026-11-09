use crate::web_client::authentication::{IsReadOnly, SessionTokenHash};
use crate::web_client::control_message::SetConfigPayload;
use crate::web_client::types::{
    record_pending_welcome_session, AppState, BuildInfo, CreateClientIdResponse, LoginRequest,
    LoginResponse, SessionListResponse, SessionQuery,
};
use crate::web_client::utils::get_mime_type;
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use axum_extra::extract::cookie::{Cookie, SameSite};
use include_dir;
use uuid::Uuid;
use zellij_utils::{
    consts::VERSION, sessions::generate_unique_session_name,
    web_authentication_tokens::create_session_token,
};

const ASSETS_DIR: include_dir::Dir<'_> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/assets");

pub async fn serve_html() -> impl IntoResponse {
    match ASSETS_DIR.get_file("index.html") {
        Some(file) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            file.contents(),
        ),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "text/plain")],
            "index.html missing".as_bytes(),
        ),
    }
}

pub async fn login_handler(
    State(state): State<AppState>,
    Json(login_request): Json<LoginRequest>,
) -> impl IntoResponse {
    match create_session_token(
        &login_request.auth_token,
        login_request.remember_me.unwrap_or(false),
    ) {
        Ok(session_token) => {
            let is_https = state.is_https;
            let cookie = if login_request.remember_me.unwrap_or(false) {
                // Persistent cookie for remember_me
                Cookie::build(("session_token", session_token))
                    .http_only(true)
                    .secure(is_https)
                    .same_site(SameSite::Strict)
                    .path("/")
                    .max_age(time::Duration::weeks(4))
                    .build()
            } else {
                // Session cookie - NO max_age means it expires when browser closes/refreshes
                Cookie::build(("session_token", session_token))
                    .http_only(true)
                    .secure(is_https)
                    .same_site(SameSite::Strict)
                    .path("/")
                    .build()
            };

            let mut response = Json(LoginResponse {
                success: true,
                message: "Login successful".to_string(),
            })
            .into_response();

            if let Ok(cookie_header) = axum::http::HeaderValue::from_str(&cookie.to_string()) {
                response.headers_mut().insert("set-cookie", cookie_header);
            }

            response
        },
        Err(_) => (
            StatusCode::UNAUTHORIZED,
            Json(LoginResponse {
                success: false,
                message: "Invalid authentication token".to_string(),
            }),
        )
            .into_response(),
    }
}

pub async fn create_new_client(
    State(state): State<AppState>,
    Query(params): Query<SessionQuery>,
    request: axum::extract::Request,
) -> Result<Json<CreateClientIdResponse>, (StatusCode, impl IntoResponse)> {
    // Extract is_read_only from request extensions (set by auth middleware)
    let is_read_only = request
        .extensions()
        .get::<IsReadOnly>()
        .copied()
        .unwrap_or(IsReadOnly(true))
        .0;
    let session_token_hash = request
        .extensions()
        .get::<SessionTokenHash>()
        .cloned()
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json("Missing session info".to_string()),
        ))?;

    let requested_session = params.session.filter(|name| !name.is_empty());
    let may_create_session = requested_session.is_none();
    let session_name = match requested_session {
        Some(session_name) => session_name,
        None => {
            let generated = generate_unique_session_name().ok_or((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json("Failed to generate unique session name".to_string()),
            ))?;
            if params.welcome.unwrap_or(true) {
                record_pending_welcome_session(&state.pending_welcome_sessions, &generated);
            }
            generated
        },
    };

    // A named URL is a viewer of an existing session. Old pages can reload long
    // after the last tab closes; they must not turn that reload into a new shell.
    if !may_create_session && !zellij_utils::handoff::in_progress(&session_name) {
        let manager = state.session_manager.clone();
        let target = session_name.clone();
        let exists =
            tokio::task::spawn_blocking(move || manager.session_exists(&target).map_err(|_| ()))
                .await
                .unwrap_or(Err(()))
                .map_err(|_| {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json("Cannot query session".to_string()),
                    )
                })?;
        if !exists {
            return Err((
                StatusCode::GONE,
                Json("Terminal session has ended".to_string()),
            ));
        }
    }

    if params.resumable {
        let token = super::utils::parse_cookies(&request)
            .remove("session_token")
            .unwrap_or_default();
        return super::attachment::bootstrap(
            state,
            token,
            is_read_only,
            session_name,
            may_create_session,
        )
        .await
        .map(Json)
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, Json(error.to_string())));
    }

    let web_client_id = String::from(Uuid::new_v4());
    let os_input = state
        .client_os_api_factory
        .create_client_os_api()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(e.to_string())))?;

    {
        let mut table = state.connection_table.lock().unwrap();
        table.add_new_client(
            web_client_id.to_owned(),
            os_input,
            is_read_only,
            session_token_hash.0,
        );
        table
            .client_id_to_channels
            .get_mut(&web_client_id)
            .unwrap()
            .may_create_session = may_create_session;
    }

    let config = SetConfigPayload::from(&*state.config.lock().unwrap());

    Ok(Json(CreateClientIdResponse {
        resumable: None,
        web_client_id,
        is_read_only,
        session_name,
        config,
    }))
}

pub async fn list_sessions_handler(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> Json<SessionListResponse> {
    let mut sessions = state.session_manager.list_sessions();
    let is_read_only = request
        .extensions()
        .get::<IsReadOnly>()
        .copied()
        .unwrap_or(IsReadOnly(true))
        .0;
    if let Some(recovery) = state.sharing_recovery.as_ref() {
        for session in &mut sessions {
            if !session.web_clients_allowed && recovery.catalog_allowed(&session.name, is_read_only)
            {
                session.web_clients_allowed = true;
                session.sharing_recovery = true;
            }
        }
    }
    sessions.sort_by(|a, b| a.name.cmp(&b.name));
    Json(SessionListResponse {
        sessions,
        build: BuildInfo {
            commit: env!("SWITCHBOARD_COMMIT").into(),
            commit_date: env!("SWITCHBOARD_COMMIT_DATE").into(),
            commit_timestamp: env!("SWITCHBOARD_COMMIT_TIMESTAMP").into(),
        },
    })
}

pub async fn get_static_asset(AxumPath(path): AxumPath<String>) -> impl IntoResponse {
    let path = path.trim_start_matches('/');

    match ASSETS_DIR.get_file(path) {
        None => (
            [(header::CONTENT_TYPE, "text/html")],
            "Not Found".as_bytes(),
        ),
        Some(file) => {
            let ext = file.path().extension().and_then(|ext| ext.to_str());
            let mime_type = get_mime_type(ext);
            ([(header::CONTENT_TYPE, mime_type)], file.contents())
        },
    }
}

pub async fn version_handler() -> &'static str {
    VERSION
}

pub const PASTE_IMAGE_LIMIT: usize = 16 * 1024 * 1024;
const PASTE_IMAGE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

// Browser clipboard images are saved on this host so terminal apps can open the pasted path.
pub async fn paste_image_handler(
    axum::Extension(IsReadOnly(is_read_only)): axum::Extension<IsReadOnly>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if is_read_only {
        return Err(StatusCode::FORBIDDEN);
    }
    let extension = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/gif") => "gif",
        Some("image/webp") => "webp",
        _ => return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE),
    };
    if body.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let directory = zellij_utils::consts::ZELLIJ_CACHE_DIR.join("pasted-images");
    let path = tokio::task::spawn_blocking(move || save_pasted_image(&directory, extension, &body))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|error| {
            log::error!("Failed to save pasted image: {}", error);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(Json(serde_json::json!({ "path": path.to_string_lossy() })))
}

pub fn save_pasted_image(
    directory: &std::path::Path,
    extension: &str,
    bytes: &[u8],
) -> std::io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(directory)?;
    // Pasted screenshots may be sensitive; keep only recent ones.
    for entry in std::fs::read_dir(directory)?.flatten() {
        let expired = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .map_or(false, |age| age > PASTE_IMAGE_MAX_AGE);
        if expired {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let path = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
    std::fs::write(&path, bytes)?;
    Ok(path)
}
