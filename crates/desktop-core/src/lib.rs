pub mod hwid_service;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Checker,
    Admin,
}
struct AppState {
    mode: Mode,
    endpoint: Mutex<String>,
    admin_token: Mutex<Option<String>>,
    checker_started: Mutex<bool>,
    checker_view: Mutex<CheckerView>,
    client: reqwest::Client,
}
#[derive(Clone, Serialize, Default)]
struct CheckerView {
    connection: String,
    status: String,
    current_hwid_preview: Option<String>,
    expected_hwid_preview: Option<String>,
    identity_changed_after_reset: bool,
    last_update: Option<u64>,
    message: String,
}
#[derive(Deserialize)]
struct ApiError {
    error: String,
}
#[derive(Debug, Serialize)]
struct ClientError {
    code: String,
    message: String,
}
impl ClientError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
fn lock_error() -> ClientError {
    ClientError::new("internal_error", "Application state is unavailable.")
}
fn validate_endpoint(endpoint: &str) -> Result<String, ClientError> {
    let parsed = url::Url::parse(endpoint.trim())
        .map_err(|_| ClientError::new("invalid_url", "Enter a valid backend HTTPS URL."))?;
    let local = cfg!(debug_assertions)
        && parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"));
    if (parsed.scheme() != "https" && !local)
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(ClientError::new("invalid_url", "Use the backend HTTPS origin without a path. HTTP localhost is allowed only in development builds."));
    }
    Ok(parsed.as_str().trim_end_matches('/').into())
}
async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    payload: Value,
    token: Option<&str>,
) -> Result<Value, ClientError> {
    let endpoint = state.endpoint.lock().map_err(|_| lock_error())?.clone();
    if endpoint.is_empty() {
        return Err(ClientError::new(
            "backend_required",
            "Set the verification server URL.",
        ));
    }
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| ClientError::new("invalid_request", "Invalid request."))?;
    let mut builder = state
        .client
        .request(method.clone(), format!("{endpoint}{path}"));
    if method != reqwest::Method::GET {
        builder = builder.json(&payload);
    }
    if let Some(token) = token {
        builder = builder.bearer_auth(token);
    }
    let response = builder.send().await.map_err(|_| {
        ClientError::new(
            "network_error",
            "Cannot reach the verification server. Check your connection.",
        )
    })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ClientError::new("network_error", "Connection interrupted."))?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(ClientError::new(
            "invalid_response",
            "Invalid server response.",
        ));
    }
    if !status.is_success() {
        let code = serde_json::from_slice::<ApiError>(&bytes)
            .map(|v| v.error)
            .unwrap_or_else(|_| "server_error".into());
        let message = match code.as_str() {
            "invalid_credentials" => "Incorrect username or password.",
            "unauthorized" => "Your session expired. Sign in again.",
            "code_unavailable" => "This code is invalid, expired, completed or already connected. Ask staff for a new code.",
            "checker_session_expired" => "This verification session expired. Contact staff if further verification is needed.",
            "checker_must_be_online" => "The checker must be online before this action.",
            "session_changed_retry" => "The session changed. Refresh and try again.",
            "rate_limited" => "Too many requests. Wait one minute before trying again.",
            "invalid_request" => "Check the entered values and HWID preview.",
            "session_not_active" => "This verification session is no longer active.",
            _ => "The server could not complete this action."
        };
        return Err(ClientError::new(&code, message));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ClientError::new("invalid_response", "Invalid server response."))
}
#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Value {
    json!({ "version": env!("CARGO_PKG_VERSION"), "endpoint": state.endpoint.lock().ok().map(|s| s.clone()).unwrap_or_default(), "development": cfg!(debug_assertions) })
}
#[tauri::command]
fn set_endpoint(state: State<'_, AppState>, endpoint: String) -> Result<(), ClientError> {
    if *state.checker_started.lock().map_err(|_| lock_error())?
        || state
            .admin_token
            .lock()
            .map_err(|_| lock_error())?
            .is_some()
    {
        return Err(ClientError::new(
            "session_active",
            "Finish the current session before changing the server.",
        ));
    }
    *state.endpoint.lock().map_err(|_| lock_error())? = validate_endpoint(&endpoint)?;
    Ok(())
}
#[tauri::command]
async fn admin_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<Value, ClientError> {
    if state.mode != Mode::Admin {
        return Err(ClientError::new("forbidden", "Unavailable."));
    }
    let response = request(
        &state,
        "POST",
        "/api/admin/login",
        json!({ "username": username, "password": password }),
        None,
    )
    .await?;
    let token = response["token"]
        .as_str()
        .ok_or_else(|| ClientError::new("invalid_response", "Invalid server response."))?
        .to_string();
    *state.admin_token.lock().map_err(|_| lock_error())? = Some(token);
    Ok(json!({ "username": response["username"], "expires_at": response["expires_at"] }))
}
#[tauri::command]
async fn admin_logout(state: State<'_, AppState>) -> Result<(), ClientError> {
    if state.mode != Mode::Admin {
        return Err(ClientError::new("forbidden", "Unavailable."));
    }
    // Forget the token before network I/O, including offline/expired sessions.
    let token = state.admin_token.lock().map_err(|_| lock_error())?.take();
    if let Some(token) = token {
        let _ = request(&state, "POST", "/api/admin/logout", json!({}), Some(&token)).await;
    }
    Ok(())
}
#[tauri::command]
async fn admin_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    payload: Option<Value>,
) -> Result<Value, ClientError> {
    if state.mode != Mode::Admin
        || !matches!(method.as_str(), "GET" | "POST")
        || !path.starts_with("/api/admin/")
        || path.contains(['?', '#', '\\'])
        || path.contains("..")
    {
        return Err(ClientError::new("forbidden", "Unavailable."));
    }
    let token = state
        .admin_token
        .lock()
        .map_err(|_| lock_error())?
        .clone()
        .ok_or_else(|| ClientError::new("unauthorized", "Sign in first."))?;
    let result = request(
        &state,
        &method,
        &path,
        payload.unwrap_or(Value::Null),
        Some(&token),
    )
    .await;
    if path == "/api/admin/logout"
        || result.as_ref().err().map(|e| e.code.as_str()) == Some("unauthorized")
    {
        *state.admin_token.lock().map_err(|_| lock_error())? = None;
    }
    result
}
fn emit_view(app: &tauri::AppHandle, view: CheckerView) {
    if let Ok(mut current) = app.state::<AppState>().checker_view.lock() {
        *current = view.clone();
    }
    let _ = app.emit("checker_status", &view);
}
fn view_from_response(response: &Value) -> CheckerView {
    let status = response["status"].as_str().unwrap_or("failed").to_string();
    let connection = match status.as_str() {
        "expired" => "expired",
        "completed" => "completed",
        "mismatch" => "failed",
        "cancelled" => "cancelled",
        _ => "connected",
    }
    .into();
    CheckerView {
        connection,
        status,
        current_hwid_preview: response["current_hwid_preview"]
            .as_str()
            .map(str::to_string),
        expected_hwid_preview: response["expected_hwid_preview"]
            .as_str()
            .map(str::to_string),
        identity_changed_after_reset: response["identity_changed_after_reset"]
            .as_bool()
            .unwrap_or(false),
        last_update: response["server_timestamp"].as_u64(),
        message: String::new(),
    }
}
#[tauri::command]
fn checker_status(state: State<'_, AppState>) -> Result<CheckerView, ClientError> {
    Ok(state.checker_view.lock().map_err(|_| lock_error())?.clone())
}
#[tauri::command]
async fn checker_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    code: String,
) -> Result<(), ClientError> {
    if state.mode != Mode::Checker {
        return Err(ClientError::new("forbidden", "Unavailable."));
    }
    {
        let mut started = state.checker_started.lock().map_err(|_| lock_error())?;
        if *started {
            return Err(ClientError::new(
                "session_active",
                "Verification is already running.",
            ));
        }
        *started = true;
    }
    let result = async {
        let identity =
            hwid_service::collect().map_err(|e| ClientError::new("identity_error", &e))?;
        request(
            &state,
            "POST",
            "/api/checker/connect",
            json!({ "code": code, "identity": identity }),
            None,
        )
        .await
    }
    .await;
    let response = match result {
        Ok(value) => value,
        Err(error) => {
            *state.checker_started.lock().map_err(|_| lock_error())? = false;
            return Err(error);
        }
    };
    let token = response["token"]
        .as_str()
        .ok_or_else(|| ClientError::new("invalid_response", "Invalid server response."))?
        .to_string();
    emit_view(&app, view_from_response(&response));
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        loop {
            let delay = if failures == 0 {
                3
            } else {
                (2u64.pow(failures.min(5))).min(30)
            };
            tokio::time::sleep(Duration::from_secs(delay)).await;
            let state = app.state::<AppState>();
            let result = match hwid_service::collect() {
                Ok(identity) => {
                    request(
                        &state,
                        "POST",
                        "/api/checker/heartbeat",
                        json!({ "identity": identity }),
                        Some(&token),
                    )
                    .await
                }
                Err(error) => Err(ClientError::new("identity_error", &error)),
            };
            match result {
                Ok(response) => {
                    failures = 0;
                    let view = view_from_response(&response);
                    let terminal = !matches!(view.status.as_str(), "active" | "reset_marked");
                    emit_view(&app, view);
                    if terminal {
                        break;
                    }
                }
                Err(error) => {
                    failures += 1;
                    let mut view = state
                        .checker_view
                        .lock()
                        .map(|v| v.clone())
                        .unwrap_or_default();
                    view.connection = if matches!(
                        error.code.as_str(),
                        "unauthorized" | "identity_error" | "invalid_response" | "invalid_request"
                    ) {
                        "failed"
                    } else {
                        "reconnecting"
                    }
                    .into();
                    if error.code == "checker_session_expired" {
                        view.connection = "expired".into();
                        view.status = "expired".into();
                    }
                    view.message = error.message;
                    let terminal = matches!(view.connection.as_str(), "failed" | "expired");
                    emit_view(&app, view);
                    if terminal {
                        break;
                    }
                    if error.code == "rate_limited" {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                }
            }
        }
    });
    Ok(())
}
pub fn run(context: tauri::Context<tauri::Wry>, mode: Mode) {
    #[cfg(debug_assertions)]
    let default_endpoint = option_env!("VEXOR_API_URL").unwrap_or("http://127.0.0.1:8787");
    #[cfg(not(debug_assertions))]
    let default_endpoint = env!("VEXOR_API_URL", "Set VEXOR_API_URL to your backend HTTPS origin before building a release.");
    let endpoint = if default_endpoint.is_empty() {
        String::new()
    } else {
        validate_endpoint(default_endpoint).expect("invalid VEXOR_API_URL")
    };
    let builder = tauri::Builder::default().setup(|app| {
        // Keep the native frame dark, suppress the Windows 11 outline, and request
        // compositor rounding. Older Windows versions safely ignore these attributes.
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(hwnd) = window.hwnd() {
                unsafe {
                    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
                    let dark = 1u32;
                    let rounded = 2u32;
                    let no_border = 0xfffffffeu32;
                    let _ = DwmSetWindowAttribute(hwnd.0 as _, 20, &dark as *const _ as _, 4);
                    let _ = DwmSetWindowAttribute(hwnd.0 as _, 33, &rounded as *const _ as _, 4);
                    let _ = DwmSetWindowAttribute(hwnd.0 as _, 34, &no_border as *const _ as _, 4);
                }
            }
        }
        Ok(())
    }).manage(AppState {
        mode,
        endpoint: Mutex::new(endpoint),
        admin_token: Mutex::new(None),
        checker_started: Mutex::new(false),
        checker_view: Mutex::new(CheckerView::default()),
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HTTP client initialization failed"),
    });
    let builder = match mode {
        Mode::Checker => builder.invoke_handler(tauri::generate_handler![
            app_info,
            set_endpoint,
            checker_start,
            checker_status
        ]),
        Mode::Admin => builder.invoke_handler(tauri::generate_handler![
            app_info,
            set_endpoint,
            admin_login,
            admin_logout,
            admin_request
        ]),
    };
    builder.run(context).expect("desktop application failed");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_validation() {
        assert!(validate_endpoint("https://example.com").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8787").is_ok());
        for value in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com/api",
            "file:///c:/test",
        ] {
            assert!(validate_endpoint(value).is_err());
        }
    }
}
