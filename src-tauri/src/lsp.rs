//! Transporte LSP por stdio. El frontend habla JSON-RPC; aquí solo se enmarcan mensajes.
use crate::i18n::{tr, trf};
use serde::Serialize;
use std::{
    collections::HashMap,
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
    /// Clave: `(window_label, server_key)` donde `server_key` es `"typescript"`, `"python"`, `"rust"`, `"go"` o `"cpp"`.
    servers: Mutex<HashMap<(String, String), Server>>,
}

fn shutdown_server(mut server: Server) {
    // Cerrar stdin primero permite una salida limpia antes de terminar el árbol.
    drop(server.stdin);
    crate::procguard::kill_tree(server.pid);
    let _ = server.child.kill();
    let _ = server.child.wait();
}

impl LspState {
    pub fn stop_server(&self, label: &str, server_key: &str) {
        let taken = match self.servers.lock() {
            Ok(mut guard) => guard.remove(&(label.to_string(), server_key.to_string())),
            Err(_) => None,
        };
        if let Some(server) = taken {
            shutdown_server(server);
        }
    }

    pub fn stop_window(&self, label: &str) {
        let taken: Vec<Server> = match self.servers.lock() {
            Ok(mut guard) => {
                let keys: Vec<(String, String)> = guard.keys().filter(|(l, _)| l == label).cloned().collect();
                keys.into_iter().filter_map(|k| guard.remove(&k)).collect()
            }
            Err(_) => Vec::new(),
        };
        for server in taken {
            shutdown_server(server);
        }
    }

    pub fn stop(&self) {
        let all: Vec<Server> = match self.servers.lock() {
            Ok(mut guard) => guard.drain().map(|(_, s)| s).collect(),
            Err(_) => Vec::new(),
        };
        for server in all {
            shutdown_server(server);
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

/// Carpeta del paquete nativo de TypeScript 7 para esta plataforma (`@typescript/typescript-<plataforma>`).
fn native_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        _ => None,
    }
}

const NATIVE_EXE: &str = if cfg!(windows) { "tsc.exe" } else { "tsc" };

/// El servidor nativo de TypeScript 7 (`tsc --lsp --stdio`): un ejecutable sin Node que el instalador
/// incluye en `lsp/typescript/` junto a sus `lib.*.d.ts`.
fn native_server_path(app: &AppHandle) -> Option<PathBuf> {
    let packaged = app.path().resource_dir().ok().map(|p| p.join("lsp/typescript").join(NATIVE_EXE));
    let development = native_platform().map(|platform| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@typescript")
            .join(format!("typescript-{platform}"))
            .join("lib")
            .join(NATIVE_EXE)
    });
    packaged
        .filter(|p| p.is_file())
        .or_else(|| development.filter(|p| p.is_file()))
}

/// TypeScript instalado en el proyecto (en su `node_modules` o en el de una carpeta superior, como
/// lo resolvería Node): versión principal y ruta de su `tsserver.js`.
fn project_typescript(root: &Path) -> Option<(u32, PathBuf)> {
    root.ancestors().find_map(|dir| {
        let package = dir.join("node_modules/typescript");
        let text = std::fs::read_to_string(package.join("package.json")).ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        let major = json["version"].as_str()?.split('.').next()?.parse::<u32>().ok()?;
        Some((major, package.join("lib/tsserver.js")))
    })
}

