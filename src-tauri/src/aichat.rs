//! Chat de IA con herramientas oficiales de línea de comandos (por ahora Claude Code).
//! La herramienta inicia sesión con la cuenta de la persona (por ejemplo su suscripción); Pulso nunca ve credenciales:
//! solo lanza el proceso en la carpeta del proyecto, le pasa el mensaje y reenvía su salida JSON línea a línea.
use crate::i18n::{tr, trf};
use super::background_command;
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

enum AiSlot {
    Starting,
    Running(u32),
    /// Agente local (Ollama) dentro de Pulso: se detiene con esta bandera, no matando un proceso.
    Local(Arc<std::sync::atomic::AtomicBool>),
}

#[derive(Default)]
pub struct AiState {
    /// Identificador de la conversación en curso → estado o pid del proceso.
    running: Mutex<HashMap<String, AiSlot>>,
}

impl AiState {
    pub fn stop_all(&self) {
        let pids: Vec<u32> = self
            .running
            .lock()
            .map(|mut m| {
                m.drain()
                    .filter_map(|(_, slot)| match slot {
                        AiSlot::Running(p) => Some(p),
                        AiSlot::Local(flag) => {
                            flag.store(true, std::sync::atomic::Ordering::Relaxed);
                            None
                        }
                        AiSlot::Starting => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        for pid in pids {
            kill_pid(pid);
        }
    }
}

fn kill_pid(pid: u32) {
    crate::procguard::kill_tree(pid);
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AiModelInfo {
    pub id: String,
    pub label: String,
    pub note: String,
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
    pub models: Vec<AiModelInfo>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct WindowQuota {
    pub used_percent: f64,
    pub resets_at: i64,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct CodexQuota {
    pub plan: String,
    pub five_hour: Option<WindowQuota>,
    pub seven_day: Option<WindowQuota>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AntigravityBucket {
    pub id: String,
    pub name: String,
    pub window: String,
    pub remaining_fraction: f64,
    pub reset_time: String,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AntigravityQuotaGroup {
    pub name: String,
    pub description: String,
    pub buckets: Vec<AntigravityBucket>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AntigravityUsage {
    pub groups: Vec<AntigravityQuotaGroup>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct ExtraUsage {
    pub codex: Option<CodexQuota>,
    pub antigravity: Option<AntigravityUsage>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AllAiTools {
    pub claude: AiTool,
    pub codex: AiTool,
    pub antigravity: AiTool,
    pub local: AiTool,
}

/// Lee la salida JSON de `claude auth status`. No se devuelve el correo ni la organización: Pulso no los necesita.
pub fn parse_auth_status(text: &str) -> Option<(bool, String, String)> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let logged = v.get("loggedIn")?.as_bool()?;
    let method = v.get("authMethod").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let plan = v.get("subscriptionType").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some((logged, method, plan))
}

/// Interpreta `codex login status` sin exponer claves ni tokens.
pub fn parse_codex_login_status(ok: bool, text: &str) -> (bool, String, String) {
    let low = text.to_lowercase();
    if !ok || low.contains("not logged in") {
        return (false, String::new(), String::new());
    }
    if low.contains("api key") {
        return (true, "api_key".into(), "API".into());
    }
    if low.contains("chatgpt") {
        return (true, "chatgpt".into(), "ChatGPT".into());
    }
    (true, "codex".into(), "ChatGPT".into())
}

/// Comprueba si Gemini CLI tiene sesión OAuth local o clave configurada sin devolver credenciales.
pub fn gemini_auth_from(home: Option<&Path>, has_api_key: bool, has_vertex: bool) -> (bool, String, String) {
    if has_api_key {
        return (true, "api_key".into(), "API".into());
    }
    if has_vertex {
        return (true, "vertex".into(), "Vertex".into());
    }
    if let Some(dir) = home.map(|h| h.join(".gemini")) {
        let mut accounts_logged_out = false;
        let accounts = dir.join("google_accounts.json");
        if let Ok(raw) = std::fs::read_to_string(&accounts) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                match v.get("active").and_then(|x| x.as_str()).map(|s| s.trim().is_empty()) {
                    Some(false) => return (true, "google".into(), "Google".into()),
                    _ => accounts_logged_out = true,
                }
            }
        }
        let oauth = dir.join("oauth_creds.json");
        if std::fs::read_to_string(&oauth).ok().is_some_and(|s| {
            let t = s.trim();
            t.len() > 2 && t != "{}"
        }) {
            return (true, "google".into(), "Google".into());
        }
        if !accounts_logged_out {
            let settings = dir.join("settings.json");
            if let Ok(raw) = std::fs::read_to_string(&settings) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let kind = v.get("security")
                        .and_then(|s| s.get("auth"))
                        .and_then(|a| a.get("selectedType"))
                        .or_else(|| v.get("selectedAuthType"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    match kind {
                        "oauth-personal" | "login-with-google" => return (true, "google".into(), "Google".into()),
                        "gemini-api-key" => return (true, "api_key".into(), "API".into()),
                        "vertex-ai" => return (true, "vertex".into(), "Vertex".into()),
                        _ => {}
                    }
                }
            }
        }
    }
    (false, String::new(), String::new())
}

fn capture_status(program: &str, args: &[String], secs: u64) -> Result<(bool, String), String> {
    let mut child = background_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let mut err = child.stderr.take().ok_or(tr("sin salida de error"))?;
    let r_out = thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); s });
    let r_err = thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break st,
            None if Instant::now() >= deadline => { let _ = child.kill(); let _ = child.wait(); return Err(tr("tardó demasiado").into()); }
            None => thread::sleep(Duration::from_millis(30)),
        }
    };
    let stdout = r_out.join().unwrap_or_default();
    let stderr = r_err.join().unwrap_or_default();
    let combined = if stdout.trim().is_empty() { stderr } else { stdout };
    Ok((status.success(), combined))
}

fn capture(program: &str, args: &[&str], secs: u64) -> Result<String, String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    capture_vec(program, &owned, secs)
}

fn capture_vec(program: &str, args: &[String], secs: u64) -> Result<String, String> {
    let mut child = background_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let reader = thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); s });
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if Instant::now() >= deadline => { let _ = child.kill(); let _ = child.wait(); return Err(tr("tardó demasiado").into()); }
            None => thread::sleep(Duration::from_millis(30)),
        }
    }
    Ok(reader.join().unwrap_or_default())
}

