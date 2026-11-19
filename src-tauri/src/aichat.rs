//! Chat de IA con herramientas oficiales de línea de comandos (por ahora Claude Code).
//! La herramienta inicia sesión con la cuenta de la persona (por ejemplo su suscripción); Pulso nunca ve credenciales:
//! solo lanza el proceso en la carpeta del proyecto, le pasa el mensaje y reenvía su salida JSON línea a línea.
use super::background_command;
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
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

impl AiState {
    pub fn stop_all(&self) {
        let pids: Vec<u32> = self.running.lock().map(|mut m| m.drain().map(|(_, p)| p).collect()).unwrap_or_default();
        for pid in pids { kill_pid(pid); }
    }
}

fn kill_pid(pid: u32) {
    let pid = pid.to_string();
    let _ = if cfg!(windows) {
        background_command("taskkill").args(["/PID", &pid, "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    } else {
        background_command("kill").args(["-TERM", &pid]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
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
pub struct GeminiModelStat {
    pub model: String,
    pub requests: u64,
    pub tokens: u64,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct GeminiUsage {
    pub requests_24h: u64,
    pub tokens_24h: u64,
    pub requests_7d: u64,
    pub tokens_7d: u64,
    pub models: Vec<GeminiModelStat>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct ExtraUsage {
    pub codex: Option<CodexQuota>,
    pub gemini: Option<GeminiUsage>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AllAiTools {
    pub claude: AiTool,
    pub codex: AiTool,
    pub gemini: AiTool,
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
    let mut out = child.stdout.take().ok_or("sin salida")?;
    let mut err = child.stderr.take().ok_or("sin salida de error")?;
    let r_out = thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); s });
    let r_err = thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break st,
            None if Instant::now() >= deadline => { let _ = child.kill(); let _ = child.wait(); return Err("tardó demasiado".into()); }
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

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Busca el punto de entrada JS de un paquete npm global (`package.json` → `bin`) para ejecutarlo con `node` sin pasar por `.cmd`.
pub fn npm_bin_js(npm_dir: &Path, pkg: &str, bin_name: &str) -> Option<PathBuf> {
    let mut pkg_dir = npm_dir.join("node_modules");
    for part in pkg.split('/') {
        pkg_dir = pkg_dir.join(part);
    }
    let raw = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let rel = match v.get("bin")? {
        serde_json::Value::String(s) => s.as_str(),
        serde_json::Value::Object(map) => map.get(bin_name).and_then(|x| x.as_str())?,
        _ => return None,
    };
    let candidate = pkg_dir.join(rel);
    candidate.is_file().then_some(candidate)
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
        dirs.push(local.join("Programs").join("OpenAI").join("Codex").join("bin"));
        dirs.push(local.join("pnpm"));
        dirs.push(local.join("Programs").join("nodejs"));
    }
    for var in ["PNPM_HOME", "NVM_SYMLINK", "BUN_INSTALL"] {
        if let Some(v) = std::env::var_os(var) {
            let p = PathBuf::from(v);
            dirs.push(if var == "BUN_INSTALL" { p.join("bin") } else { p });
        }
    }
    if let Some(home) = user_home() {
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    dirs
}

fn node_program(hint_dir: &Path) -> String {
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
        for fixed in [r"C:\Program Files\nodejs\node.exe", r"C:\Program Files (x86)\nodejs\node.exe"] {
            if Path::new(fixed).is_file() { return fixed.to_string(); }
        }
    }
    "node".to_string()
}

/// Resuelve una CLI global buscando ejecutables nativos y paquetes npm `.js`/`.cmd` fuera del `PATH` heredado de GUI.
fn resolve_cli(name: &str, env_var: &str, npm_pkg: Option<&str>) -> (String, Vec<String>) {
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

/// Lee los modelos disponibles de la cuenta ChatGPT en `~/.codex/models_cache.json`.
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

/// ¿Es un identificador de modelo para chatear? Descarta embeddings, imágenes, voz en vivo, variantes internas y generaciones retiradas.
fn is_chat_gemini_model(id: &str) -> bool {
    const NOISE: [&str; 9] = ["embedding", "-base", "customtools", "-image", "-live", "computer-use", "9001", "-001", "tts"];
    if NOISE.iter().any(|n| id.contains(n)) || id.ends_with('-') { return false; }
    if id.starts_with("gemini-2.0") || id.starts_with("gemini-1") { return false; }
    true
}

/// Descubre los modelos `gemini-*` y `auto-gemini-*` que conoce la versión instalada de `@google/gemini-cli`
/// (están repartidos por los trozos de `bundle/*.js`). Los más nuevos primero.
pub fn discover_gemini_models_from(dirs: &[PathBuf]) -> Vec<AiModelInfo> {
    let Ok(re) = regex::Regex::new(r#"["'`]((?:auto-gemini-\d+(?:\.\d+)?|gemini-\d+(?:\.\d+)?-[a-z0-9.-]+))["'`]"#) else { return Vec::new(); };
    let mut ids: Vec<String> = Vec::new();
    for dir in dirs {
        let google = dir.join("node_modules").join("@google");
        // Versiones recientes: trozos en bundle/*.js. Anteriores: models.js dentro de gemini-cli-core.
        let mut files: Vec<PathBuf> = std::fs::read_dir(google.join("gemini-cli").join("bundle"))
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("js")).collect())
            .unwrap_or_default();
        for core in [google.join("gemini-cli-core"), google.join("gemini-cli").join("node_modules").join("@google").join("gemini-cli-core")] {
            let p = core.join("dist").join("src").join("config").join("models.js");
            if p.is_file() { files.push(p); }
        }
        for p in files {
            let Ok(meta) = std::fs::metadata(&p) else { continue };
            if meta.len() > 40_000_000 { continue; }
            let Ok(raw) = std::fs::read_to_string(&p) else { continue };
            for cap in re.captures_iter(&raw) {
                let id = cap[1].to_string();
                if is_chat_gemini_model(&id) && !ids.contains(&id) { ids.push(id); }
            }
        }
        if !ids.is_empty() { break; }
    }
    let version = |s: &str| -> Vec<u32> {
        s.trim_start_matches("auto-").trim_start_matches("gemini-").split('-').next().unwrap_or("")
            .split('.').filter_map(|n| n.parse().ok()).collect()
    };
    ids.sort_by(|a, b| version(b).cmp(&version(a)).then(a.cmp(b)));
    ids.into_iter().map(|id| AiModelInfo { id, label: String::new(), note: String::new() }).collect()
}

fn parse_window_quota(v: Option<&serde_json::Value>) -> Option<WindowQuota> {
    let o = v?.as_object()?;
    let used = o.get("used_percent")?.as_f64()?;
    let resets = o.get("resets_at").and_then(|x| x.as_i64()).unwrap_or(0);
    Some(WindowQuota { used_percent: used.clamp(0.0, 100.0), resets_at: resets })
}

/// Lee los límites reales de ChatGPT/Codex (`primary` 5 h, `secondary` semanal y `plan_type`) desde `~/.codex/sessions/**/*.jsonl`.
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

/// Agrega uso local (peticiones y tokens por modelo en las últimas 24 h / 7 d) desde `~/.gemini/tmp/*/chats/`.
pub fn read_gemini_usage_from(home: Option<&Path>, now_secs: u64) -> Option<GeminiUsage> {
    let tmp = home?.join(".gemini").join("tmp");
    if !tmp.is_dir() { return None; }
    let mut chat_files: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(&tmp) {
        for proj in projects.flatten() {
            let chats = proj.path().join("chats");
            if !chats.is_dir() { continue; }
            if let Ok(rd) = std::fs::read_dir(&chats) {
                for f in rd.flatten() {
                    let p = f.path();
                    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if !matches!(ext, "json" | "jsonl") { continue; }
                    let secs = f.metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    if now_secs.saturating_sub(secs) <= 7 * 86_400 {
                        chat_files.push((secs, p));
                    }
                }
            }
        }
    }
    if chat_files.is_empty() { return None; }
    chat_files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut out = GeminiUsage::default();
    let mut per_model: HashMap<String, (u64, u64)> = HashMap::new();
    for (secs, path) in chat_files.into_iter().take(40) {
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let in_24h = now_secs.saturating_sub(secs) <= 86_400;
        let items: Vec<serde_json::Value> = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = v.get("messages").and_then(|m| m.as_array()) { arr.clone() }
            else if let Some(arr) = v.as_array() { arr.clone() }
            else { vec![v] }
        } else {
            raw.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).collect()
        };
        for m in items {
            let kind = m.get("type").or_else(|| m.get("role")).and_then(|x| x.as_str()).unwrap_or("");
            if !matches!(kind, "gemini" | "assistant" | "model") { continue; }
            let model = m.get("model").and_then(|x| x.as_str()).unwrap_or("gemini").trim().to_string();
            let tok = m.get("tokens")
                .and_then(|t| t.get("total").and_then(|x| x.as_u64()).or_else(|| {
                    Some(t.get("input").and_then(|x| x.as_u64()).unwrap_or(0)
                        + t.get("output").and_then(|x| x.as_u64()).unwrap_or(0))
                }))
                .or_else(|| m.get("usageMetadata").and_then(|u| u.get("totalTokenCount").and_then(|x| x.as_u64())))
                .unwrap_or(0);
            out.requests_7d += 1;
            out.tokens_7d += tok;
            if in_24h {
                out.requests_24h += 1;
                out.tokens_24h += tok;
            }
            let e = per_model.entry(model).or_insert((0, 0));
            e.0 += 1;
            e.1 += tok;
        }
    }
    if out.requests_7d == 0 { return None; }
    let mut models: Vec<GeminiModelStat> = per_model
        .into_iter()
        .map(|(model, (requests, tokens))| GeminiModelStat { model, requests, tokens })
        .collect();
    models.sort_by(|a, b| b.requests.cmp(&a.requests).then(b.tokens.cmp(&a.tokens)));
    out.models = models;
    Some(out)
}

fn detect_codex() -> AiTool {
    let (program, prefix) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
    let version = match capture_vec(&program, &with_prefix(&prefix, &["--version"]), 15) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: "No se encontró Codex CLI (ChatGPT) en este equipo.".into(), ..Default::default() },
    };
    let mut tool = AiTool { installed: true, version, ..Default::default() };
    match capture_status(&program, &with_prefix(&prefix, &["login", "status"]), 15) {
        Ok((ok, text)) => {
            let (logged, method, plan) = parse_codex_login_status(ok, &text);
            tool.logged_in = logged;
            tool.auth_method = method;
            tool.plan = plan;
        }
        Err(_) => tool.error = "No se pudo comprobar la sesión de Codex.".into(),
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

fn detect_gemini() -> AiTool {
    let (program, prefix) = resolve_cli("gemini", "PULSO_GEMINI_BIN", Some("@google/gemini-cli"));
    let version = match capture_vec(&program, &with_prefix(&prefix, &["--version"]), 15) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: "No se encontró Gemini CLI en este equipo.".into(), ..Default::default() },
    };
    let has_key = std::env::var("GEMINI_API_KEY").is_ok_and(|v| !v.trim().is_empty());
    let has_vertex = std::env::var("GOOGLE_GENAI_USE_VERTEXAI").is_ok_and(|v| v == "true" || v == "1");
    let home = user_home();
    let (logged, method, plan) = gemini_auth_from(home.as_deref(), has_key, has_vertex);
    let models = if logged { discover_gemini_models_from(&extra_bin_dirs()) } else { Vec::new() };
    AiTool { installed: true, version, logged_in: logged, auth_method: method, plan, error: String::new(), models }
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
        "gemini" => Ok(detect_gemini()),
        _ => Err("Proveedor de IA no soportado".to_string()),
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_detect_all() -> Result<AllAiTools, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let t_claude = thread::spawn(detect_claude);
        let t_codex = thread::spawn(detect_codex);
        let t_gemini = thread::spawn(detect_gemini);
        AllAiTools {
            claude: t_claude.join().unwrap_or_default(),
            codex: t_codex.join().unwrap_or_default(),
            gemini: t_gemini.join().unwrap_or_default(),
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
        parse_usage_result(&out).ok_or_else(|| "La herramienta no informó el uso del plan.".to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Uso local y ventanas reales de cuota para Codex/ChatGPT y Gemini CLI (lectura de cachés locales, cero tokens gastados).
#[tauri::command]
pub async fn ai_extra_usage() -> Result<ExtraUsage, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = user_home();
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        ExtraUsage {
            codex: read_codex_quota_from(home.as_deref()),
            gemini: read_gemini_usage_from(home.as_deref(), now_secs),
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
    if let Some(e) = &o.effort {
        if !e.is_empty() {
            if !matches!(e.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                return Err("Nivel de esfuerzo no válido".into());
            }
            a.push("--effort".into());
            a.push(e.clone());
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

/// Argumentos de `codex exec` para ChatGPT/Codex CLI. El mensaje va por stdin (`-`).
pub fn build_codex_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let sandbox = match o.mode.as_str() {
        "read" => "read-only",
        "edit" => "workspace-write",
        _ => return Err("Modo de permisos no válido".into()),
    };
    if let Some(s) = &o.session {
        if !safe_token(s) { return Err("Identificador de sesión no válido".into()); }
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
            if !safe_token(m) { return Err("Modelo no válido".into()); }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    if let Some(e) = &o.effort {
        if !e.is_empty() {
            let mapped = match e.as_str() {
                "low" | "medium" | "high" | "xhigh" => e.as_str(),
                "max" => "xhigh",
                _ => return Err("Nivel de esfuerzo no válido".into()),
            };
            a.push("-c".into());
            a.push(format!("model_reasoning_effort=\"{mapped}\""));
        }
    }
    if let Some(s) = &o.session { a.push(s.clone()); }
    a.push("-".into());
    Ok(a)
}

/// Argumentos de `gemini` en modo headless con streaming JSON. El mensaje va por stdin.
pub fn build_gemini_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let approval = match o.mode.as_str() {
        "read" => "plan",
        "edit" => "auto_edit",
        _ => return Err("Modo de permisos no válido".into()),
    };
    // `--skip-trust`: la carpeta la abrió la persona en Pulso; sin esto, en modo no interactivo Gemini CLI se niega a trabajar en ella.
    let mut a: Vec<String> = ["--skip-trust", "-p", "", "--output-format", "stream-json", "--approval-mode", approval]
        .iter().map(|s| s.to_string()).collect();
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
pub fn ai_send(app: AppHandle, state: State<AiState>, id: String, cwd: String, prompt: String, session: Option<String>, model: Option<String>, effort: Option<String>, mode: String, provider: Option<String>) -> Result<(), String> {
    if !safe_token(&id) { return Err("Identificador de conversación no válido".into()); }
    if !std::path::Path::new(&cwd).is_dir() { return Err("Abre una carpeta de proyecto para hablar con la IA.".into()); }
    if prompt.trim().is_empty() { return Err("El mensaje está vacío.".into()); }
    let opts = ChatOptions { session, model, effort, mode };
    let (program, args) = match provider.as_deref().unwrap_or("claude") {
        "claude" => (claude_program(), build_claude_args(&opts)?),
        "codex" => {
            let (prog, mut prefix) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
            prefix.extend(build_codex_args(&opts)?);
            (prog, prefix)
        }
        "gemini" => {
            let (prog, mut prefix) = resolve_cli("gemini", "PULSO_GEMINI_BIN", Some("@google/gemini-cli"));
            prefix.extend(build_gemini_args(&opts)?);
            (prog, prefix)
        }
        _ => return Err("Proveedor de IA no soportado".into()),
    };
    if state.running.lock().map_err(|e| e.to_string())?.contains_key(&id) {
        return Err("Esta conversación ya está respondiendo.".into());
    }
    let (a1, a2, id1, id2) = (app.clone(), app.clone(), id.clone(), id.clone());
    let pid = spawn_stream(
        &program,
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
    if let Some(pid) = pid { kill_pid(pid); }
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
        assert!(!e.iter().any(|x| x.contains("Bash")), "nunca se permite ejecutar comandos");
        assert!(!e.iter().any(|x| x.contains("dangerously")));
    }

    #[test]
    fn los_modelos_de_gemini_se_leen_de_los_trozos_del_paquete_sin_ruido_y_con_los_nuevos_primero() {
        let tmp = std::env::temp_dir().join(format!("pulso-gem-modelos-{}", std::process::id()));
        let bundle = tmp.join("node_modules").join("@google").join("gemini-cli").join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("chunk-a.js"), r#"x("gemini-2.5-pro");y("gemini-3.1-pro-preview");z("gemini-embedding-001");w("gemini-2.0-flash-001")"#).unwrap();
        std::fs::write(bundle.join("chunk-b.js"), r#"a("gemini-3.5-flash");b("gemini-3-flash-base");c("auto-gemini-3");d("gemini-2.5-flash-image")"#).unwrap();
        let ids: Vec<String> = discover_gemini_models_from(&[tmp.clone()]).into_iter().map(|m| m.id).collect();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(ids, ["gemini-3.5-flash", "gemini-3.1-pro-preview", "auto-gemini-3", "gemini-2.5-pro"]);
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
    fn interpreta_estado_de_codex_y_gemini() {
        assert_eq!(parse_codex_login_status(true, "Logged in using ChatGPT"), (true, "chatgpt".into(), "ChatGPT".into()));
        assert_eq!(parse_codex_login_status(true, "Logged in using an API key - sk-..."), (true, "api_key".into(), "API".into()));
        assert_eq!(parse_codex_login_status(false, "Not logged in"), (false, "".into(), "".into()));

        assert_eq!(gemini_auth_from(None, true, false), (true, "api_key".into(), "API".into()));
        assert_eq!(gemini_auth_from(None, false, true), (true, "vertex".into(), "Vertex".into()));
        assert_eq!(gemini_auth_from(None, false, false), (false, "".into(), "".into()));

        let tmp = std::env::temp_dir().join(format!("pulso-gem-{}", std::process::id()));
        let gdir = tmp.join(".gemini");
        std::fs::create_dir_all(&gdir).unwrap();
        std::fs::write(gdir.join("google_accounts.json"), r#"{"active":"user@example.com"}"#).unwrap();
        assert_eq!(gemini_auth_from(Some(&tmp), false, false), (true, "google".into(), "Google".into()));

        // Si cerró sesión explícitamente (`active: null`), settings.json antiguo no marca conectado.
        std::fs::write(gdir.join("google_accounts.json"), r#"{"active":null}"#).unwrap();
        std::fs::write(gdir.join("settings.json"), r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#).unwrap();
        assert_eq!(gemini_auth_from(Some(&tmp), false, false), (false, "".into(), "".into()));

        // Si solo existe settings.json con oauth-personal (tokens en keyring), sí detecta Google.
        let _ = std::fs::remove_file(gdir.join("google_accounts.json"));
        assert_eq!(gemini_auth_from(Some(&tmp), false, false), (true, "google".into(), "Google".into()));

        // Punto de entrada JS de paquete npm global (`@openai/codex` / `@google/gemini-cli`).
        let pkg = tmp.join("node_modules").join("@google").join("gemini-cli");
        std::fs::create_dir_all(pkg.join("bundle")).unwrap();
        std::fs::write(pkg.join("bundle").join("gemini.js"), "console.log('ok')").unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"bin":{"gemini":"bundle/gemini.js"}}"#).unwrap();
        assert!(npm_bin_js(&tmp, "@google/gemini-cli", "gemini").is_some());

        // Descubre modelos reales desde ~/.codex/models_cache.json y @google/gemini-cli-core/dist/src/config/models.js.
        std::fs::create_dir_all(tmp.join(".codex")).unwrap();
        std::fs::write(tmp.join(".codex").join("models_cache.json"), r#"{"models":[{"slug":"gpt-5.4","display_name":"GPT-5.4","visibility":"list"},{"slug":"hidden-1","visibility":"hide"}]}"#).unwrap();
        let codex_models = read_codex_models_from(Some(&tmp));
        assert_eq!(codex_models.len(), 1);
        assert_eq!(codex_models[0].id, "gpt-5.4");

        let core_models = tmp.join("node_modules").join("@google").join("gemini-cli-core").join("dist").join("src").join("config");
        std::fs::create_dir_all(&core_models).unwrap();
        std::fs::write(core_models.join("models.js"), r#"export const DEFAULT = 'gemini-3.1-pro-preview'; export const FLASH = 'gemini-3-flash-preview';"#).unwrap();
        let gem_models = discover_gemini_models_from(&[tmp.clone()]);
        assert_eq!(gem_models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]);

        // Lee cuota real 5h/semanal desde sesiones JSONL de Codex y uso agregado de Gemini.
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

        let gc = tmp.join(".gemini").join("tmp").join("proj1").join("chats");
        std::fs::create_dir_all(&gc).unwrap();
        std::fs::write(
            gc.join("session-1.json"),
            r#"{"messages":[{"type":"user","content":"hi"},{"type":"gemini","model":"gemini-3-pro-preview","tokens":{"total":1500}}]}"#,
        ).unwrap();
        let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let gu = read_gemini_usage_from(Some(&tmp), now_secs).unwrap();
        assert_eq!(gu.requests_24h, 1);
        assert_eq!(gu.tokens_24h, 1500);
        assert_eq!(gu.models[0].model, "gemini-3-pro-preview");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn argumentos_de_codex_y_gemini() {
        let cr = build_codex_args(&ChatOptions { session: None, model: Some("gpt-5.4".into()), effort: Some("max".into()), mode: "read".into() }).unwrap();
        assert_eq!(cr, ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-5.4", "-c", "model_reasoning_effort=\"xhigh\"", "-"]);
        let ce = build_codex_args(&ChatOptions { session: Some("thread_123".into()), model: Some("gpt-5.4".into()), effort: None, mode: "edit".into() }).unwrap();
        assert_eq!(ce, ["exec", "resume", "--json", "-c", "sandbox_mode=\"workspace-write\"", "--skip-git-repo-check", "--model", "gpt-5.4", "thread_123", "-"]);
        let cl = build_codex_args(&ChatOptions { session: Some("thread_123".into()), model: None, effort: None, mode: "read".into() }).unwrap();
        assert!(cl.contains(&"sandbox_mode=\"read-only\"".to_string()), "continuar en solo lectura no puede quedar sin sandbox: {cl:?}");
        assert!(build_codex_args(&opts("bad")).is_err());

        let gr = build_gemini_args(&ChatOptions { session: None, model: Some("gemini-2.5-pro".into()), effort: None, mode: "read".into() }).unwrap();
        assert_eq!(gr, ["--skip-trust", "-p", "", "--output-format", "stream-json", "--approval-mode", "plan", "--model", "gemini-2.5-pro"]);
        let ge = build_gemini_args(&ChatOptions { session: Some("gem-1".into()), model: None, effort: None, mode: "edit".into() }).unwrap();
        assert_eq!(ge, ["--skip-trust", "-p", "", "--output-format", "stream-json", "--approval-mode", "auto_edit", "--resume", "gem-1"]);
    }
}
