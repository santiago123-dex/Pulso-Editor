//! Terminal integrada: pseudo-terminales (ConPTY en Windows) con `portable-pty`.
use crate::i18n::{tr, trf};
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

/// Una terminal en marcha: el extremo maestro del pty, su entrada y el modo de detener el proceso.
pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    pub fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

/// Lanza `shell` dentro de un pseudo-terminal. `on_data` recibe la salida tal cual (bytes) y
/// `on_exit` el código de salida cuando el proceso termina. No depende de Tauri para poder probarse.
pub fn spawn_session(
    shell: &str,
    args: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce(i32) + Send + 'static,
) -> Result<Session, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell);
    cmd.args(args);
    if let Some(dir) = cwd.filter(|d| Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "pulso");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| trf("No se pudo iniciar «{shell}»: {e}", &[("shell", &shell), ("e", &e)]))?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => on_data(buf[..n].to_vec()),
            }
        }
        let _ = done_tx.send(());
    });
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        // Esperar con límite acotado a que drene el lector antes de emitir salida (en ConPTY el lector
        // puede bloquearse hasta soltar el maestro en `on_exit`, así que nunca bloqueamos indefinidamente).
        let _ = done_rx.recv_timeout(std::time::Duration::from_millis(120));
        on_exit(code);
    });

    Ok(Session { master: pair.master, writer, killer })
}

// ---------- Shells disponibles ----------
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub args: Vec<String>,
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file())
}

fn shell(id: &str, label: &str, path: PathBuf, args: &[&str]) -> ShellInfo {
    ShellInfo {
        id: id.to_string(),
        label: label.to_string(),
        path: path.to_string_lossy().into_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
    }
}