fn detect_claude() -> AiTool {
    let program = claude_program();
    let version = match capture(&program, &["--version"], 15) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: tr("No se encontró Claude Code en este equipo.").into(), ..Default::default() },
    };
    let mut tool = AiTool { installed: true, version, ..Default::default() };
    match capture(&program, &["auth", "status"], 20).ok().and_then(|t| parse_auth_status(&t)) {
        Some((logged, method, plan)) => { tool.logged_in = logged; tool.auth_method = method; tool.plan = plan; }
        None => tool.error = tr("No se pudo comprobar si hay una sesión iniciada.").into(),
    }
    tool
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Busca el punto de entrada JS de un paquete npm global (`package.json` → `bin`) para ejecutarlo con `node` sin pasar por `.cmd`.
pub fn npm_bin_js(npm_dir: &Path, pkg: &str, bin_name: &str) -> Option<PathBuf> {
    let mut pkg_dir = npm_dir.join("node_modules");
    for part in pkg.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        pkg_dir = pkg_dir.join(part);
    }
    let raw = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let rel = match v.get("bin")? {
        serde_json::Value::String(s) => s.as_str(),
        serde_json::Value::Object(map) => map.get(bin_name).and_then(|x| x.as_str())?,
        _ => return None,
    };
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let candidate = pkg_dir.join(rel_path);
    let canon_pkg = std::fs::canonicalize(&pkg_dir).ok()?;
    let canon_cand = std::fs::canonicalize(&candidate).ok()?;
    (canon_cand.starts_with(&canon_pkg) && canon_cand.is_file()).then_some(canon_cand)
}

fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("agy").join("bin"));
        dirs.push(local.join("Programs").join("OpenAI").join("Codex").join("bin"));
        dirs.push(local.join("Microsoft").join("WindowsApps"));
        dirs.push(local.join("pnpm"));
        dirs.push(local.join("Programs").join("nodejs"));
    }
    for var in ["PNPM_HOME", "NVM_SYMLINK", "BUN_INSTALL"] {
        if let Some(v) = std::env::var_os(var) {
            let p = PathBuf::from(v);
            dirs.push(if var == "BUN_INSTALL" { p.join("bin") } else { p });
        }
    }
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    }
    if let Some(home) = user_home() {
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    dirs
}

pub fn node_program(hint_dir: &Path) -> String {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let sibling = hint_dir.join(exe);
    if sibling.is_file() {
        return sibling.to_string_lossy().into_owned();
    }
    for dir in extra_bin_dirs() {
        let c = dir.join(exe);
        if c.is_file() {
            return c.to_string_lossy().into_owned();
        }
    }
    if cfg!(windows) {
        for fixed in [r"C:\nvm4w\nodejs\node.exe", r"C:\Program Files\nodejs\node.exe", r"C:\Program Files (x86)\nodejs\node.exe"] {
            if Path::new(fixed).is_file() { return fixed.to_string(); }
        }
    }
    "node".to_string()
}

/// Resuelve una CLI global buscando ejecutables nativos y paquetes npm `.js`/`.cmd` fuera del `PATH` heredado de GUI.
pub fn resolve_cli(name: &str, env_var: &str, npm_pkg: Option<&str>) -> (String, Vec<String>) {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var(env_var) {
            if !p.trim().is_empty() { return (p, Vec::new()); }
        }
    }
    let dirs = extra_bin_dirs();
    if cfg!(windows) {
        let exe = format!("{name}.exe");
        for dir in &dirs {
            let p = dir.join(&exe);
            if p.is_file() { return (p.to_string_lossy().into_owned(), Vec::new()); }
        }
        if let Some(pkg) = npm_pkg {
            for dir in &dirs {
                if let Some(js) = npm_bin_js(dir, pkg, name) {
                    return (node_program(dir), vec![js.to_string_lossy().into_owned()]);
                }
            }
        }
        for ext in ["cmd", "bat"] {
            let shim = format!("{name}.{ext}");
            for dir in &dirs {
                let p = dir.join(&shim);
                if p.is_file() { return (p.to_string_lossy().into_owned(), Vec::new()); }
            }
        }
    } else {
        for dir in &dirs {
            let p = dir.join(name);
            if p.is_file() { return (p.to_string_lossy().into_owned(), Vec::new()); }
        }
    }
    (name.to_string(), Vec::new())
}

fn with_prefix(prefix: &[String], rest: &[&str]) -> Vec<String> {
    let mut all = prefix.to_vec();
    all.extend(rest.iter().map(|s| s.to_string()));
    all
}

/// Lee los modelos disponibles de la cuenta ChatGPT en `~/.codex/models_cache.json` (respaldo sin `app-server`).
pub fn read_codex_models_from(home: Option<&Path>) -> Vec<AiModelInfo> {
    let Some(path) = home.map(|h| h.join(".codex").join("models_cache.json")) else { return Vec::new(); };
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new(); };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return Vec::new(); };
    let Some(arr) = v.get("models").and_then(|x| x.as_array()) else { return Vec::new(); };
    let mut out = Vec::new();
    for m in arr {
        let vis = m.get("visibility").and_then(|x| x.as_str()).unwrap_or("list");
        if vis == "hide" { continue; }
        let Some(id) = m.get("slug").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()) else { continue; };
        let label = m.get("display_name").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(id).to_string();
        let note = m.get("description").and_then(|x| x.as_str()).map(str::trim).unwrap_or("").to_string();
        if !out.iter().any(|x: &AiModelInfo| x.id == id) {
            out.push(AiModelInfo { id: id.to_string(), label, note });
        }
    }
    out
}

#[derive(Debug, Default)]
struct CodexServerSnapshot {
    logged_in: bool,
    auth_method: String,
    plan: String,
    models: Vec<AiModelInfo>,
    quota: Option<CodexQuota>,
}

/// Interpreta `account/read` del protocolo JSON-RPC de `codex app-server`.
pub fn parse_codex_app_account(v: &serde_json::Value) -> (bool, String, String) {
    let Some(acc) = v.get("result").and_then(|r| r.get("account")).filter(|a| !a.is_null()) else {
        return (false, String::new(), String::new());
    };
    let kind = acc.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let plan = acc.get("planType").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    match kind {
        "chatgpt" => (true, "chatgpt".into(), if plan.is_empty() { "ChatGPT".into() } else { plan }),
        "apiKey" => (true, "api_key".into(), "API".into()),
        "" => (false, String::new(), String::new()),
        _ => (true, kind.to_string(), plan),
    }
}

