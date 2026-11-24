//! Conexión con GitHub y proxy HTTP desde Rust: el token vive únicamente en Rust y en el
//! almacén seguro del sistema operativo, y nunca entra en la memoria JavaScript del WebView.
use super::background_command;
use crate::i18n::{tr, trf};
use serde::Serialize;
use std::{
    fmt,
    io::{Read, Write},
    process::Stdio,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::State;

const SECRET_SERVICE: &str = "pulso-editor";
const GITHUB_SECRET_KEY: &str = "github-token";
const GITHUB_API_DEFAULT: &str = "https://api.github.com";

#[derive(PartialEq, Clone)]
pub struct Credential {
    pub username: String,
    pub token: String,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential").field("username", &self.username).field("token", &"[REDACTED]").finish()
    }
}

pub struct GithubState {
    pub(crate) token: Mutex<Option<String>>,
    pub(crate) client: reqwest::Client,
}

impl Default for GithubState {
    fn default() -> Self {
        let client = reqwest::Client::builder().user_agent("Pulso-Editor").timeout(Duration::from_secs(30)).build().unwrap_or_else(|_| reqwest::Client::new());
        Self { token: Mutex::new(None), client }
    }
}

impl GithubState {
    fn get_token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|g| g.clone()).filter(|t| !t.is_empty())
    }

    pub(crate) fn set_memory_token(&self, value: Option<String>) {
        if let Ok(mut g) = self.token.lock() {
            *g = value.filter(|t| !t.is_empty());
        }
    }
}

fn keyring_get_github() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, GITHUB_SECRET_KEY).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p).filter(|s| !s.is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn keyring_set_github(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return match keyring::Entry::new(SECRET_SERVICE, GITHUB_SECRET_KEY).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    keyring::Entry::new(SECRET_SERVICE, GITHUB_SECRET_KEY).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
}

/// Lee la respuesta de `git credential fill` (líneas `clave=valor`).
pub fn parse_credential(out: &str) -> Option<Credential> {
    let (mut username, mut token) = (String::new(), String::new());
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(v) = line.strip_prefix("username=") {
            username = v.to_string();
        } else if let Some(v) = line.strip_prefix("password=") {
            token = v.to_string();
        }
    }
    if token.is_empty() {
        None
    } else {
        Some(Credential { username, token })
    }
}

fn fill_sync(interactive: bool) -> Result<Credential, String> {
    let secs = if interactive { 180 } else { 15 };
    let mut cmd = background_command("git");
    cmd.args(["credential", "fill"]).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Sin interacción: solo usar lo ya guardado; nunca abrir ventanas ni el navegador.
    if !interactive {
        cmd.env("GCM_INTERACTIVE", "never");
    }
    crate::procguard::configure_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| tr("No se encontró Git. Instálalo para conectar con GitHub desde Pulso").to_string())?;
    crate::procguard::attach_job(&child);
    let pid = child.id();
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let mut err = child.stderr.take().ok_or(tr("sin salida de error"))?;
    let t_out = thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t_err = thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    if let Some(mut stdin) = child.stdin.take() {
        thread::spawn(move || {
            let _ = stdin.write_all(b"protocol=https\nhost=github.com\n\n");
        });
    }
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if Instant::now() >= deadline => {
                crate::procguard::kill_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                let _ = t_out.join();
                let _ = t_err.join();
                return Err(if interactive {
                    tr("La autorización en GitHub tardó demasiado y se canceló. Vuelve a intentarlo").to_string()
                } else {
                    tr("Git no respondió a tiempo").to_string()
                });
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    if status.success() {
        if let Some(c) = parse_credential(&stdout) {
            return Ok(c);
        }
    }
    let _ = stderr; // Puede contener datos del inicio de sesión: no se devuelve.
    Err(if interactive {
        tr("No se pudo autorizar con GitHub. Comprueba que Git Credential Manager esté instalado (viene con Git para Windows) y vuelve a intentarlo")
            .to_string()
    } else {
        tr("Git no tiene una sesión de GitHub guardada").to_string()
    })
}

/// Valida que la ruta enviada al proxy sea relativa a la API (evita SSRF).
pub fn validate_api_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\r') || path.contains('\n') {
        return Err(tr("Ruta de API de GitHub no válida").into());
    }
    Ok(())
}

/// Resuelve la URL base permitida: en producción siempre `https://api.github.com`;
/// en desarrollo permite servidores locales de prueba (`http://127.0.0.1:...` / `http://localhost:...`).
pub fn resolve_api_base(override_base: Option<&str>) -> Result<String, String> {
    let Some(raw) = override_base.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(GITHUB_API_DEFAULT.to_string());
    };
    let trimmed = raw.trim_end_matches('/');
    if trimmed == GITHUB_API_DEFAULT {
        return Ok(trimmed.to_string());
    }
    if cfg!(debug_assertions) && (trimmed.starts_with("http://127.0.0.1:") || trimmed.starts_with("http://localhost:")) && is_safe_url(trimmed) {
        return Ok(trimmed.to_string());
    }
    Err(tr("Dirección de API de GitHub no permitida").into())
}