/// TypeScript 7 eliminó opciones antiguas (`baseUrl`, `moduleResolution: "node"`, …). Un proyecto que
/// instala TypeScript 5 o 6 se comprueba con su propia versión, como antes; todos los demás con el nativo.
fn wants_compat(project: Option<&(u32, PathBuf)>) -> bool {
    matches!(project, Some((major, tsserver)) if *major < 7 && tsserver.is_file())
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

/// Qué servidor quedó en marcha. `tsserver` solo en el modo compatible: el cliente se lo pasa al servidor.
#[derive(Serialize)]
pub struct Started {
    id: u64,
    mode: &'static str,
    tsserver: Option<String>,
    notice: Option<String>,
}

fn spawn_native(app: &AppHandle, root: &str) -> Result<Child, String> {
    let exe = native_server_path(app).ok_or(tr("No se encontró el servidor de TypeScript de Pulso"))?;
    let mut command = crate::background_command(&exe.to_string_lossy());
    command.args(["--lsp", "--stdio"]);
    spawn_piped(command, root).map_err(|e| trf("No se pudo iniciar el servidor de TypeScript: {e}", &[("e", &e)]))
}

fn spawn_compat(app: &AppHandle, root: &str) -> Result<Child, String> {
    let script = node_path(server_path(app).ok_or(tr("No se encontró el servidor de TypeScript de Pulso"))?);
    let preload = node_path(
        preload_path(app).ok_or(tr("No se encontró la configuración del servidor de lenguaje"))?,
    );
    let node = crate::aichat::node_program(Path::new(root));
    let mut command = crate::background_command(&node);
    command.arg("--require").arg(preload).arg(script).arg("--stdio");
    spawn_piped(command, root).map_err(|e| e.to_string())
}

fn spawn_piped(mut command: std::process::Command, root: &str) -> std::io::Result<Child> {
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::procguard::configure_child(&mut command);
    command.spawn()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn extra_bin_candidates(name: &str, subdirs: &[&str]) -> Vec<String> {
    let mut out = vec![name.to_string()];
    #[cfg(windows)]
    let exe_name = format!("{name}.exe");
    #[cfg(not(windows))]
    let exe_name = name.to_string();
    if let Some(home) = home_dir() {
        for sub in subdirs {
            let p = home.join(sub).join(&exe_name);
            if p.is_file() {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    out
}

fn spawn_first_available(candidates: &[(String, &[&str])], root: &str) -> Result<Child, String> {
    let mut last_err = String::new();
    for (prog, args) in candidates {
        let mut cmd = crate::background_command(prog);
        cmd.args(*args);
        match spawn_piped(cmd, root) {
            Ok(child) => return Ok(child),
            Err(e) => { last_err = e.to_string(); }
        }
    }
    Err(last_err)
}

fn spawn_language_server(app: &AppHandle, root: &str, server_key: &str) -> Result<(Child, &'static str, Option<String>, Option<String>), String> {
    match server_key {
        "typescript" => {
            let project = project_typescript(Path::new(root));
            if wants_compat(project.as_ref()) {
                let (major, tsserver) = project.expect("comprobado en wants_compat");
                match spawn_compat(app, root) {
                    Ok(child) => Ok((child, "compat", Some(tsserver.to_string_lossy().into_owned()), None)),
                    Err(e) => Ok((
                        spawn_native(app, root)?,
                        "native",
                        None,
                        Some(trf(
                            "El proyecto usa TypeScript {major}, pero no se pudo iniciar Node.js ({e}). Se usa TypeScript 7, que puede marcar opciones de tsconfig que ya no existen.",
                            &[("major", &major), ("e", &e)],
                        )),
                    )),
                }
            } else {
                Ok((spawn_native(app, root)?, "native", None, None))
            }
        }
        "python" => {
            let mut candidates: Vec<(String, &[&str])> = Vec::new();
            for bin in ["basedpyright-langserver", "pyright-langserver"] {
                for p in extra_bin_candidates(bin, &[".local/bin"]) {
                    candidates.push((p, &["--stdio"]));
                }
            }
            for p in extra_bin_candidates("pylsp", &[".local/bin"]) {
                candidates.push((p, &[]));
            }
            let child = spawn_first_available(&candidates, root).map_err(|_| {
                tr("No se encontró un servidor LSP de Python. Instala pyright (`npm i -g pyright` o `pip install pyright`).").to_string()
            })?;
            Ok((child, "external", None, None))
        }
        "rust" => {
            let candidates: Vec<(String, &[&str])> = extra_bin_candidates("rust-analyzer", &[".cargo/bin"])
                .into_iter()
                .map(|p| (p, &[][..]))
                .collect();
            let child = spawn_first_available(&candidates, root).map_err(|_| {
                tr("No se encontró rust-analyzer. Instálalo con `rustup component add rust-analyzer`.").to_string()
            })?;
            Ok((child, "external", None, None))
        }
        "go" => {
            let candidates: Vec<(String, &[&str])> = extra_bin_candidates("gopls", &["go/bin"])
                .into_iter()
                .map(|p| (p, &[][..]))
                .collect();
            let child = spawn_first_available(&candidates, root).map_err(|_| {
                tr("No se encontró gopls. Instálalo con `go install golang.org/x/tools/gopls@latest`.").to_string()
            })?;
            Ok((child, "external", None, None))
        }
        "cpp" => {
            let candidates: Vec<(String, &[&str])> = vec![("clangd".to_string(), &[][..])];
            let child = spawn_first_available(&candidates, root).map_err(|_| {
                tr("No se encontró clangd. Instala LLVM/clangd para activar la inteligencia de C y C++.").to_string()
            })?;
            Ok((child, "external", None, None))
        }
        _ => Err(tr("Servidor de lenguaje no soportado").into()),
    }
}

#[tauri::command]
pub async fn lsp_start(
    window: tauri::WebviewWindow,
    app: AppHandle,
    root: String,
    server: Option<String>,
) -> Result<Started, String> {
    let label = window.label().to_string();
    let server_key = server.unwrap_or_else(|| "typescript".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&root).is_dir() {
            return Err(tr("La carpeta de trabajo ya no existe").into());
        }
        let state = app.state::<LspState>();
        state.stop_server(&label, &server_key);
        let (mut child, mode, tsserver, notice) = spawn_language_server(&app, &root, &server_key)?;
        crate::procguard::attach_job(&child);
        let pid = child.id();
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or(tr("No se pudo abrir la entrada del servidor"))?,
        ));
        let stdout = child.stdout.take().ok_or(tr("No se pudo abrir la salida del servidor"))?;
        let stderr = child.stderr.take().ok_or(tr("No se pudo leer el error del servidor"))?;
        let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
        state
            .servers
            .lock()
            .map_err(|e| e.to_string())?
            .insert((label.clone(), server_key), Server { id, pid, child, stdin });

        let app_ev = app.clone();
        let label_ev = label.clone();
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
                        let _ = app_ev.emit_to(&label_ev, "lsp-message", Message { id, message });
                    }
                    Ok(None) => break tr("El servidor de lenguaje se cerró").to_string(),
                    Err(e) => break e,
                }
            };
            let detail = stderr_reader.join().unwrap_or_default();
            let error = if detail.is_empty() { error } else { format!("{error}: {detail}") };
            let _ = app_ev.emit_to(&label_ev, "lsp-exit", Exit { id, error });
        });
        Ok(Started { id, mode, tsserver, notice })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_send(
    window: tauri::WebviewWindow,
    state: State<'_, LspState>,
    id: u64,
    message: serde_json::Value,
) -> Result<(), String> {
    let label = window.label().to_string();
    let bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    let stdin = {
        let guard = state.servers.lock().map_err(|e| e.to_string())?;
        let server = guard
            .iter()
            .find(|((l, _), s)| l == &label && s.id == id)
            .map(|(_, s)| s)
            .ok_or(tr("El servidor LSP ya no está activo"))?;
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
pub async fn lsp_stop(window: tauri::WebviewWindow, app: AppHandle, server: Option<String>) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<LspState>();
        if let Some(key) = server {
            st.stop_server(&label, &key);
        } else {
            st.stop_window(&label);
        }
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
    fn chooses_compat_only_for_projects_with_typescript_before_7() {
        let dir = std::env::temp_dir().join(format!("pulso-lsp-mode-{}", std::process::id()));
        let ts = dir.join("node_modules/typescript");
        let nested = dir.join("packages/app");
        std::fs::create_dir_all(ts.join("lib")).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(ts.join("lib/tsserver.js"), "").unwrap();

        std::fs::write(ts.join("package.json"), r#"{"version":"5.9.3"}"#).unwrap();
        let found = project_typescript(&nested);
        assert_eq!(found.as_ref().map(|f| f.0), Some(5), "se busca en las carpetas superiores");
        assert!(wants_compat(found.as_ref()));

        std::fs::write(ts.join("package.json"), r#"{"version":"7.0.2"}"#).unwrap();
        assert!(!wants_compat(project_typescript(&dir).as_ref()));

        // Una versión antigua sin tsserver.js (instalación rota) no puede usarse.
        std::fs::write(ts.join("package.json"), r#"{"version":"6.0.1"}"#).unwrap();
        std::fs::remove_file(ts.join("lib/tsserver.js")).unwrap();
        assert!(!wants_compat(project_typescript(&dir).as_ref()));

        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!wants_compat(None));
    }

    #[test]
    fn native_server_exists_for_this_platform_in_development() {
        let platform = native_platform().expect("plataforma con TypeScript nativo");
        let exe = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@typescript")
            .join(format!("typescript-{platform}"))
            .join("lib")
            .join(NATIVE_EXE);
        assert!(exe.is_file(), "falta {} (npm install)", exe.display());
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