/// Interpreta `model/list` de `codex app-server`: visibles primero, luego los ocultos/heredados etiquetados.
pub fn parse_codex_app_models(v: &serde_json::Value) -> Vec<AiModelInfo> {
    let Some(arr) = v.get("result").and_then(|r| r.get("data")).and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut visible = Vec::new();
    let mut hidden = Vec::new();
    for m in arr {
        let Some(id) = m.get("model").or_else(|| m.get("id")).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()) else { continue; };
        let label = m.get("displayName").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(id).to_string();
        let desc = m.get("description").and_then(|x| x.as_str()).map(str::trim).unwrap_or("");
        let is_hidden = m.get("hidden").and_then(|x| x.as_bool()).unwrap_or(false);
        let note = if is_hidden {
            if desc.is_empty() { "legacy".to_string() } else { format!("{desc} [legacy]") }
        } else {
            desc.to_string()
        };
        if !visible.iter().any(|x: &AiModelInfo| x.id == id) && !hidden.iter().any(|x: &AiModelInfo| x.id == id) {
            let item = AiModelInfo { id: id.to_string(), label, note };
            if is_hidden { hidden.push(item); } else { visible.push(item); }
        }
    }
    visible.extend(hidden);
    visible
}

fn parse_app_window(v: Option<&serde_json::Value>) -> Option<WindowQuota> {
    let o = v?.as_object()?;
    let used = o.get("usedPercent")?.as_f64()?;
    let resets = o.get("resetsAt").and_then(|x| x.as_i64()).unwrap_or(0);
    Some(WindowQuota { used_percent: used.clamp(0.0, 100.0), resets_at: resets })
}

/// Interpreta `account/rateLimits/read` de `codex app-server`.
pub fn parse_codex_app_rate_limits(v: &serde_json::Value) -> Option<CodexQuota> {
    let rl = v.get("result").and_then(|r| r.get("rateLimits"))?;
    let five = parse_app_window(rl.get("primary"));
    let week = parse_app_window(rl.get("secondary"));
    if five.is_none() && week.is_none() { return None; }
    let plan = rl.get("planType").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    Some(CodexQuota { plan, five_hour: five, seven_day: week })
}

/// Consulta en vivo estado de cuenta, catálogo de modelos y cuotas reales vía `codex app-server` (el mismo motor de Codex Desktop).
fn codex_app_server_snapshot(program: &str, prefix: &[String], want_models: bool, want_limits: bool) -> Option<CodexServerSnapshot> {
    let args = with_prefix(prefix, &["app-server"]);
    let mut child = background_command(program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() && tx.send(line).is_err() { break; }
        }
    });

    let init = r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"pulso-editor","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}"#;
    if writeln!(stdin, "{init}").is_err() || stdin.flush().is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut snap = CodexServerSnapshot::default();
    let mut initialized = false;
    let mut got_acc = false;
    let mut got_models = !want_models;
    let mut got_limits = !want_limits;

    while Instant::now() < deadline && !(got_acc && got_models && got_limits) {
        let rem = deadline.saturating_duration_since(Instant::now());
        let Ok(line) = rx.recv_timeout(rem.min(Duration::from_millis(200))) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(id) = v.get("id").and_then(|x| x.as_u64()) else { continue };
        match id {
            1 if !initialized => {
                initialized = true;
                let _ = writeln!(stdin, r#"{{"method":"initialized","params":{{}}}}"#);
                let _ = writeln!(stdin, r#"{{"id":2,"method":"account/read","params":{{}}}}"#);
                if want_models {
                    let _ = writeln!(stdin, r#"{{"id":3,"method":"model/list","params":{{"includeHidden":true}}}}"#);
                }
                if want_limits {
                    let _ = writeln!(stdin, r#"{{"id":4,"method":"account/rateLimits/read","params":{{}}}}"#);
                }
                let _ = stdin.flush();
            }
            2 => {
                (snap.logged_in, snap.auth_method, snap.plan) = parse_codex_app_account(&v);
                got_acc = true;
                if !snap.logged_in { break; }
            }
            3 => {
                snap.models = parse_codex_app_models(&v);
                got_models = true;
            }
            4 => {
                snap.quota = parse_codex_app_rate_limits(&v);
                got_limits = true;
            }
            _ => {}
        }
    }

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    initialized.then_some(snap)
}

fn parse_window_quota(v: Option<&serde_json::Value>) -> Option<WindowQuota> {
    let o = v?.as_object()?;
    let used = o.get("used_percent")?.as_f64()?;
    let resets = o.get("resets_at").and_then(|x| x.as_i64()).unwrap_or(0);
    Some(WindowQuota { used_percent: used.clamp(0.0, 100.0), resets_at: resets })
}

/// Lee los límites reales de ChatGPT/Codex (`primary` 5 h, `secondary` semanal y `plan_type`) desde `~/.codex/sessions/**/*.jsonl` (respaldo offline).
pub fn read_codex_quota_from(home: Option<&Path>) -> Option<CodexQuota> {
    let root = home?.join(".codex").join("sessions");
    if !root.is_dir() { return None; }
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let mt = entry.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                files.push((mt, p));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().take(12) {
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        for line in raw.lines().rev() {
            let t = line.trim();
            if !t.contains("rate_limits") { continue; }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else { continue };
            let rl = v.get("payload").and_then(|p| p.get("rate_limits")).or_else(|| v.get("rate_limits"));
            let Some(rl) = rl else { continue };
            let five = parse_window_quota(rl.get("primary"));
            let week = parse_window_quota(rl.get("secondary"));
            if five.is_none() && week.is_none() { continue; }
            let plan = rl.get("plan_type").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            return Some(CodexQuota { plan, five_hour: five, seven_day: week });
        }
    }
    None
}

/// Interpreta las líneas `<id>\t<etiqueta>` de `agy models`.
pub fn parse_agy_models(text: &str) -> Vec<AiModelInfo> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || !line.contains('\t') { continue; }
        let Some((id, label)) = line.split_once('\t') else { continue };
        let id = id.trim();
        let label = label.trim();
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) { continue; }
        let note = label.rsplit_once('(').and_then(|(_, r)| r.strip_suffix(')')).map(str::trim).unwrap_or("").to_string();
        if !out.iter().any(|x: &AiModelInfo| x.id == id) {
            out.push(AiModelInfo { id: id.to_string(), label: if label.is_empty() { id.to_string() } else { label.to_string() }, note });
        }
    }
    out
}

