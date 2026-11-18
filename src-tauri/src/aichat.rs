//! Chat de IA con herramientas oficiales de línea de comandos (por ahora Claude Code).
//! La herramienta inicia sesión con la cuenta de la persona (por ejemplo su suscripción); Pulso nunca ve credenciales:
//! solo lanza el proceso en la carpeta del proyecto, le pasa el mensaje y reenvía su salida JSON línea a línea.
use super::background_command;
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::Stdio,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AiState {
    /// Identificador de la conversación en curso → pid del proceso.
    running: Mutex<HashMap<String, u32>>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AiTool {
    pub installed: bool,
    pub version: String,
    pub logged_in: bool,
    /// «claude.ai» (suscripción) o «console» (clave de API), según informa la herramienta.
    pub auth_method: String,
    /// Tipo de suscripción: pro, max…; vacío si no hay o no se sabe.
    pub plan: String,
    pub error: String,
}

/// Lee la salida JSON de `claude auth status`. No se devuelve el correo ni la organización: Pulso no los necesita.
pub fn parse_auth_status(text: &str) -> Option<(bool, String, String)> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let logged = v.get("loggedIn")?.as_bool()?;
    let method = v.get("authMethod").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let plan = v.get("subscriptionType").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some((logged, method, plan))
}

fn capture(program: &str, args: &[&str], secs: u64) -> Result<String, String> {
    let mut child = background_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or("sin salida")?;
    let reader = thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); s });
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if Instant::now() >= deadline => { let _ = child.kill(); let _ = child.wait(); return Err("tardó demasiado".into()); }
            None => thread::sleep(Duration::from_millis(30)),
        }
    }
    Ok(reader.join().unwrap_or_default())
}

fn detect_claude() -> AiTool {
    let program = claude_program();
    let version = match capture(&program, &["--version"], 15) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: "No se encontró Claude Code en este equipo.".into(), ..Default::default() },
    };
    let mut tool = AiTool { installed: true, version, ..Default::default() };
    match capture(&program, &["auth", "status"], 20).ok().and_then(|t| parse_auth_status(&t)) {
        Some((logged, method, plan)) => { tool.logged_in = logged; tool.auth_method = method; tool.plan = plan; }
        None => tool.error = "No se pudo comprobar si hay una sesión iniciada.".into(),
    }
    tool
}

#[tauri::command]
pub async fn ai_detect() -> Result<AiTool, String> {
    tauri::async_runtime::spawn_blocking(detect_claude).await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatOptions {
    pub session: Option<String>,
    pub model: Option<String>,
    /// «read» (solo leer) o «edit» (puede editar archivos).
    pub mode: String,
}

fn safe_token(s: &str) -> bool {
    // Sin guion inicial: un valor como «--help» se tomaría por una opción.
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '[' | ']'))
}

/// Programa que se ejecuta. Solo en compilaciones de desarrollo puede cambiarse con `PULSO_CLAUDE_BIN` (las pruebas usan una herramienta falsa);
/// en la aplicación instalada siempre es `claude`.
fn claude_program() -> String {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("PULSO_CLAUDE_BIN") { if !p.trim().is_empty() { return p; } }
    }
    "claude".to_string()
}

/// Argumentos de `claude` para una conversación. El mensaje va por la entrada estándar, no aquí.
pub fn build_claude_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    if let Some(s) = &o.session {
        if !safe_token(s) { return Err("Identificador de sesión no válido".into()); }
        a.push("--resume".into());
        a.push(s.clone());
    }
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) { return Err("Modelo no válido".into()); }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    let read_tools = "Read,Glob,Grep";
    match o.mode.as_str() {
        "read" => { a.extend(["--permission-mode", "default", "--allowedTools", read_tools].iter().map(|s| s.to_string())); }
        "edit" => { a.extend(["--permission-mode", "acceptEdits", "--allowedTools", "Read,Glob,Grep,Edit,Write,MultiEdit"].iter().map(|s| s.to_string())); }
        _ => return Err("Modo de permisos no válido".into()),
    }
    Ok(a)
}

