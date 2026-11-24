//! Inicio de sesión con GitHub por código de dispositivo (OAuth device flow), sin depender de Git ni
//! de Git Credential Manager:
//!
//! 1. `github_device_start` pide a GitHub un código corto y la dirección donde escribirlo.
//! 2. La persona abre esa dirección, escribe el código y autoriza a Pulso.
//! 3. `github_device_poll` consulta a GitHub hasta recibir el token, lo comprueba con `/user` y lo
//!    guarda en el almacén de credenciales del sistema, igual que la conexión por Git.
//!
//! Solo hace falta el identificador público de la aplicación OAuth de Pulso (`CLIENT_ID`), no un
//! secreto. El token nunca pasa por el WebView: se queda en Rust y en el almacén del sistema.
use crate::githubauth::{keyring_set_github, resolve_api_base, send_github_request, GithubState};
use crate::i18n::{tr, trf};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::State;

/// Identificador público (Client ID) de la aplicación OAuth «Pulso Editor» registrada en GitHub, con
/// «Device Flow» activado y tokens sin caducidad. No es un secreto. Se puede sustituir al compilar con
/// la variable `PULSO_GITHUB_CLIENT_ID` (vacía: se desactiva y se usa la conexión por Git).
const CLIENT_ID: &str = match option_env!("PULSO_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "Ov23ctd2I0EnevVSgO2p",
};
/// Permisos: `repo` para issues, pull requests y repositorios privados; `read:user` para saber quién es.
const SCOPES: &str = "repo read:user";
const GITHUB_WEB_DEFAULT: &str = "https://github.com";

/// Cada inicio o cancelación invalida la espera anterior.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Lo que dice GitHub en cada consulta de la espera.
#[derive(Debug, PartialEq)]
pub enum Poll {
    Token(String),
    Pending,
    /// GitHub pide consultar más despacio: nuevo intervalo en segundos.
    SlowDown(u64),
    Failed(String),
}

/// Dirección web de GitHub: siempre github.com; en desarrollo, un servidor local de pruebas.
fn resolve_web_base(override_base: Option<&str>) -> Result<String, String> {
    let Some(raw) = override_base.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(GITHUB_WEB_DEFAULT.to_string());
    };
    let trimmed = raw.trim_end_matches('/');
    if trimmed == GITHUB_WEB_DEFAULT {
        return Ok(trimmed.to_string());
    }
    if cfg!(debug_assertions) && (trimmed.starts_with("http://127.0.0.1:") || trimmed.starts_with("http://localhost:")) {
        return Ok(trimmed.to_string());
    }
    Err(tr("Dirección de GitHub no permitida").into())
}

fn client_id() -> Option<&'static str> {
    Some(CLIENT_ID.trim()).filter(|s| !s.is_empty())
}

/// `application/x-www-form-urlencoded` para los pocos valores que se envían (sin dependencias).
fn form(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                b' ' => "+".to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

pub fn parse_start(body: &str) -> Result<DeviceStart, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|_| tr("GitHub devolvió una respuesta que Pulso no entiende.").to_string())?;
    if let Some(err) = v["error"].as_str() {
        return Err(explain_error(err, v["error_description"].as_str()));
    }
    let text = |k: &str| v[k].as_str().map(str::to_string).filter(|s| !s.is_empty());
    match (text("device_code"), text("user_code"), text("verification_uri")) {
        (Some(device_code), Some(user_code), Some(verification_uri)) if crate::githubauth::is_safe_url(&verification_uri) => Ok(DeviceStart {
            device_code,
            user_code,
            verification_uri,
            expires_in: v["expires_in"].as_u64().unwrap_or(900),
            interval: v["interval"].as_u64().unwrap_or(5).max(1),
        }),
        _ => Err(tr("GitHub devolvió una respuesta que Pulso no entiende.").into()),
    }
}

pub fn parse_poll(body: &str, interval: u64) -> Poll {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Poll::Failed(tr("GitHub devolvió una respuesta que Pulso no entiende.").into());
    };
    if let Some(token) = v["access_token"].as_str().filter(|t| !t.is_empty()) {
        return Poll::Token(token.to_string());
    }
    match v["error"].as_str() {
        Some("authorization_pending") => Poll::Pending,
        Some("slow_down") => Poll::SlowDown(v["interval"].as_u64().unwrap_or(interval + 5).max(interval + 1)),
        Some(err) => Poll::Failed(explain_error(err, v["error_description"].as_str())),
        None => Poll::Failed(tr("GitHub devolvió una respuesta que Pulso no entiende.").into()),
    }
}