/// Extrae los grupos y cubos de cuota de `agy -p "/usage" --output-format json --mode plan`.
pub fn parse_agy_usage_json(text: &str) -> Option<AntigravityUsage> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()
        .or_else(|| text.lines().rev().find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok()))?;
    if v.get("status").and_then(|s| s.as_str()) != Some("SUCCESS") { return None; }
    let arr = v.get("command").and_then(|c| c.get("data")).and_then(|d| d.get("groups")).and_then(|g| g.as_array())?;
    let mut groups = Vec::new();
    for g in arr {
        let name = g.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() { continue; }
        let description = g.get("description").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let mut buckets = Vec::new();
        if let Some(bs) = g.get("buckets").and_then(|x| x.as_array()) {
            for b in bs {
                let id = b.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let bname = b.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let window = b.get("window").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let rem = b.get("remaining_fraction").and_then(|x| x.as_f64()).unwrap_or(1.0).clamp(0.0, 1.0);
                let reset_time = b.get("reset_time").and_then(|x| x.as_str()).unwrap_or("").to_string();
                buckets.push(AntigravityBucket { id, name: bname, window, remaining_fraction: rem, reset_time });
            }
        }
        groups.push(AntigravityQuotaGroup { name, description, buckets });
    }
    (!groups.is_empty()).then_some(AntigravityUsage { groups })
}

fn detect_codex() -> AiTool {
    let (program, prefix) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
    let version = match capture_vec(&program, &with_prefix(&prefix, &["--version"]), 15) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: tr("No se encontró Codex CLI (ChatGPT) en este equipo.").into(), ..Default::default() },
    };
    if let Some(snap) = codex_app_server_snapshot(&program, &prefix, true, false) {
        let mut models = snap.models;
        if models.is_empty() && snap.logged_in {
            models = read_codex_models_from(user_home().as_deref());
        }
        return AiTool {
            installed: true,
            version,
            logged_in: snap.logged_in,
            auth_method: snap.auth_method,
            plan: snap.plan,
            error: String::new(),
            models,
        };
    }
    let mut tool = AiTool { installed: true, version, ..Default::default() };
    match capture_status(&program, &with_prefix(&prefix, &["login", "status"]), 15) {
        Ok((ok, text)) => {
            let (logged, method, plan) = parse_codex_login_status(ok, &text);
            tool.logged_in = logged;
            tool.auth_method = method;
            tool.plan = plan;
        }
        Err(_) => tool.error = tr("No se pudo comprobar la sesión de Codex.").into(),
    }
    if tool.logged_in {
        let home = user_home();
        tool.models = read_codex_models_from(home.as_deref());
        if let Some(q) = read_codex_quota_from(home.as_deref()) {
            if !q.plan.is_empty() && tool.auth_method != "api_key" {
                tool.plan = q.plan;
            }
        }
    }
    tool
}

fn detect_antigravity() -> AiTool {
    let (program, prefix) = resolve_cli("agy", "PULSO_AGY_BIN", None);
    let version = match capture_vec(&program, &with_prefix(&prefix, &["--version"]), 12) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: tr("No se encontró Antigravity CLI (`agy`) en este equipo.").into(), ..Default::default() },
    };
    let mut tool = AiTool { installed: true, version, ..Default::default() };
    match capture_status(&program, &with_prefix(&prefix, &["models"]), 20) {
        Ok((ok, text)) => {
            let models = parse_agy_models(&text);
            if !models.is_empty() {
                tool.logged_in = true;
                tool.auth_method = "google".into();
                tool.plan = "Antigravity".into();
                tool.models = models;
                return tool;
            }
            let low = text.to_lowercase();
            if !ok && (low.contains("login") || low.contains("auth") || low.contains("unauthorized") || low.contains("credential")) {
                return tool;
            }
        }
        Err(_) => {}
    }
    // Respaldo rápido si `agy models` falló por red temporal pero la cuenta sigue conectada localmente.
    let (logged, method, plan) = gemini_auth_from(user_home().as_deref(), false, false);
    tool.logged_in = logged;
    tool.auth_method = method;
    if logged { tool.plan = if plan == "Google" { "Antigravity".into() } else { plan }; }
    tool
}

fn read_antigravity_usage() -> Option<AntigravityUsage> {
    let (program, prefix) = resolve_cli("agy", "PULSO_AGY_BIN", None);
    let args = with_prefix(&prefix, &["-p", "/usage", "--output-format", "json", "--mode", "plan"]);
    let out = capture_vec(&program, &args, 20).ok()?;
    parse_agy_usage_json(&out)
}

#[tauri::command]
pub async fn ai_detect() -> Result<AiTool, String> {
    tauri::async_runtime::spawn_blocking(detect_claude).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_detect_provider(provider: String) -> Result<AiTool, String> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "claude" => Ok(detect_claude()),
        "codex" => Ok(detect_codex()),
        "antigravity" | "gemini" => Ok(detect_antigravity()),
        _ => Err(tr("Proveedor de IA no soportado").to_string()),
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_detect_all() -> Result<AllAiTools, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let t_claude = thread::spawn(detect_claude);
        let t_codex = thread::spawn(detect_codex);
        let t_agy = thread::spawn(detect_antigravity);
        let t_local = thread::spawn(crate::localai::detect);
        AllAiTools {
            claude: t_claude.join().unwrap_or_default(),
            codex: t_codex.join().unwrap_or_default(),
            antigravity: t_agy.join().unwrap_or_default(),
            local: t_local.join().unwrap_or_default(),
        }
    }).await.map_err(|e| e.to_string())
}

/// Extrae el texto de `claude -p /usage --output-format json` (campo `result`).
pub fn parse_usage_result(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    if v.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) { return None; }
    v.get("result")?.as_str().map(|s| s.to_string())
}

/// Uso real del plan tal como lo informa la herramienta (`/usage`): no gasta cuota ni lee credenciales.
#[tauri::command]
pub async fn ai_usage() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = capture(&claude_program(), &["-p", "/usage", "--output-format", "json"], 30)?;
        parse_usage_result(&out).ok_or_else(|| tr("La herramienta no informó el uso del plan.").to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Cuotas reales en vivo para ChatGPT/Codex (`codex app-server`) y Antigravity (`agy -p "/usage"`).
#[tauri::command]
pub async fn ai_extra_usage() -> Result<ExtraUsage, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let t_codex = thread::spawn(|| {
            let (program, prefix) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
            codex_app_server_snapshot(&program, &prefix, false, true)
                .and_then(|s| s.quota)
                .or_else(|| read_codex_quota_from(user_home().as_deref()))
        });
        let t_agy = thread::spawn(read_antigravity_usage);
        ExtraUsage {
            codex: t_codex.join().ok().flatten(),
            antigravity: t_agy.join().ok().flatten(),
        }
    }).await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatOptions {
    pub session: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// «read» (solo leer) o «edit» (puede editar archivos).
    pub mode: String,
}