const MAX_LINE: usize = 1_000_000;

/// Lanza `program` con `args` en `cwd`, le entrega `prompt` por la entrada estándar y llama a `on_line` por cada línea
/// de su salida; al terminar, a `on_exit` con el código y el final de su salida de error. Devuelve el pid.
pub fn spawn_stream(
    program: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
    on_line: Arc<dyn Fn(String) + Send + Sync>,
    on_exit: Arc<dyn Fn(Option<i32>, String) + Send + Sync>,
) -> Result<u32, String> {
    let mut child = background_command(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo iniciar {program}: {e}"))?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let out = child.stdout.take().ok_or("sin salida")?;
    let mut err = child.stderr.take().ok_or("sin salida de error")?;
    let err_thread = thread::spawn(move || { let mut b = Vec::new(); let _ = err.read_to_end(&mut b); String::from_utf8_lossy(&b).into_owned() });
    thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            on_line(if line.len() > MAX_LINE { "{\"type\":\"pulso_truncated\"}".to_string() } else { line });
        }
        let code = child.wait().ok().and_then(|s| s.code());
        let stderr = err_thread.join().unwrap_or_default();
        let tail: String = stderr.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
        on_exit(code, tail);
    });
    Ok(pid)
}

#[derive(Serialize, Clone)]
struct AiLine { id: String, line: String }
#[derive(Serialize, Clone)]
struct AiExit { id: String, code: Option<i32>, stderr: String }

#[tauri::command]
pub fn ai_send(app: AppHandle, state: State<AiState>, id: String, cwd: String, prompt: String, session: Option<String>, model: Option<String>, mode: String) -> Result<(), String> {
    if !safe_token(&id) { return Err("Identificador de conversación no válido".into()); }
    if !std::path::Path::new(&cwd).is_dir() { return Err("Abre una carpeta de proyecto para hablar con la IA.".into()); }
    if prompt.trim().is_empty() { return Err("El mensaje está vacío.".into()); }
    let args = build_claude_args(&ChatOptions { session, model, mode })?;
    if state.running.lock().map_err(|e| e.to_string())?.contains_key(&id) {
        return Err("Esta conversación ya está respondiendo.".into());
    }
    let (a1, a2, id1, id2) = (app.clone(), app.clone(), id.clone(), id.clone());
    let pid = spawn_stream(
        &claude_program(),
        &args,
        &cwd,
        &prompt,
        Arc::new(move |line| { let _ = a1.emit("ai-line", AiLine { id: id1.clone(), line }); }),
        Arc::new(move |code, stderr| {
            if let Some(st) = a2.try_state::<AiState>() { if let Ok(mut m) = st.running.lock() { m.remove(&id2); } }
            let _ = a2.emit("ai-exit", AiExit { id: id2.clone(), code, stderr });
        }),
    )?;
    state.running.lock().map_err(|e| e.to_string())?.insert(id, pid);
    Ok(())
}