fn explain_error(code: &str, description: Option<&str>) -> String {
    match code {
        "expired_token" => tr("El código caducó antes de que lo autorizaras. Vuelve a empezar.").into(),
        "access_denied" => tr("Cancelaste la autorización en GitHub.").into(),
        "device_flow_disabled" => tr("La aplicación de Pulso en GitHub no tiene activado el inicio de sesión por código (Device Flow).").into(),
        "incorrect_client_credentials" => tr("GitHub no reconoce la aplicación de Pulso (identificador incorrecto).").into(),
        "unsupported_grant_type" | "incorrect_device_code" => tr("GitHub rechazó el código. Vuelve a empezar.").into(),
        other => trf("GitHub rechazó el inicio de sesión: {reason}", &[("reason", &description.unwrap_or(other))]),
    }
}

async fn post_form(state: &GithubState, url: String, body: String) -> Result<String, String> {
    let res = state
        .client
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| trf("No se pudo contactar con GitHub: {e}", &[("e", &e)]))?;
    res.text().await.map_err(|e| trf("Error leyendo respuesta de GitHub: {e}", &[("e", &e)]))
}

/// Comprueba el token con `/user` y, si vale, lo deja guardado. Devuelve el `login`.
async fn adopt_token(state: &GithubState, api_base: &str, token: String) -> Result<String, String> {
    let res = send_github_request(&state.client, Some(&token), "GET", api_base, "/user", None, None, None).await?;
    if !(200..300).contains(&res.status) {
        return Err(trf("GitHub respondió {status}", &[("status", &res.status)]));
    }
    let login = serde_json::from_str::<serde_json::Value>(&res.body)
        .ok()
        .and_then(|v| v["login"].as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| tr("GitHub devolvió una respuesta que Pulso no entiende.").to_string())?;
    state.set_memory_token(Some(token.clone()));
    let _ = tauri::async_runtime::spawn_blocking(move || keyring_set_github(&token)).await;
    Ok(login)
}

pub async fn start(state: &GithubState, web_base: &str) -> Result<DeviceStart, String> {
    let id = client_id().ok_or_else(|| tr("Esta compilación de Pulso no tiene configurado el inicio de sesión con GitHub.").to_string())?;
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let body = post_form(state, format!("{web_base}/login/device/code"), form(&[("client_id", id), ("scope", SCOPES)])).await?;
    parse_start(&body)
}

/// Espera a que la persona autorice y devuelve el token (sin guardarlo).
pub async fn poll_token(state: &GithubState, web_base: &str, device_code: &str, interval: u64, expires_in: u64) -> Result<String, String> {
    let id = client_id().ok_or_else(|| tr("Esta compilación de Pulso no tiene configurado el inicio de sesión con GitHub.").to_string())?;
    let generation = GENERATION.load(Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(expires_in.clamp(10, 1800));
    let mut interval = interval.max(1);
    loop {
        let wait = Duration::from_secs(interval);
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait)).await;
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err(tr("Inicio de sesión cancelado.").into());
        }
        if Instant::now() > deadline {
            return Err(tr("El código caducó antes de que lo autorizaras. Vuelve a empezar.").into());
        }
        let body = post_form(
            state,
            format!("{web_base}/login/oauth/access_token"),
            form(&[("client_id", id), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")]),
        )
        .await?;
        match parse_poll(&body, interval) {
            Poll::Token(token) => return Ok(token),
            Poll::Pending => {}
            Poll::SlowDown(next) => interval = next,
            Poll::Failed(message) => return Err(message),
        }
    }
}

#[tauri::command]
pub fn github_device_available() -> bool {
    client_id().is_some()
}

#[tauri::command]
pub async fn github_device_start(state: State<'_, GithubState>, web_base: Option<String>) -> Result<DeviceStart, String> {
    let web = resolve_web_base(web_base.as_deref())?;
    start(&state, &web).await
}

#[tauri::command]
pub async fn github_device_poll(
    state: State<'_, GithubState>,
    device_code: String,
    interval: u64,
    expires_in: u64,
    web_base: Option<String>,
    api_base: Option<String>,
) -> Result<String, String> {
    let web = resolve_web_base(web_base.as_deref())?;
    let api = resolve_api_base(api_base.as_deref())?;
    let token = poll_token(&state, &web, &device_code, interval, expires_in).await?;
    adopt_token(&state, &api, token).await
}

