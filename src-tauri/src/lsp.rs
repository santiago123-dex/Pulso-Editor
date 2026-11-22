//! Transporte LSP por stdio. El frontend habla JSON-RPC; aquí solo se enmarcan mensajes.
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

struct Server {
    id: u64,
    pid: u32,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Default)]
pub struct LspState {
    next: AtomicU64,
    server: Mutex<Option<Server>>,
}

impl LspState {
    pub fn stop(&self) {
        let taken = match self.server.lock() {
            Ok(mut guard) => guard.take(),
            Err(_) => None,
        };
        if let Some(mut server) = taken {
            // Cerrar stdin primero permite una salida limpia antes de terminar el árbol.
            drop(server.stdin);
            crate::procguard::kill_tree(server.pid);
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

#[derive(Clone, Serialize)]
struct Message {
    id: u64,
    message: serde_json::Value,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u64,
    error: String,
}

const MAX_HEADER_LINE: usize = 16 * 1024;
const MAX_HEADER_COUNT: usize = 64;

fn read_bounded_line(reader: &mut impl BufRead, max: usize) -> Result<Option<String>, String> {
    let mut buf = Vec::new();
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf().map_err(|e| e.to_string())?;
        if available.is_empty() {
            return if total == 0 {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
            };
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if total + take > max {
                return Err("LSP: cabecera demasiado larga".into());
            }
            buf.extend_from_slice(&available[..take]);
            reader.consume(take);
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        let len = available.len();
        if total + len > max {
            return Err("LSP: cabecera demasiado larga".into());
        }
        buf.extend_from_slice(available);
        total += len;
        reader.consume(len);
    }
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<serde_json::Value>, String> {
    let mut length = None;
    let mut headers = 0usize;
    loop {
        let Some(line) = read_bounded_line(reader, MAX_HEADER_LINE)? else {
            return Ok(None);
        };
        if line == "\r\n" || line == "\n" {
            break;
        }
        headers += 1;
        if headers > MAX_HEADER_COUNT {
            return Err("LSP: demasiadas cabeceras".into());
        }
        if let Some((key, value)) = line.trim_end().split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let length = length.ok_or("LSP: falta Content-Length")?;
    if length > 32 * 1024 * 1024 {
        return Err("LSP: mensaje demasiado grande".into());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
}

fn server_path(app: &AppHandle) -> Option<PathBuf> {
    let relative = Path::new("lsp/node_modules/typescript-language-server/lib/cli.mjs");
    let packaged = app.path().resource_dir().ok().map(|p| p.join(relative));
    let development = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/typescript-language-server/lib/cli.mjs");
    packaged
        .filter(|p| p.is_file())
        .or_else(|| development.is_file().then_some(development))
}

fn preload_path(app: &AppHandle) -> Option<PathBuf> {
    let packaged = app.path().resource_dir().ok().map(|p| p.join("lsp/no-console.cjs"));
    let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/lsp-no-console.cjs");
    packaged
        .filter(|p| p.is_file())
        .or_else(|| development.is_file().then_some(development))
}

/// Node no resuelve correctamente rutas verbatim de Windows (`\\?\C:\...`) en `--require`.
#[cfg(windows)]
fn node_path(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        path
    }
}
#[cfg(not(windows))]
fn node_path(path: PathBuf) -> PathBuf {
    path
}

#[tauri::command]
pub fn lsp_host_pid() -> u32 {
    std::process::id()
}

#[tauri::command]
pub async fn lsp_start(app: AppHandle, root: String) -> Result<u64, String> {
    let script = node_path(
        server_path(&app).ok_or("No se encontró el servidor de TypeScript de Pulso")?,
    );
    let preload = node_path(
        preload_path(&app).ok_or("No se encontró la configuración del servidor de lenguaje")?,
    );
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&root).is_dir() {
            return Err("La carpeta de trabajo ya no existe".into());
        }
        let state = app.state::<LspState>();
        state.stop();
        let node = crate::aichat::node_program(Path::new(&root));
        let mut command = crate::background_command(&node);
        command
            .arg("--require")
            .arg(preload)
            .arg(script)
            .arg("--stdio")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::procguard::configure_child(&mut command);
        let mut child = command.spawn().map_err(|e| {
            format!("No se pudo iniciar LSP. Instala Node.js 22.22.2 o superior y reinicia Pulso: {e}")
        })?;
        crate::procguard::attach_job(&child);
        let pid = child.id();
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("No se pudo abrir la entrada del servidor")?,
        ));
        let stdout = child.stdout.take().ok_or("No se pudo abrir la salida del servidor")?;
        let stderr = child.stderr.take().ok_or("No se pudo leer el error del servidor")?;
        let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
        *state.server.lock().map_err(|e| e.to_string())? = Some(Server { id, pid, child, stdin });

        let app_ev = app.clone();
        let stderr_reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut captured = Vec::new();
            let mut chunk = [0; 4096];
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let remaining = 16_384usize.saturating_sub(captured.len());
                captured.extend_from_slice(&chunk[..n.min(remaining)]);
            }
            String::from_utf8_lossy(&captured).trim().to_string()
        });
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let error = loop {
                match read_message(&mut reader) {
                    Ok(Some(message)) => {
                        let _ = app_ev.emit("lsp-message", Message { id, message });
                    }
                    Ok(None) => break "El servidor de lenguaje se cerró".to_string(),
                    Err(e) => break e,
                }
            };
            let detail = stderr_reader.join().unwrap_or_default();
            let error = if detail.is_empty() { error } else { format!("{error}: {detail}") };
            let _ = app_ev.emit("lsp-exit", Exit { id, error });
        });
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_send(
    state: State<'_, LspState>,
    id: u64,
    message: serde_json::Value,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    let stdin = {
        let guard = state.server.lock().map_err(|e| e.to_string())?;
        let server = guard
            .as_ref()
            .filter(|s| s.id == id)
            .ok_or("El servidor LSP ya no está activo")?;
        Arc::clone(&server.stdin)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut pipe = stdin.lock().map_err(|e| e.to_string())?;
        write!(pipe, "Content-Length: {}\r\n\r\n", bytes.len()).map_err(|e| e.to_string())?;
        pipe.write_all(&bytes)
            .and_then(|_| pipe.flush())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<LspState>().stop();
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn node_paths_remove_windows_verbatim_prefixes() {
        assert_eq!(
            node_path(PathBuf::from(r"\\?\C:\Pulso Editor\server.js")),
            PathBuf::from(r"C:\Pulso Editor\server.js")
        );
        assert_eq!(
            node_path(PathBuf::from(r"\\?\UNC\server\share\server.js")),
            PathBuf::from(r"\\server\share\server.js")
        );
        assert_eq!(
            node_path(PathBuf::from(r"C:\app\server.js")),
            PathBuf::from(r"C:\app\server.js")
        );
    }
    #[test]
    fn reads_utf8_and_multiple_frames() {
        let first = "{\"text\":\"ñ😀\"}";
        let second = "{\"id\":2}";
        let frames = format!(
            "Content-Length: {}\r\n\r\n{}Content-Length: {}\r\n\r\n{}",
            first.len(),
            first,
            second.len(),
            second
        );
        let mut reader = BufReader::new(frames.as_bytes());
        assert_eq!(read_message(&mut reader).unwrap().unwrap()["text"], "ñ😀");
        assert_eq!(read_message(&mut reader).unwrap().unwrap()["id"], 2);
        assert!(read_message(&mut reader).unwrap().is_none());
    }
    #[test]
    fn rejects_missing_and_excessive_lengths_and_headers() {
        assert!(read_message(&mut BufReader::new(&b"Other: x\r\n\r\n"[..])).is_err());
        assert!(read_message(&mut BufReader::new(&b"Content-Length: 999999999\r\n\r\n"[..])).is_err());
        let giant_header = format!("X-Long: {}\r\n\r\n", "a".repeat(MAX_HEADER_LINE + 10));
        assert!(read_message(&mut BufReader::new(giant_header.as_bytes())).is_err());
    }
}
