//! Conexión con GitHub sin que la persona pegue un token: se reutiliza la sesión que Git ya tiene
//! (Git Credential Manager guarda la que se autoriza en el navegador al hacer clonar o push).
//! Si no hay ninguna, el gestor abre el navegador para que se autorice y devuelve el resultado.
use super::background_command;
use serde::Serialize;
use std::{
    io::{Read, Write},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize, Debug, PartialEq)]
pub struct Credential {
    pub username: String,
    pub token: String,
}

/// Lee la respuesta de `git credential fill` (líneas `clave=valor`).
pub fn parse_credential(out: &str) -> Option<Credential> {
    let (mut username, mut token) = (String::new(), String::new());
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(v) = line.strip_prefix("username=") { username = v.to_string(); }
        else if let Some(v) = line.strip_prefix("password=") { token = v.to_string(); }
    }
    if token.is_empty() { None } else { Some(Credential { username, token }) }
}

fn fill_sync(interactive: bool) -> Result<Credential, String> {
    let secs = if interactive { 180 } else { 15 };
    let mut cmd = background_command("git");
    cmd.args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Sin interacción: solo usar lo ya guardado; nunca abrir ventanas ni el navegador.
    if !interactive {
        cmd.env("GCM_INTERACTIVE", "never");
    }
    let mut child = cmd.spawn().map_err(|_| "No se encontró Git. Instálalo para conectar con GitHub desde Pulso".to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"protocol=https\nhost=github.com\n\n");
    }
    let mut out = child.stdout.take().ok_or("sin salida")?;
    let mut err = child.stderr.take().ok_or("sin salida de error")?;
    let t_out = thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); s });
    let t_err = thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if interactive {
                    "La autorización en GitHub tardó demasiado y se canceló. Vuelve a intentarlo".to_string()
                } else {
                    "Git no respondió a tiempo".to_string()
                });
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    if status.success() {
        if let Some(c) = parse_credential(&stdout) { return Ok(c); }
    }
    let _ = stderr; // Puede contener datos del inicio de sesión: no se devuelve.
    Err(if interactive {
        "No se pudo autorizar con GitHub. Comprueba que Git Credential Manager esté instalado (viene con Git para Windows) y vuelve a intentarlo".to_string()
    } else {
        "Git no tiene una sesión de GitHub guardada".to_string()
    })
}

/// Devuelve la credencial de GitHub que gestiona Git. Con `interactive`, el gestor puede abrir el navegador para autorizar.
#[tauri::command]
pub async fn github_credential(interactive: bool) -> Result<Credential, String> {
    tauri::async_runtime::spawn_blocking(move || fill_sync(interactive)).await.map_err(|e| e.to_string())?
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
}

/// Solo http(s), sin espacios ni caracteres de control: lo que se entrega al sistema nunca es una orden.
pub fn is_safe_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '<' || c == '>')
}

/// Abre un enlace con el navegador predeterminado (la ventana de la aplicación no abre ventanas nuevas).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_safe_url(&url) {
        return Err("Solo se pueden abrir enlaces http o https".to_string());
    }
    #[cfg(windows)]
    let mut cmd = background_command("rundll32");
    #[cfg(windows)]
    cmd.args(["url.dll,FileProtocolHandler", &url]);
    #[cfg(target_os = "macos")]
    let mut cmd = background_command("open");
    #[cfg(target_os = "macos")]
    cmd.arg(&url);
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = background_command("xdg-open");
    #[cfg(all(unix, not(target_os = "macos")))]
    cmd.arg(&url);
    cmd.spawn().map(|_| ()).map_err(|e| format!("No se pudo abrir el navegador: {e}"))
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