/// Shells instalados, el recomendado primero.
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut out: Vec<ShellInfo> = Vec::new();
    #[cfg(windows)]
    {
        if let Some(p) = find_in_path("pwsh.exe") {
            out.push(shell("pwsh", "PowerShell 7", p, &["-NoLogo"]));
        }
        let ps = find_in_path("powershell.exe")
            .or_else(|| Some(PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")).filter(|p| p.is_file()));
        if let Some(p) = ps {
            out.push(shell("powershell", "Windows PowerShell", p, &["-NoLogo"]));
        }
        let cmd = std::env::var_os("COMSPEC").map(PathBuf::from).filter(|p| p.is_file()).or_else(|| find_in_path("cmd.exe"));
        if let Some(p) = cmd {
            out.push(shell("cmd", tr("Símbolo del sistema"), p, &[]));
        }
        for base in [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"] {
            let p = PathBuf::from(base);
            if p.is_file() {
                out.push(shell("gitbash", "Git Bash", p, &["--login", "-i"]));
                break;
            }
        }
        if let Some(p) = find_in_path("wsl.exe") {
            out.push(shell("wsl", "WSL", p, &[]));
        }
    }
    #[cfg(not(windows))]
    {
        let mut seen: Vec<PathBuf> = Vec::new();
        let mut add = |id: &str, label: &str, p: PathBuf, out: &mut Vec<ShellInfo>| {
            if p.is_file() && !seen.contains(&p) {
                seen.push(p.clone());
                out.push(shell(id, label, p, &["-l"]));
            }
        };
        if let Some(s) = std::env::var_os("SHELL") {
            add("default", "Shell predeterminada", PathBuf::from(s), &mut out);
        }
        for (id, name) in [("bash", "bash"), ("zsh", "zsh"), ("fish", "fish"), ("sh", "sh")] {
            if let Some(p) = find_in_path(name) {
                add(id, name, p, &mut out);
            }
        }
    }
    out
}

#[tauri::command]
pub async fn term_shells() -> Result<Vec<ShellInfo>, String> {
    tauri::async_runtime::spawn_blocking(detect_shells).await.map_err(|e| e.to_string())
}

/// Resuelve la shell solicitada estrictamente contra la lista detectada del sistema (allowlist).
pub fn resolve_allowed_shell(
    available: &[ShellInfo],
    shell_id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<ShellInfo, String> {
    if let Some(id) = shell_id.map(str::trim).filter(|s| !s.is_empty()) {
        return available
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| trf("Shell no permitida o no disponible: «{id}»", &[("id", &id)]));
    }
    if let Some(path) = legacy_path.map(str::trim).filter(|s| !s.is_empty()) {
        return available
            .iter()
            .find(|s| s.path == path || s.id == path)
            .cloned()
            .ok_or_else(|| tr("La shell solicitada no está en la lista de shells autorizadas").into());
    }
    available
        .first()
        .cloned()
        .ok_or_else(|| tr("No se encontró ninguna shell instalada").into())
}

// ---------- Comandos de Tauri ----------
enum TermSlot {
    Starting,
    Active(Arc<Mutex<Session>>),
}

#[derive(Default)]
pub struct TermState {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, TermSlot>>,
}

impl TermState {
    pub fn kill_all(&self) {
        let active: Vec<Arc<Mutex<Session>>> = match self.sessions.lock() {
            Ok(mut m) => m
                .drain()
                .filter_map(|(_, slot)| match slot {
                    TermSlot::Active(s) => Some(s),
                    TermSlot::Starting => None,
                })
                .collect(),
            Err(_) => return,
        };
        for s in active {
            if let Ok(mut guard) = s.lock() {
                guard.kill();
            }
        }
    }
}

#[derive(Serialize, Clone)]
struct DataEvent {
    id: u32,
    /// Salida del proceso en base64 (los bytes pueden cortar un carácter UTF-8 a la mitad).
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: u32,
    code: i32,
}

#[tauri::command]
pub async fn term_spawn(
    app: AppHandle,
    state: State<'_, TermState>,
    guard: State<'_, crate::fsguard::WorkspaceGuard>,
    shell_id: Option<String>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    // Validar cwd contra el workspace si se proporcionó.
    let safe_cwd: Option<String> = match cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => match guard.ensure_dir(dir) {
            Ok(canon) => Some(canon.to_string_lossy().into_owned()),
            Err(_) => guard.current_root().map(|p| p.to_string_lossy().into_owned()),
        },
        None => guard.current_root().map(|p| p.to_string_lossy().into_owned()),
    };

    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    // Reservar el slot antes de spawnear evita carreras si el proceso sale de inmediato.
    state.sessions.lock().map_err(|e| e.to_string())?.insert(id, TermSlot::Starting);

    let (a, b) = (app.clone(), app.clone());
    let app_for_spawn = app.clone();
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        let available = detect_shells();
        let chosen = resolve_allowed_shell(&available, shell_id.as_deref(), shell.as_deref())?;
        spawn_session(
            &chosen.path,
            &chosen.args,
            safe_cwd.as_deref(),
            cols,
            rows,
            move |bytes| {
                let _ = a.emit("term-data", DataEvent { id, data: STANDARD.encode(bytes) });
            },
            move |code| {
                let _ = b.emit("term-exit", ExitEvent { id, code });
                // Soltar la sesión cierra el pty y libera el hilo lector (en Windows no termina antes).
                if let Some(st) = b.try_state::<TermState>() {
                    if let Ok(mut m) = st.sessions.lock() {
                        m.remove(&id);
                    }
                }
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let st = app_for_spawn.state::<TermState>();
    match spawned {
        Ok(session) => {
            let mut m = st.sessions.lock().map_err(|e| e.to_string())?;
            // Si on_exit ya removió el slot mientras spawneaba, cerramos la sesión limpia y no la re-insertamos.
            if matches!(m.get(&id), Some(TermSlot::Starting)) {
                m.insert(id, TermSlot::Active(Arc::new(Mutex::new(session))));
            } else {
                let mut s = session;
                s.kill();
            }
            Ok(id)
        }
        Err(e) => {
            if let Ok(mut m) = st.sessions.lock() {
                m.remove(&id);
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn term_write(state: State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    let session = {
        let m = state.sessions.lock().map_err(|e| e.to_string())?;
        match m.get(&id) {
            Some(TermSlot::Active(s)) => Arc::clone(s),
            _ => return Err(tr("La terminal ya no existe").into()),
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        s.write(data.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn term_resize(state: State<'_, TermState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = {
        let m = state.sessions.lock().map_err(|e| e.to_string())?;
        match m.get(&id) {
            Some(TermSlot::Active(s)) => Some(Arc::clone(s)),
            _ => None,
        }
    };
    let Some(session) = session else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || {
        let s = session.lock().map_err(|e| e.to_string())?;
        s.resize(cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cierra todas las terminales (al recargar la ventana quedarían shells sin pestaña).
#[tauri::command]
pub async fn term_kill_all(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<TermState>().kill_all();
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn term_kill(state: State<'_, TermState>, id: u32) -> Result<(), String> {
    let removed = {
        let mut m = state.sessions.lock().map_err(|e| e.to_string())?;
        m.remove(&id)
    };
    if let Some(TermSlot::Active(session)) = removed {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut s) = session.lock() {
                s.kill();
            }
        })
        .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[cfg(windows)]
    fn shell_cmd(script: &str) -> (&'static str, Vec<String>) {
        ("cmd.exe", vec!["/c".into(), script.into()])
    }
    #[cfg(not(windows))]
    fn shell_cmd(script: &str) -> (&'static str, Vec<String>) {
        ("sh", vec!["-c".into(), script.into()])
    }
    #[cfg(windows)]
    fn interactive() -> (&'static str, Vec<String>) {
        ("cmd.exe", vec![])
    }
    #[cfg(not(windows))]
    fn interactive() -> (&'static str, Vec<String>) {
        ("sh", vec![])
    }

    #[test]
    fn allowlist_rejects_arbitrary_executables() {
        let avail = vec![
            ShellInfo { id: "bash".into(), label: "bash".into(), path: "/bin/bash".into(), args: vec!["-l".into()] },
        ];
        assert_eq!(resolve_allowed_shell(&avail, Some("bash"), None).unwrap().path, "/bin/bash");
        assert!(resolve_allowed_shell(&avail, Some("evil"), None).is_err());
        assert!(resolve_allowed_shell(&avail, None, Some("/usr/bin/python3")).is_err());
        assert_eq!(resolve_allowed_shell(&avail, None, None).unwrap().id, "bash");
    }

    enum Msg {
        Data(Vec<u8>),
        Exit(i32),
    }

    fn start(shell: &str, args: &[String], cwd: Option<&str>) -> (Session, mpsc::Receiver<Msg>) {
        let (tx, rx) = mpsc::channel();
        let tx2 = tx.clone();
        let s = spawn_session(shell, args, cwd, 80, 24, move |b| { let _ = tx.send(Msg::Data(b)); }, move |c| { let _ = tx2.send(Msg::Exit(c)); })
            .expect("el shell debe iniciar");
        (s, rx)
    }

    /// ConPTY de Windows pregunta la posición del cursor (ESC[6n) y espera la respuesta antes de
    /// seguir; una terminal real (xterm.js) contesta sola. Aquí lo hacemos a mano.
    fn answer_cursor_query(s: &mut Session, data: &[u8]) {
        if data.windows(4).any(|w| w == b"\x1b[6n") {
            let _ = s.write(b"\x1b[1;1R");
        }
    }

    /// Recoge la salida hasta que el proceso termina (o vence el plazo).
    fn collect(s: &mut Session, rx: &mpsc::Receiver<Msg>, secs: u64) -> (String, Option<i32>) {
        let end = Instant::now() + Duration::from_secs(secs);
        let mut out = Vec::new();
        let mut code = None;
        while Instant::now() < end {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Msg::Data(b)) => { answer_cursor_query(s, &b); out.extend(b); }
                Ok(Msg::Exit(c)) => { code = Some(c); break; }
                Err(_) => {}
            }
        }
        while let Ok(Msg::Data(b)) = rx.recv_timeout(Duration::from_millis(250)) {
            answer_cursor_query(s, &b);
            out.extend(b);
        }
        (String::from_utf8_lossy(&out).into_owned(), code)
    }

    #[test]
    fn runs_a_command_and_reports_exit_code_zero() {
        let (sh, args) = shell_cmd("echo pulso-pty-ok");
        let (mut s, rx) = start(sh, &args, None);
        let (out, code) = collect(&mut s, &rx, 15);
        assert!(out.contains("pulso-pty-ok"), "salida: {:?}", out);
        assert_eq!(code, Some(0));
    }

    #[test]
    fn propagates_a_nonzero_exit_code() {
        let (sh, args) = shell_cmd("exit 7");
        let (mut s, rx) = start(sh, &args, None);
        let (_, code) = collect(&mut s, &rx, 15);
        assert_eq!(code, Some(7));
    }

    #[test]
    fn delivers_typed_input_to_the_shell() {
        let (sh, args) = interactive();
        let (mut s, rx) = start(sh, &args, None);
        std::thread::sleep(Duration::from_millis(600));
        s.write(b"echo hola-entrada\r\n").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        s.write(b"exit\r\n").unwrap();
        let (out, code) = collect(&mut s, &rx, 15);
        assert!(out.contains("hola-entrada"), "salida: {:?}", out);
        assert_eq!(code, Some(0));
    }

    #[test]
    fn starts_in_the_requested_directory() {
        let dir = std::env::temp_dir().join(format!("pulso-pty-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        #[cfg(windows)]
        let script = "cd";
        #[cfg(not(windows))]
        let script = "pwd";
        let (sh, args) = shell_cmd(script);
        let (mut s, rx) = start(sh, &args, Some(&dir.to_string_lossy()));
        let (out, _) = collect(&mut s, &rx, 15);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.contains(&name), "salida: {:?}", out);
    }

    #[test]
    fn a_missing_directory_falls_back_instead_of_failing() {
        let (sh, args) = shell_cmd("echo sigue");
        let (mut s, rx) = start(sh, &args, Some("Z:/no/existe/nunca"));
        let (out, code) = collect(&mut s, &rx, 15);
        assert!(out.contains("sigue"), "salida: {:?}", out);
        assert_eq!(code, Some(0));
    }

    #[test]
    fn kill_stops_a_long_running_shell() {
        let (sh, args) = interactive();
        let (mut s, rx) = start(sh, &args, None);
        std::thread::sleep(Duration::from_millis(600));
        s.kill();
        let (_, code) = collect(&mut s, &rx, 15);
        assert!(code.is_some(), "debe avisar de que terminó");
    }

    #[test]
    fn resize_works_while_running() {
        let (sh, args) = interactive();
        let (mut s, rx) = start(sh, &args, None);
        std::thread::sleep(Duration::from_millis(400));
        assert!(s.resize(120, 40).is_ok());
        assert!(s.resize(0, 0).is_ok(), "tamaños nulos se corrigen a 1x1");
        s.kill();
        let _ = collect(&mut s, &rx, 10);
    }

    #[test]
    fn an_unknown_shell_reports_an_error() {
        let r = spawn_session("no-existe-xyz-123", &[], None, 80, 24, |_| {}, |_| {});
        assert!(r.is_err());
    }

    #[test]
    fn utf8_output_is_preserved_byte_for_byte() {
        #[cfg(windows)]
        let (sh, args) = ("powershell.exe", vec!["-NoProfile".to_string(), "-Command".to_string(), "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output 'ñandú-ü-é'".to_string()]);
        #[cfg(not(windows))]
        let (sh, args) = ("sh", vec!["-c".to_string(), "printf 'ñandú-ü-é'".to_string()]);
        let (mut s, rx) = start(sh, &args, None);
        let (out, _) = collect(&mut s, &rx, 20);
        assert!(out.contains("ñandú-ü-é"), "salida: {:?}", out);
    }

    #[test]
    fn detects_at_least_one_shell_and_all_paths_exist() {
        let shells = detect_shells();
        assert!(!shells.is_empty(), "debe haber una shell instalada");
        for s in &shells {
            assert!(Path::new(&s.path).is_file(), "{} no existe", s.path);
            assert!(!s.label.is_empty() && !s.id.is_empty());
        }
        let ids: Vec<&String> = shells.iter().map(|s| &s.id).collect();
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(ids.len(), unique.len(), "ids repetidos");
    }

    #[test]
    fn data_events_roundtrip_through_base64() {
        let bytes = vec![0xC3, 0xB1, 0xFF, 0x00, 0x1B, b'['];
        assert_eq!(STANDARD.decode(STANDARD.encode(&bytes)).unwrap(), bytes);
    }

    fn drain_and_answer(s: &mut Session, rx: &mpsc::Receiver<Msg>, millis: u64, out: &mut String) {
        let end = Instant::now() + Duration::from_millis(millis);
        while Instant::now() < end {
            match rx.recv_timeout(Duration::from_millis(40)) {
                Ok(Msg::Data(b)) => {
                    answer_cursor_query(s, &b);
                    out.push_str(&String::from_utf8_lossy(&b));
                }
                Ok(Msg::Exit(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    #[test]
    fn ctrl_c_interrupts_a_running_command_in_shell() {
        let (sh, args) = interactive();
        let (mut s, rx) = start(sh, &args, None);
        let mut log = String::new();
        drain_and_answer(&mut s, &rx, 1000, &mut log);
        #[cfg(windows)]
        s.write(b"ping -n 30 127.0.0.1\r\n").unwrap();
        #[cfg(not(windows))]
        s.write(b"sleep 30\r\n").unwrap();
        drain_and_answer(&mut s, &rx, 1200, &mut log);
        s.write(b"\x03").unwrap();
        drain_and_answer(&mut s, &rx, 700, &mut log);
        s.write(b"echo after-ctrl-c\r\n").unwrap();
        drain_and_answer(&mut s, &rx, 500, &mut log);
        s.write(b"exit 0\r\n").unwrap();
        let (rest, code) = collect(&mut s, &rx, 10);
        log.push_str(&rest);
        assert!(log.contains("after-ctrl-c"), "el comando no se interrumpio con Ctrl+C: {:?}", log);
        assert_eq!(code, Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn ctrl_c_interrupts_powershell_command() {
        let (mut s, rx) = start("powershell.exe", &["-NoLogo".into()], None);
        let mut log = String::new();
        drain_and_answer(&mut s, &rx, 1800, &mut log);
        s.write(b"Start-Sleep -Seconds 30\r\n").unwrap();
        drain_and_answer(&mut s, &rx, 1000, &mut log);
        s.write(b"\x03").unwrap();
        drain_and_answer(&mut s, &rx, 800, &mut log);
        s.write(b"Write-Output ps-after-ctrl-c\r\n").unwrap();
        drain_and_answer(&mut s, &rx, 600, &mut log);
        s.write(b"exit\r\n").unwrap();
        let (rest, code) = collect(&mut s, &rx, 10);
        log.push_str(&rest);
        assert!(log.contains("ps-after-ctrl-c"), "powershell no se interrumpio con Ctrl+C: {:?}", log);
        assert_eq!(code, Some(0));
    }
}