fn safe_token(s: &str) -> bool {
    // Sin guion inicial: un valor como «--help» se tomaría por una opción.
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '[' | ']'))
}

/// Programa que se ejecuta. Solo en compilaciones de desarrollo puede cambiarse con `PULSO_CLAUDE_BIN` (las pruebas usan una herramienta falsa);
/// en la aplicación instalada siempre es `claude`.
pub fn claude_program() -> String {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("PULSO_CLAUDE_BIN") { if !p.trim().is_empty() { return p; } }
    }
    "claude".to_string()
}

/// Argumentos de `claude` para una conversación. El mensaje va por la entrada estándar, no aquí.
pub fn build_claude_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    if let Some(s) = &o.session {
        if !safe_token(s) { return Err(tr("Identificador de sesión no válido").into()); }
        a.push("--resume".into());
        a.push(s.clone());
    }
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) { return Err(tr("Modelo no válido").into()); }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    if let Some(e) = &o.effort {
        if !e.is_empty() {
            if !matches!(e.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                return Err(tr("Nivel de esfuerzo no válido").into());
            }
            a.push("--effort".into());
            a.push(e.clone());
        }
    }
    let read_tools = "Read,Glob,Grep";
    match o.mode.as_str() {
        "read" => { a.extend(["--permission-mode", "default", "--allowedTools", read_tools].iter().map(|s| s.to_string())); }
        "edit" => { a.extend(["--permission-mode", "acceptEdits", "--allowedTools", "Read,Glob,Grep,Edit,Write,MultiEdit"].iter().map(|s| s.to_string())); }
        "full" => { a.extend(["--permission-mode", "acceptEdits", "--allowedTools", "Read,Glob,Grep,Edit,Write,MultiEdit,Bash"].iter().map(|s| s.to_string())); }
        _ => return Err(tr("Modo de permisos no válido").into()),
    }
    Ok(a)
}

/// Argumentos de `codex exec` para ChatGPT/Codex CLI. El mensaje va por stdin (`-`).
pub fn build_codex_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let sandbox = match o.mode.as_str() {
        "read" => "read-only",
        "edit" => "workspace-write",
        "full" => "danger-full-access",
        _ => return Err(tr("Modo de permisos no válido").into()),
    };
    if let Some(s) = &o.session {
        if !safe_token(s) { return Err(tr("Identificador de sesión no válido").into()); }
    }
    // `exec resume` no tiene `--sandbox`: el modo se fuerza por configuración para que «Solo leer» valga también al continuar
    // una conversación (si no, mandaría el `config.toml` de la persona, que puede permitirlo todo).
    let mut a: Vec<String> = match &o.session {
        Some(_) => ["exec", "resume", "--json", "-c", &format!("sandbox_mode=\"{sandbox}\"")].iter().map(|s| s.to_string()).collect(),
        None => ["exec", "--json", "--sandbox", sandbox].iter().map(|s| s.to_string()).collect(),
    };
    // La carpeta la abrió la persona en Pulso, aunque no sea un repositorio de git.
    a.push("--skip-git-repo-check".into());
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) { return Err(tr("Modelo no válido").into()); }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    if let Some(e) = &o.effort {
        if !e.is_empty() {
            let mapped = match e.as_str() {
                "low" | "medium" | "high" | "xhigh" => e.as_str(),
                "max" => "xhigh",
                _ => return Err(tr("Nivel de esfuerzo no válido").into()),
            };
            a.push("-c".into());
            a.push(format!("model_reasoning_effort=\"{mapped}\""));
        }
    }
    if let Some(s) = &o.session { a.push(s.clone()); }
    a.push("-".into());
    Ok(a)
}

/// Argumentos de Antigravity CLI (`agy`) en modo headless con streaming JSON.
pub fn build_agy_args(o: &ChatOptions, prompt: &str) -> Result<Vec<String>, String> {
    let (mode_flags, guide, resume_guide): (Vec<&str>, &str, Option<&str>) = match o.mode.as_str() {
        "read" => (
            vec!["--mode", "plan"],
            "[Instrucción de entorno: estás en modo Solo leer dentro de Pulso Editor. Explora usando únicamente herramientas de lectura y búsqueda. Nunca invoques run_command ni herramientas de escritura.]\n\n",
            None,
        ),
        "edit" => (
            vec!["--mode", "accept-edits"],
            "[Instrucción de entorno: estás en modo Edición en Pulso Editor. Puedes leer, buscar y editar archivos directamente. Si necesitas ejecutar un comando de terminal, inténtalo o indícalo claramente para que Pulso pida aprobación al usuario.]\n\n",
            Some("[Permisos actuales en Pulso: modo Edición activo; puedes leer, buscar y editar archivos directamente.]\n\n"),
        ),
        "full" => (
            vec!["--dangerously-skip-permissions"],
            "[Instrucción de entorno: estás en modo Agente completo en Pulso Editor. Tienes permiso aprobado por el usuario para leer, buscar, editar archivos y ejecutar comandos de terminal (run_command) dentro del proyecto para completar y verificar la tarea.]\n\n",
            Some("[Permisos actuales en Pulso: modo Agente completo aprobado; puedes editar archivos y ejecutar comandos de terminal (run_command) para completar la tarea.]\n\n"),
        ),
        _ => return Err(tr("Modo de permisos no válido").into()),
    };
    let mut a: Vec<String> = vec!["--output-format".into(), "stream-json".into()];
    a.extend(mode_flags.into_iter().map(|s| s.to_string()));
    if let Some(s) = &o.session {
        if !safe_token(s) { return Err(tr("Identificador de sesión no válido").into()); }
        a.push("--conversation".into());
        a.push(s.clone());
    }
    let has_explicit_model = o.model.as_deref().is_some_and(|m| !m.trim().is_empty());
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) { return Err(tr("Modelo no válido").into()); }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    // En `agy models` cada modelo ya fija su variante de esfuerzo: `--effort` solo aplica en Predeterminado.
    if !has_explicit_model {
        if let Some(e) = &o.effort {
            if !e.is_empty() {
                if !matches!(e.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                    return Err(tr("Nivel de esfuerzo no válido").into());
                }
                a.push("--effort".into());
                a.push(e.clone());
            }
        }
    }
    let full_prompt = if o.session.is_none() {
        format!("{guide}{prompt}")
    } else if let Some(rg) = resume_guide {
        format!("{rg}{prompt}")
    } else {
        prompt.to_string()
    };
    a.push("-p".into());
    a.push(full_prompt);
    Ok(a)
}