fn allowed_accept(accept: Option<&str>) -> &'static str {
    match accept {
        Some("application/vnd.github.raw+json") => "application/vnd.github.raw+json",
        _ => "application/vnd.github+json",
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct GithubApiResponse {
    pub status: u16,
    pub body: String,
    pub etag: Option<String>,
    pub link: Option<String>,
}

pub(crate) async fn send_github_request(
    client: &reqwest::Client,
    token: Option<&str>,
    method: &str,
    base: &str,
    path: &str,
    body: Option<String>,
    accept: Option<&str>,
    if_none_match: Option<&str>,
) -> Result<GithubApiResponse, String> {
    validate_api_path(path)?;
    let http_method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(tr("Método HTTP no permitido").into()),
    };
    let url = format!("{base}{path}");
    let mut req = client.request(http_method, url).header("Accept", allowed_accept(accept)).header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(t) = token.filter(|s| !s.is_empty()) {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    if let Some(tag) = if_none_match.filter(|s| !s.is_empty()) {
        req = req.header("If-None-Match", tag);
    }
    if let Some(payload) = body {
        req = req.header("Content-Type", "application/json").body(payload);
    }
    let res = req.send().await.map_err(|e| trf("No se pudo contactar con GitHub: {e}", &[("e", &e)]))?;
    let status = res.status().as_u16();
    let etag = res.headers().get("etag").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let link = res.headers().get("link").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let text = res.text().await.map_err(|e| trf("Error leyendo respuesta de GitHub: {e}", &[("e", &e)]))?;
    Ok(GithubApiResponse { status, body: text, etag, link })
}

/// Carga el token desde el almacén seguro del SO en la memoria de Rust (sin exponerlo al WebView).
#[tauri::command]
pub async fn github_init(state: State<'_, GithubState>) -> Result<bool, String> {
    let loaded = tauri::async_runtime::spawn_blocking(keyring_get_github).await.map_err(|e| e.to_string())?.unwrap_or(None);
    let has = loaded.is_some();
    state.set_memory_token(loaded);
    Ok(has)
}

#[tauri::command]
pub fn github_has_token(state: State<'_, GithubState>) -> bool {
    state.get_token().is_some()
}

/// Guarda (o borra si está vacío) el token en Rust y en el almacén seguro del SO.
/// Devuelve `true` si persistió en el almacén del SO, `false` si solo quedó en memoria.
#[tauri::command]
pub async fn github_set_token(state: State<'_, GithubState>, token: String) -> Result<bool, String> {
    let clean = token.trim().to_string();
    state.set_memory_token(if clean.is_empty() { None } else { Some(clean.clone()) });
    let saved = tauri::async_runtime::spawn_blocking(move || keyring_set_github(&clean)).await.map_err(|e| e.to_string())?;
    Ok(saved.is_ok())
}

#[tauri::command]
pub async fn github_disconnect(state: State<'_, GithubState>) -> Result<(), String> {
    state.set_memory_token(None);
    let _ = tauri::async_runtime::spawn_blocking(|| keyring_set_github("")).await;
    Ok(())
}

/// Conecta con GitHub usando Git Credential Manager, verifica `/user` desde Rust y devuelve solo el `login`.
#[tauri::command]
pub async fn github_connect(state: State<'_, GithubState>, interactive: bool, base_url: Option<String>) -> Result<String, String> {
    let base = resolve_api_base(base_url.as_deref())?;
    let cred = tauri::async_runtime::spawn_blocking(move || fill_sync(interactive)).await.map_err(|e| e.to_string())??;
    let res = send_github_request(&state.client, Some(&cred.token), "GET", &base, "/user", None, None, None).await?;
    if res.status == 401 {
        return Err(tr("GitHub rechazó la sesión guardada en Git (caducó o se revocó). Vuelve a iniciar sesión desde una terminal con «git credential-manager github login» y reintenta.").into());
    }
    if !(200..300).contains(&res.status) {
        return Err(trf("GitHub respondió {status}", &[("status", &res.status)]));
    }
    let login = serde_json::from_str::<serde_json::Value>(&res.body)
        .ok()
        .and_then(|v| v["login"].as_str().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cred.username.clone());
    let tok = cred.token.clone();
    state.set_memory_token(Some(tok.clone()));
    let _ = tauri::async_runtime::spawn_blocking(move || keyring_set_github(&tok)).await;
    Ok(login)
}

/// Proxy seguro hacia la API de GitHub: inyecta el token desde `GithubState` en Rust.
#[tauri::command]
pub async fn github_api(
    state: State<'_, GithubState>,
    method: String,
    path: String,
    body: Option<String>,
    accept: Option<String>,
    if_none_match: Option<String>,
    base_url: Option<String>,
) -> Result<GithubApiResponse, String> {
    let base = resolve_api_base(base_url.as_deref())?;
    // El token se pone aquí, así que solo salen las solicitudes que la interfaz de Pulso necesita (ver githubpolicy.rs).
    crate::githubpolicy::check_request(&method, &path, body.as_deref()).map_err(|()| tr("Pulso no permite esta solicitud a GitHub").to_string())?;
    let token = state.get_token();
    send_github_request(&state.client, token.as_deref(), &method, &base, &path, body, accept.as_deref(), if_none_match.as_deref()).await
}

/// Solo http(s), sin espacios ni caracteres de control: lo que se entrega al sistema nunca es una orden.
pub fn is_safe_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '<' || c == '>')
}

