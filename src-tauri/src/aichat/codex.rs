//! Codex: modelos, cuenta y cuota, leídos del servidor de aplicación o de los archivos locales.
use super::*;

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
pub(super) struct CodexServerSnapshot {
    pub(super) logged_in: bool,
    pub(super) auth_method: String,
    pub(super) plan: String,
    pub(super) models: Vec<AiModelInfo>,
    pub(super) quota: Option<CodexQuota>,
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

pub(super) fn parse_app_window(v: Option<&serde_json::Value>) -> Option<WindowQuota> {
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
pub(super) fn codex_app_server_snapshot(program: &str, prefix: &[String], want_models: bool, want_limits: bool) -> Option<CodexServerSnapshot> {
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

pub(super) fn parse_window_quota(v: Option<&serde_json::Value>) -> Option<WindowQuota> {
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

pub fn detect_codex() -> AiTool {
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