const MAX_LINE: usize = 1_000_000;
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Lee una línea hasta `\n` acotando memoria en `max` bytes; si se supera, descarta hasta el fin de línea
/// y marca `truncated = true`. Nunca falla ni corta el stream por bytes no UTF-8.
fn read_bounded_line(reader: &mut impl BufRead, max: usize) -> std::io::Result<Option<(String, bool)>> {
    let mut buf = Vec::new();
    let mut truncated = false;
    let mut any = false;
    loop {
        let avail = reader.fill_buf()?;
        if avail.is_empty() {
            return if any {
                Ok(Some((String::from_utf8_lossy(&buf).into_owned(), truncated)))
            } else {
                Ok(None)
            };
        }
        any = true;
        if let Some(pos) = avail.iter().position(|&b| b == b'\n') {
            if !truncated {
                let slice = &avail[..pos];
                if buf.len() + slice.len() > max {
                    truncated = true;
                    buf.clear();
                } else {
                    buf.extend_from_slice(slice);
                }
            }
            reader.consume(pos + 1);
            if buf.ends_with(b"\r") {
                buf.pop();
            }
            return Ok(Some((String::from_utf8_lossy(&buf).into_owned(), truncated)));
        }
        let len = avail.len();
        if !truncated {
            if buf.len() + len > max {
                truncated = true;
                buf.clear();
            } else {
                buf.extend_from_slice(avail);
            }
        }
        reader.consume(len);
    }
}