#[tauri::command]
pub fn github_device_cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_codigo_que_devuelve_github() {
        let s =
            parse_start(r#"{"device_code":"dc1","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":899,"interval":5}"#)
                .unwrap();
        assert_eq!(s.user_code, "ABCD-1234");
        assert_eq!(s.device_code, "dc1");
        assert_eq!(s.interval, 5);
        assert!(parse_start(r#"{"error":"device_flow_disabled"}"#).unwrap_err().contains("Device Flow"));
        // Una dirección que no sea http(s) no se abre.
        assert!(parse_start(r#"{"device_code":"d","user_code":"u","verification_uri":"javascript:alert(1)"}"#).is_err());
    }

    #[test]
    fn interpreta_cada_respuesta_de_la_espera() {
        assert_eq!(parse_poll(r#"{"access_token":"gho_x","token_type":"bearer"}"#, 5), Poll::Token("gho_x".into()));
        assert_eq!(parse_poll(r#"{"error":"authorization_pending"}"#, 5), Poll::Pending);
        assert_eq!(parse_poll(r#"{"error":"slow_down","interval":10}"#, 5), Poll::SlowDown(10));
        assert_eq!(parse_poll(r#"{"error":"slow_down"}"#, 5), Poll::SlowDown(10));
        assert!(matches!(parse_poll(r#"{"error":"access_denied"}"#, 5), Poll::Failed(m) if m.contains("Cancelaste")));
        assert!(matches!(parse_poll(r#"{"error":"expired_token"}"#, 5), Poll::Failed(m) if m.contains("caducó")));
        assert!(matches!(parse_poll("no es json", 5), Poll::Failed(_)));
    }

    #[test]
    fn codifica_el_formulario() {
        assert_eq!(
            form(&[("scope", "repo read:user"), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")]),
            "scope=repo+read%3Auser&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
        );
    }

    /// GitHub simulado: entrega un código, contesta «pendiente» una vez y después el token.
    fn fake_github() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            let mut polls = 0;
            for stream in listener.incoming().take(3) {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                log.lock().unwrap().push(format!("{} {}", first.trim(), String::from_utf8_lossy(&body)));
                let reply = if first.contains("/login/device/code") {
                    r#"{"device_code":"dc1","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":60,"interval":1}"#
                } else if polls == 0 {
                    polls += 1;
                    r#"{"error":"authorization_pending"}"#
                } else {
                    r#"{"access_token":"gho_prueba","token_type":"bearer","scope":"repo,read:user"}"#
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.len(),
                    reply
                );
            }
        });
        (base, seen)
    }

    #[test]
    fn flujo_completo_contra_un_github_simulado() {
        if client_id().is_none() {
            // Sin identificador de aplicación el flujo no se puede iniciar; lo cubre la prueba de abajo.
            return;
        }
        let (base, seen) = fake_github();
        let state = GithubState::default();
        let started = tauri::async_runtime::block_on(start(&state, &base)).unwrap();
        assert_eq!(started.user_code, "WDJB-MJHT");
        let token = tauri::async_runtime::block_on(poll_token(&state, &base, &started.device_code, started.interval, started.expires_in)).unwrap();
        assert_eq!(token, "gho_prueba");
        let log = seen.lock().unwrap().join("\n");
        assert!(log.contains("POST /login/device/code") && log.contains("scope=repo+read%3Auser"), "{log}");
        assert!(log.contains("device_code=dc1") && log.contains("grant_type=urn%3Aietf"), "{log}");
    }

    #[test]
    fn sin_identificador_de_aplicacion_lo_explica() {
        if client_id().is_some() {
            return;
        }
        let err = tauri::async_runtime::block_on(start(&GithubState::default(), "http://127.0.0.1:9")).unwrap_err();
        assert!(err.contains("no tiene configurado"), "{err}");
    }

    #[test]
    fn solo_github_o_un_servidor_local_de_pruebas() {
        assert_eq!(resolve_web_base(None).unwrap(), "https://github.com");
        assert!(resolve_web_base(Some("https://evil.example.com")).is_err());
        if cfg!(debug_assertions) {
            assert_eq!(resolve_web_base(Some("http://127.0.0.1:9/")).unwrap(), "http://127.0.0.1:9");
        }
    }
}
