//! Terminal integrada: pseudo-terminales (ConPTY en Windows) con `portable-pty`.
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
    time::Duration,
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

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("No se pudo iniciar «{}»: {}", shell, e))?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => on_data(buf[..n].to_vec()),
            }
        }
    });
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        // Margen para que lleguen los últimos datos antes de avisar de que terminó.
        std::thread::sleep(Duration::from_millis(150));
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
            out.push(shell("cmd", "Símbolo del sistema", p, &[]));
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
pub fn term_shells() -> Vec<ShellInfo> {
    detect_shells()
}

// ---------- Comandos de Tauri ----------
#[derive(Default)]
pub struct TermState {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl TermState {
    pub fn kill_all(&self) {
        if let Ok(mut m) = self.sessions.lock() {
            for s in m.values_mut() {
                s.kill();
            }
            m.clear();
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
pub fn term_spawn(
    app: AppHandle,
    state: State<'_, TermState>,
    shell: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (a, b) = (app.clone(), app.clone());
    let session = spawn_session(
        &shell,
        &args,
        cwd.as_deref(),
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
    )?;
    state.sessions.lock().map_err(|e| e.to_string())?.insert(id, session);
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    let mut m = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = m.get_mut(&id).ok_or("La terminal ya no existe")?;
    s.write(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<'_, TermState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let m = state.sessions.lock().map_err(|e| e.to_string())?;
    match m.get(&id) {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

/// Cierra todas las terminales (al recargar la ventana quedarían shells sin pestaña).
#[tauri::command]
pub fn term_kill_all(state: State<'_, TermState>) {
    state.kill_all();
}

#[tauri::command]
pub fn term_kill(state: State<'_, TermState>, id: u32) -> Result<(), String> {
    let mut m = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = m.remove(&id) {
        s.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

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
}