/// Lanza `program` con `args` en `cwd`, le entrega `prompt` por la entrada estándar (si no va vacío) y llama a `on_line` por cada línea
/// de su salida; al terminar, a `on_exit` con el código y el final de su salida de error. Devuelve el pid.
pub fn spawn_stream(
    program: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
    on_line: Arc<dyn Fn(String) + Send + Sync>,
    on_exit: Arc<dyn Fn(Option<i32>, String) + Send + Sync>,
) -> Result<u32, String> {
    let mut cmd = background_command(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if prompt.is_empty() { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::procguard::configure_child(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| trf("No se pudo iniciar {program}: {e}", &[("program", &program), ("e", &e)]))?;
    crate::procguard::attach_job(&child);
    let pid = child.id();

    let out = child.stdout.take().ok_or(tr("sin salida"))?;
    let mut err = child.stderr.take().ok_or(tr("sin salida de error"))?;
    let stdin_opt = child.stdin.take();
    let prompt_bytes = prompt.as_bytes().to_vec();

    // Iniciar lectores de stdout/stderr antes de escribir en stdin evita deadlocks en prompts largos.
    let err_thread = thread::spawn(move || {
        let mut captured = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = err.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if captured.len() + n > MAX_STDERR_BYTES {
                let excess = captured.len() + n - MAX_STDERR_BYTES;
                if excess >= captured.len() {
                    captured.clear();
                } else {
                    captured.drain(..excess);
                }
            }
            let take = n.min(MAX_STDERR_BYTES);
            captured.extend_from_slice(&chunk[n - take..n]);
        }
        String::from_utf8_lossy(&captured).into_owned()
    });
    let stdin_thread = stdin_opt.map(|mut stdin| {
        thread::spawn(move || {
            let _ = stdin.write_all(&prompt_bytes);
            drop(stdin);
        })
    });
    thread::spawn(move || {
        let mut reader = BufReader::new(out);
        while let Ok(Some((line, truncated))) = read_bounded_line(&mut reader, MAX_LINE) {
            if truncated {
                on_line("{\"type\":\"pulso_truncated\"}".to_string());
                continue;
            }
            if line.trim().is_empty() {
                continue;
            }
            on_line(line);
        }
        if let Some(t) = stdin_thread {
            let _ = t.join();
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
pub async fn ai_send(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
    cwd: String,
    prompt: String,
    session: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    mode: String,
    provider: Option<String>,
    history: Option<Vec<crate::localai::HistoryMsg>>,
) -> Result<(), String> {
    if !safe_token(&id) { return Err(tr("Identificador de conversación no válido").into()); }
    if !std::path::Path::new(&cwd).is_dir() { return Err(tr("Abre una carpeta de proyecto para hablar con la IA.").into()); }
    if let Some(reason) = crate::termui::broad_dir_reason(Path::new(&cwd), user_home().as_deref()) {
        return Err(trf("No se permite lanzar la IA en esa carpeta ({reason}). Abre una carpeta de proyecto concreta.", &[("reason", &reason)]));
    }
    if prompt.trim().is_empty() { return Err(tr("El mensaje está vacío.").into()); }

    // Reservar el slot ANTES de spawnear elimina carreras de doble envío y PIDs obsoletos.
    {
        let mut map = state.running.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&id) {
            return Err(tr("Esta conversación ya está respondiendo.").into());
        }
        map.insert(id.clone(), AiSlot::Starting);
    }

    if provider.as_deref() == Some("local") {
        return start_local(app, &state, id, cwd, prompt, model, history.unwrap_or_default());
    }

    let opts = ChatOptions { session, model, effort, mode };
    let app_clone = app.clone();
    let id_for_spawn = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let mut stdin_payload = prompt.as_str();
        let (program, args) = match provider.as_deref().unwrap_or("claude") {
            "claude" => {
                let (prog, mut prefix) = resolve_cli("claude", "PULSO_CLAUDE_BIN", Some("@anthropic-ai/claude-code"));
                prefix.extend(build_claude_args(&opts)?);
                (prog, prefix)
            }
            "codex" => {
                let (prog, mut prefix) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
                prefix.extend(build_codex_args(&opts)?);
                (prog, prefix)
            }
            "antigravity" | "gemini" => {
                let (prog, mut prefix) = resolve_cli("agy", "PULSO_AGY_BIN", None);
                let low = prog.to_ascii_lowercase();
                if (low.ends_with(".cmd") || low.ends_with(".bat")) && prompt.len() > 6000 {
                    return Err(tr("El mensaje es demasiado largo para pasarlo a través de un script .cmd en Windows. Instala el ejecutable nativo de agy o acorta el contexto.").into());
                }
                prefix.extend(build_agy_args(&opts, &prompt)?);
                stdin_payload = "";
                (prog, prefix)
            }
            _ => return Err(tr("Proveedor de IA no soportado").into()),
        };
        let (a1, a2, id1, id2) = (app_clone.clone(), app_clone.clone(), id_for_spawn.clone(), id_for_spawn.clone());
        spawn_stream(
            &program,
            &args,
            &cwd,
            stdin_payload,
            Arc::new(move |line| { let _ = a1.emit("ai-line", AiLine { id: id1.clone(), line }); }),
            Arc::new(move |code, stderr| {
                if let Some(st) = a2.try_state::<AiState>() {
                    if let Ok(mut m) = st.running.lock() {
                        m.remove(&id2);
                    }
                }
                let _ = a2.emit("ai-exit", AiExit { id: id2.clone(), code, stderr });
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut map = state.running.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(pid) => {
            // Si el proceso salió antes de llegar aquí, `on_exit` ya quitó la entrada: no re-insertar PID viejo.
            if matches!(map.get(&id), Some(AiSlot::Starting)) {
                map.insert(id, AiSlot::Running(pid));
            }
            Ok(())
        }
        Err(e) => {
            map.remove(&id);
            Err(e)
        }
    }
}

/// Agente local (Ollama): corre dentro de Pulso y emite los mismos eventos que las herramientas externas.
fn start_local(
    app: AppHandle,
    state: &AiState,
    id: String,
    cwd: String,
    prompt: String,
    model: Option<String>,
    history: Vec<crate::localai::HistoryMsg>,
) -> Result<(), String> {
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).ok_or_else(|| tr("Elige un modelo de Ollama para conversar.").to_string())?;
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.running.lock().map_err(|e| e.to_string())?.insert(id.clone(), AiSlot::Local(cancel.clone()));
    let (emitter, id_line) = (app.clone(), id.clone());
    let emit: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line| {
        let _ = emitter.emit("ai-line", AiLine { id: id_line.clone(), line });
    });
    tauri::async_runtime::spawn(async move {
        let outcome = crate::localai::run(crate::localai::base_url(), model, PathBuf::from(&cwd), id.clone(), history, prompt, cancel.clone(), emit).await;
        if let Some(st) = app.try_state::<AiState>() {
            if let Ok(mut m) = st.running.lock() {
                m.remove(&id);
            }
        }
        let stopped = cancel.load(std::sync::atomic::Ordering::Relaxed);
        let (code, stderr) = match outcome {
            Ok(()) => (Some(0), String::new()),
            Err(_) if stopped => (None, String::new()),
            Err(e) => (Some(1), e),
        };
        let _ = app.emit("ai-exit", AiExit { id, code, stderr });
    });
    Ok(())
}

#[tauri::command]
pub async fn ai_stop(state: State<'_, AiState>, id: String) -> Result<(), String> {
    let pid = {
        let mut map = state.running.lock().map_err(|e| e.to_string())?;
        match map.remove(&id) {
            Some(AiSlot::Running(p)) => Some(p),
            Some(AiSlot::Local(flag)) => {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
                None
            }
            _ => None,
        }
    };
    if let Some(pid) = pid {
        let _ = tauri::async_runtime::spawn_blocking(move || kill_pid(pid)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(mode: &str) -> ChatOptions { ChatOptions { session: None, model: None, effort: None, mode: mode.into() } }

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
        assert!(!e.iter().any(|x| x.contains("Bash")), "en modo edit no se permite ejecutar comandos");
        assert!(!e.iter().any(|x| x.contains("dangerously")));
        let f = build_claude_args(&opts("full")).unwrap();
        assert_eq!(f[f.iter().position(|x| x == "--permission-mode").unwrap() + 1], "acceptEdits");
        assert!(f.iter().any(|x| x.contains("Edit") && x.contains("Bash")), "en modo full se permite Bash");
    }

    #[test]
    fn interpreta_modelos_y_uso_de_antigravity() {
        let txt = "Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\n";
        let m = parse_agy_models(txt);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "gemini-4-hydrogen-high");
        assert_eq!(m[0].label, "Gemini 4 Hydrogen (High)");
        assert_eq!(m[0].note, "High");

        let usage_json = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","description":"Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.82,"reset_time":"2026-11-25T15:17:00Z"}]}]}}}"#;
        let u = parse_agy_usage_json(usage_json).unwrap();
        assert_eq!(u.groups.len(), 1);
        assert_eq!(u.groups[0].name, "Gemini Models");
        assert!((u.groups[0].buckets[0].remaining_fraction - 0.82).abs() < 1e-6);
    }

    #[test]
    fn interpreta_respuestas_de_codex_app_server() {
        let acc = serde_json::json!({"id":2,"result":{"account":{"type":"chatgpt","planType":"plus"}}});
        assert_eq!(parse_codex_app_account(&acc), (true, "chatgpt".into(), "plus".into()));

        let mods = serde_json::json!({"id":3,"result":{"data":[
            {"model":"gpt-6.2-sol","displayName":"GPT-6.2-Sol","description":"Fast","hidden":false},
            {"model":"gpt-5-old","displayName":"GPT-5 Old","description":"","hidden":true}
        ]}});
        let parsed = parse_codex_app_models(&mods);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "gpt-6.2-sol");
        assert_eq!(parsed[1].note, "legacy");

        let rl = serde_json::json!({"id":4,"result":{"rateLimits":{"planType":"plus","primary":{"usedPercent":13,"resetsAt":1800000100},"secondary":{"usedPercent":58,"resetsAt":1800500000}}}});
        let q = parse_codex_app_rate_limits(&rl).unwrap();
        assert_eq!(q.plan, "plus");
        assert_eq!(q.five_hour.unwrap().used_percent, 13.0);
        assert_eq!(q.seven_day.unwrap().used_percent, 58.0);
    }

    #[test]
    fn lee_el_texto_del_uso_del_plan() {
        let ok = r#"{"is_error":false,"result":"Current session: 68% used · resets Nov 18, 12pm (America/Bogota)"}"#;
        assert!(parse_usage_result(ok).unwrap().starts_with("Current session: 68%"));
        assert_eq!(parse_usage_result(r#"{"is_error":true,"result":"x"}"#), None);
        assert_eq!(parse_usage_result("no es json"), None);
    }

    #[test]
    fn sesion_y_modelo_se_validan_y_se_pasan() {
        let o = ChatOptions { session: Some("3f1e2c1a-aaaa-bbbb-cccc-1234567890ab".into()), model: Some("sonnet".into()), effort: Some("high".into()), mode: "read".into() };
        let a = build_claude_args(&o).unwrap();
        assert_eq!(a[a.iter().position(|x| x == "--resume").unwrap() + 1], "3f1e2c1a-aaaa-bbbb-cccc-1234567890ab");
        assert_eq!(a[a.iter().position(|x| x == "--model").unwrap() + 1], "sonnet");
        assert_eq!(a[a.iter().position(|x| x == "--effort").unwrap() + 1], "high");
        for malo in ["x; rm -rf /", "a b", "--help", "$(x)"] {
            assert!(build_claude_args(&ChatOptions { session: Some(malo.into()), model: None, effort: None, mode: "read".into() }).is_err(), "{malo}");
            assert!(build_claude_args(&ChatOptions { session: None, model: Some(malo.into()), effort: None, mode: "read".into() }).is_err(), "{malo}");
            assert!(build_claude_args(&ChatOptions { session: None, model: None, effort: Some(malo.into()), mode: "read".into() }).is_err(), "{malo}");
        }
        assert!(build_claude_args(&opts("todo")).is_err());
        assert!(!build_claude_args(&ChatOptions { session: None, model: Some("".into()), effort: Some("".into()), mode: "read".into() }).unwrap().contains(&"--model".to_string()));
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

    #[test]
    fn interpreta_estado_de_codex_y_antigravity() {
        assert_eq!(parse_codex_login_status(true, "Logged in using ChatGPT"), (true, "chatgpt".into(), "ChatGPT".into()));
        assert_eq!(parse_codex_login_status(true, "Logged in using an API key - sk-..."), (true, "api_key".into(), "API".into()));
        assert_eq!(parse_codex_login_status(false, "Not logged in"), (false, "".into(), "".into()));

        assert_eq!(gemini_auth_from(None, true, false), (true, "api_key".into(), "API".into()));
        assert_eq!(gemini_auth_from(None, false, true), (true, "vertex".into(), "Vertex".into()));
        assert_eq!(gemini_auth_from(None, false, false), (false, "".into(), "".into()));

        let tmp = std::env::temp_dir().join(format!("pulso-ai-test-{}", std::process::id()));
        let gdir = tmp.join(".gemini");
        std::fs::create_dir_all(&gdir).unwrap();
        std::fs::write(gdir.join("google_accounts.json"), r#"{"active":"user@example.com"}"#).unwrap();
        assert_eq!(gemini_auth_from(Some(&tmp), false, false), (true, "google".into(), "Google".into()));

        std::fs::create_dir_all(tmp.join(".codex")).unwrap();
        std::fs::write(tmp.join(".codex").join("models_cache.json"), r#"{"models":[{"slug":"gpt-5.4","display_name":"GPT-5.4","visibility":"list"},{"slug":"hidden-1","visibility":"hide"}]}"#).unwrap();
        let codex_models = read_codex_models_from(Some(&tmp));
        assert_eq!(codex_models.len(), 1);
        assert_eq!(codex_models[0].id, "gpt-5.4");

        let sdir = tmp.join(".codex").join("sessions").join("2026").join("11").join("18");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("rollout-1.jsonl"),
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"plan_type":"pro","primary":{"used_percent":35.0,"resets_at":1800000100},"secondary":{"used_percent":12.0,"resets_at":1800500000}}}}"#,
        ).unwrap();
        let cq = read_codex_quota_from(Some(&tmp)).unwrap();
        assert_eq!(cq.plan, "pro");
        assert_eq!(cq.five_hour.unwrap().used_percent, 35.0);
        assert_eq!(cq.seven_day.unwrap().used_percent, 12.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn argumentos_de_codex_y_antigravity() {
        let cr = build_codex_args(&ChatOptions { session: None, model: Some("gpt-6.2-sol".into()), effort: Some("max".into()), mode: "read".into() }).unwrap();
        assert_eq!(cr, ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-6.2-sol", "-c", "model_reasoning_effort=\"xhigh\"", "-"]);
        let ce = build_codex_args(&ChatOptions { session: Some("thread_123".into()), model: Some("gpt-6.2-sol".into()), effort: Some("high".into()), mode: "edit".into() }).unwrap();
        assert_eq!(ce, ["exec", "resume", "--json", "-c", "sandbox_mode=\"workspace-write\"", "--skip-git-repo-check", "--model", "gpt-6.2-sol", "-c", "model_reasoning_effort=\"high\"", "thread_123", "-"]);
        let cf = build_codex_args(&ChatOptions { session: None, model: None, effort: None, mode: "full".into() }).unwrap();
        assert_eq!(cf, ["exec", "--json", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-"]);
        assert!(build_codex_args(&opts("bad")).is_err());

        let ar = build_agy_args(&ChatOptions { session: None, model: Some("gemini-4-hydrogen-high".into()), effort: Some("medium".into()), mode: "read".into() }, "hola").unwrap();
        assert_eq!(&ar[..6], ["--output-format", "stream-json", "--mode", "plan", "--model", "gemini-4-hydrogen-high"]);
        assert_eq!(ar[6], "-p");
        assert!(ar[7].ends_with("hola") && ar[7].contains("Solo leer"));
        let ad = build_agy_args(&ChatOptions { session: None, model: None, effort: Some("high".into()), mode: "read".into() }, "hola").unwrap();
        assert_eq!(&ad[..6], ["--output-format", "stream-json", "--mode", "plan", "--effort", "high"]);
        let ae = build_agy_args(&ChatOptions { session: Some("conv-1".into()), model: None, effort: None, mode: "edit".into() }, "edita").unwrap();
        assert_eq!(&ae[..7], ["--output-format", "stream-json", "--mode", "accept-edits", "--conversation", "conv-1", "-p"]);
        assert!(ae[7].ends_with("edita") && ae[7].contains("Edición"));
        let af = build_agy_args(&ChatOptions { session: Some("conv-1".into()), model: None, effort: None, mode: "full".into() }, "ejecuta").unwrap();
        assert_eq!(&af[..6], ["--output-format", "stream-json", "--dangerously-skip-permissions", "--conversation", "conv-1", "-p"]);
        assert!(af[6].ends_with("ejecuta") && af[6].contains("Agente completo"));
    }
}