#[tauri::command]
pub fn ai_stop(state: State<AiState>, id: String) -> Result<(), String> {
    let pid = state.running.lock().map_err(|e| e.to_string())?.get(&id).copied();
    let Some(pid) = pid else { return Ok(()) };
    let pid = pid.to_string();
    // Se corta el proceso y lo que haya lanzado (herramientas, servidores MCP).
    let _ = if cfg!(windows) {
        background_command("taskkill").args(["/PID", &pid, "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    } else {
        background_command("kill").args(["-TERM", &pid]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(mode: &str) -> ChatOptions { ChatOptions { session: None, model: None, mode: mode.into() } }

    #[test]
    fn lee_el_estado_de_la_sesion_sin_exponer_el_correo() {
        let t = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgName":"x","subscriptionType":"pro"}"#;
        assert_eq!(parse_auth_status(t), Some((true, "claude.ai".into(), "pro".into())));
        assert_eq!(parse_auth_status(r#"{"loggedIn":false}"#), Some((false, "".into(), "".into())));
        assert_eq!(parse_auth_status("no es json"), None);
        assert_eq!(parse_auth_status("{}"), None);
    }

    #[test]
    fn argumentos_de_solo_lectura_y_de_edicion() {
        let r = build_claude_args(&opts("read")).unwrap();
        assert!(r.starts_with(&["-p".to_string(), "--output-format".to_string(), "stream-json".to_string()]));
        assert!(r.contains(&"--include-partial-messages".to_string()));
        let at = r.iter().position(|x| x == "--permission-mode").unwrap();
        assert_eq!(r[at + 1], "default");
        assert_eq!(r[r.iter().position(|x| x == "--allowedTools").unwrap() + 1], "Read,Glob,Grep");
        let e = build_claude_args(&opts("edit")).unwrap();
        assert_eq!(e[e.iter().position(|x| x == "--permission-mode").unwrap() + 1], "acceptEdits");
        assert!(e.iter().any(|x| x.contains("Edit") && x.contains("Write")));
        assert!(!e.iter().any(|x| x.contains("Bash")), "nunca se permite ejecutar comandos");
        assert!(!e.iter().any(|x| x.contains("dangerously")));
    }

    #[test]
    fn sesion_y_modelo_se_validan_y_se_pasan() {
        let o = ChatOptions { session: Some("3f1e2c1a-aaaa-bbbb-cccc-1234567890ab".into()), model: Some("sonnet".into()), mode: "read".into() };
        let a = build_claude_args(&o).unwrap();
        assert_eq!(a[a.iter().position(|x| x == "--resume").unwrap() + 1], "3f1e2c1a-aaaa-bbbb-cccc-1234567890ab");
        assert_eq!(a[a.iter().position(|x| x == "--model").unwrap() + 1], "sonnet");
        for malo in ["x; rm -rf /", "a b", "--help", "$(x)"] {
            assert!(build_claude_args(&ChatOptions { session: Some(malo.into()), model: None, mode: "read".into() }).is_err(), "{malo}");
            assert!(build_claude_args(&ChatOptions { session: None, model: Some(malo.into()), mode: "read".into() }).is_err(), "{malo}");
        }
        assert!(build_claude_args(&opts("todo")).is_err());
        assert!(!build_claude_args(&ChatOptions { session: None, model: Some("".into()), mode: "read".into() }).unwrap().contains(&"--model".to_string()));
    }

    #[test]
    fn el_proceso_recibe_el_mensaje_por_stdin_y_sus_lineas_llegan_en_orden() {
        let (program, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd", vec!["/C".into(), "more".into()]) } else { ("cat", vec![]) };
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let done = Arc::new(Mutex::new(None::<Option<i32>>));
        let (l2, d2) = (lines.clone(), done.clone());
        let cwd = std::env::temp_dir();
        spawn_stream(program, &args, &cwd.to_string_lossy(), "hola\nmundo\n", Arc::new(move |l| l2.lock().unwrap().push(l)), Arc::new(move |c, _| { *d2.lock().unwrap() = Some(c); })).unwrap();
        let t = Instant::now();
        while done.lock().unwrap().is_none() && t.elapsed().as_secs() < 15 { thread::sleep(Duration::from_millis(20)); }
        assert_eq!(*done.lock().unwrap(), Some(Some(0)));
        let got: Vec<String> = lines.lock().unwrap().iter().map(|l| l.trim().to_string()).collect();
        assert_eq!(got, ["hola", "mundo"]);
    }

    #[test]
    fn un_programa_que_no_existe_se_explica() {
        let err = spawn_stream("pulso-no-existe-xyz", &[], &std::env::temp_dir().to_string_lossy(), "x", Arc::new(|_| {}), Arc::new(|_, _| {})).unwrap_err();
        assert!(err.contains("No se pudo iniciar"), "{err}");
    }
}