/// Abre un enlace con el navegador predeterminado (la ventana de la aplicación no abre ventanas nuevas).
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    if !is_safe_url(&url) {
        return Err(tr("Solo se pueden abrir enlaces http o https").to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = background_command("rundll32");
            c.args(["url.dll,FileProtocolHandler", &url]);
            c
        };
        #[cfg(target_os = "macos")]
        let mut cmd = {
            let mut c = background_command("open");
            c.arg(&url);
            c
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut cmd = {
            let mut c = background_command("xdg-open");
            c.arg(&url);
            c
        };
        let child = cmd.spawn().map_err(|e| trf("No se pudo abrir el navegador: {e}", &[("e", &e)]))?;
        crate::procguard::reap_detached(child);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_usuario_y_contrasena() {
        let c = parse_credential("protocol=https\nhost=github.com\nusername=ana\npassword=gho_abc\n").unwrap();
        assert_eq!(c, Credential { username: "ana".into(), token: "gho_abc".into() });
    }

    #[test]
    fn debug_oculta_el_token() {
        let c = Credential { username: "ana".into(), token: "ghp_super_secreto".into() };
        let dbg = format!("{c:?}");
        assert!(dbg.contains("ana"));
        assert!(dbg.contains("[REDACTED]"));
        assert!(!dbg.contains("ghp_super_secreto"));
    }

    #[test]
    fn acepta_fin_de_linea_de_windows_y_contrasenas_con_igual() {
        let c = parse_credential("username=ana\r\npassword=a=b==\r\n").unwrap();
        assert_eq!(c.token, "a=b==");
        assert_eq!(c.username, "ana");
    }

    #[test]
    fn sin_contrasena_no_hay_credencial() {
        assert!(parse_credential("protocol=https\nhost=github.com\nusername=ana\n").is_none());
        assert!(parse_credential("").is_none());
        assert!(parse_credential("password=\n").is_none());
    }

    #[test]
    fn valida_rutas_y_base_del_proxy_github() {
        assert!(validate_api_path("/repos/a/b/issues").is_ok());
        assert!(validate_api_path("https://evil.com/x").is_err());
        assert!(validate_api_path("//evil.com/x").is_err());
        assert!(validate_api_path("/user\r\nX-Inject: 1").is_err());

        assert_eq!(resolve_api_base(None).unwrap(), GITHUB_API_DEFAULT);
        assert_eq!(resolve_api_base(Some("https://api.github.com/")).unwrap(), GITHUB_API_DEFAULT);
        assert!(resolve_api_base(Some("https://evil.example.com")).is_err());
        if cfg!(debug_assertions) {
            assert_eq!(resolve_api_base(Some("http://127.0.0.1:4567/")).unwrap(), "http://127.0.0.1:4567");
        }
    }
}

#[cfg(test)]
mod url_tests {
    use super::is_safe_url;

    #[test]
    fn acepta_enlaces_http_y_https() {
        assert!(is_safe_url("https://github.com/a/b/issues/1"));
        assert!(is_safe_url("http://localhost:3000/x?y=1&z=2"));
    }
    #[test]
    fn rechaza_otros_esquemas_y_caracteres_peligrosos() {
        assert!(!is_safe_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_safe_url("javascript:alert(1)"));
        assert!(!is_safe_url("calc.exe"));
        assert!(!is_safe_url("https://a.com/x y"));
        assert!(!is_safe_url("https://a.com/\"; calc"));
        assert!(!is_safe_url("https://a.com/\nx"));
        assert!(!is_safe_url(""));
    }
}
