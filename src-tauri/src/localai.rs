//! Asistente con un modelo local (Ollama), sin cuentas ni herramientas de terceros.
//!
//! Pulso hace de agente: envía la conversación a la API local de Ollama, le ofrece tres
//! herramientas de **solo lectura** (listar carpetas, leer archivos y buscar en el proyecto), siempre
//! dentro de la carpeta abierta, ejecuta las que pida el modelo y repite hasta que responde.
//!
//! La salida se emite con el mismo formato de eventos que Claude Code (`stream-json`), así el panel
//! del asistente la pinta igual que la de las otras herramientas: texto en vivo, herramientas
//! desplegables («Leyó a.ts», «Buscó «x»») y el resumen final.
use crate::aichat::{AiModelInfo, AiTool};
use crate::i18n::{tr, trf};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEFAULT_BASE: &str = "http://127.0.0.1:11434";
/// Vueltas máximas modelo → herramientas → modelo en un mismo mensaje.
const MAX_ROUNDS: usize = 12;
const MAX_TOOL_OUTPUT: usize = 24_000;
const MAX_READ_BYTES: u64 = 512 * 1024;
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__"];

/// Mensaje anterior de la conversación (lo envía el panel, que es quien la guarda).
#[derive(Deserialize, Debug, Clone)]
pub struct HistoryMsg {
    pub role: String,
    pub content: String,
}

/// Dirección de Ollama: la habitual o, solo hacia este equipo, la de `PULSO_OLLAMA_URL` u `OLLAMA_HOST`.
pub fn base_url() -> String {
    for var in ["PULSO_OLLAMA_URL", "OLLAMA_HOST"] {
        if let Ok(raw) = std::env::var(var) {
            let raw = raw.trim().trim_end_matches('/');
            let url = if raw.starts_with("http://") { raw.to_string() } else { format!("http://{raw}") };
            if url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") {
                return url;
            }
        }
    }
    DEFAULT_BASE.to_string()
}

fn client(timeout: Option<Duration>) -> reqwest::Client {
    let mut b = reqwest::Client::builder().user_agent("Pulso-Editor");
    if let Some(t) = timeout {
        b = b.timeout(t);
    }
    b.build().unwrap_or_else(|_| reqwest::Client::new())
}

// ---------- Detección ----------

/// Ollama «instalado» = su servidor responde; «con sesión» = además tiene al menos un modelo descargado.
pub async fn detect_with(base: &str) -> AiTool {
    let c = client(Some(Duration::from_secs(3)));
    let version = match c.get(format!("{base}/api/version")).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().and_then(|v| v["version"].as_str().map(str::to_string)).unwrap_or_default(),
        _ => {
            return AiTool { error: tr("Ollama no está en marcha en este equipo (http://127.0.0.1:11434).").into(), ..Default::default() };
        }
    };
    let models = match c.get(format!("{base}/api/tags")).send().await {
        Ok(r) => r.json::<Value>().await.ok().map(|v| parse_models(&v)).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    AiTool {
        installed: true,
        version: format!("Ollama {version}").trim().to_string(),
        logged_in: !models.is_empty(),
        auth_method: "local".into(),
        plan: String::new(),
        error: if models.is_empty() { tr("Ollama no tiene ningún modelo descargado. Descarga uno con «ollama pull qwen2.5-coder:7b».").into() } else { String::new() },
        models,
    }
}

pub fn detect() -> AiTool {
    tauri::async_runtime::block_on(detect_with(&base_url()))
}

pub fn parse_models(v: &Value) -> Vec<AiModelInfo> {
    v["models"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m["name"].as_str().or_else(|| m["model"].as_str())?.to_string();
                    let size = m["details"]["parameter_size"].as_str().unwrap_or("").to_string();
                    let family = m["details"]["family"].as_str().unwrap_or("").to_string();
                    let note = [family, size].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
                    Some(AiModelInfo { label: id.clone(), id, note })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------- Herramientas (solo lectura, dentro de la carpeta) ----------

fn tools_schema() -> Value {
    json!([
        { "type": "function", "function": {
            "name": "list_files",
            "description": "List the files and folders inside a folder of the project. Use \".\" for the project root.",
            "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "Folder path relative to the project root" } }, "required": ["path"] } } },
        { "type": "function", "function": {
            "name": "read_file",
            "description": "Read a text file of the project. Lines are numbered. Use start_line and max_lines for long files.",
            "parameters": { "type": "object", "properties": {
                "path": { "type": "string", "description": "File path relative to the project root" },
                "start_line": { "type": "integer", "description": "First line to read (1-based)" },
                "max_lines": { "type": "integer", "description": "How many lines to read (default 400)" } }, "required": ["path"] } } },
        { "type": "function", "function": {
            "name": "search_code",
            "description": "Search the project's text files for a word or phrase (case-insensitive). Returns file:line: text matches.",
            "parameters": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Text to search for" },
                "path": { "type": "string", "description": "Optional folder to limit the search" } }, "required": ["query"] } } }
    ])
}

/// Ruta dentro de la carpeta del proyecto, o error. Rechaza rutas absolutas, `..` que salgan y enlaces que apunten fuera.
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    let rel = if rel.is_empty() { ".".to_string() } else { rel };
    let p = Path::new(&rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err(tr("Solo se pueden leer rutas dentro de la carpeta del proyecto.").into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(root.join(p)).map_err(|_| trf("No existe: {path}", &[("path", &rel)]))?;
    if !full.starts_with(&root) {
        return Err(tr("Solo se pueden leer rutas dentro de la carpeta del proyecto.").into());
    }
    Ok(full)
}

fn cut(mut s: String) -> String {
    if s.len() > MAX_TOOL_OUTPUT {
        let mut end = MAX_TOOL_OUTPUT;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n…");
    }
    s
}

pub fn list_files(root: &Path, rel: &str) -> Result<String, String> {
    let dir = resolve_in(root, rel)?;
    let mut entries: Vec<(bool, String)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (!(is_dir && SKIP_DIRS.contains(&name.as_str()))).then_some((is_dir, name))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let total = entries.len();
    let mut out: Vec<String> = entries.into_iter().take(500).map(|(d, n)| if d { format!("{n}/") } else { n }).collect();
    if total > 500 {
        out.push(format!("… (+{})", total - 500));
    }
    Ok(if out.is_empty() { "(empty)".into() } else { out.join("\n") })
}

pub fn read_file(root: &Path, rel: &str, start: Option<u64>, max: Option<u64>) -> Result<String, String> {
    let file = resolve_in(root, rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return list_files(root, rel);
    }
    // Un archivo grande solo se lee por rangos (y nunca uno enorme), para no llenar el contexto del modelo.
    if meta.len() > 16 * MAX_READ_BYTES || (meta.len() > MAX_READ_BYTES && start.is_none()) {
        return Err(trf(
            "El archivo es demasiado grande para leerlo entero ({size} KB). Lee un rango con start_line y max_lines.",
            &[("size", &(meta.len() / 1024))],
        ));
    }
    read_range(&file, start, max)
}

fn read_range(file: &Path, start: Option<u64>, max: Option<u64>) -> Result<String, String> {
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(tr("Es un archivo binario: no se puede leer como texto.").into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let start = start.unwrap_or(1).max(1) as usize;
    let max = max.unwrap_or(400).clamp(1, 2000) as usize;
    let lines: Vec<&str> = text.lines().collect();
    let shown: Vec<String> = lines.iter().enumerate().skip(start - 1).take(max).map(|(i, l)| format!("{:>5}  {l}", i + 1)).collect();
    let mut out = shown.join("\n");
    if start - 1 + max < lines.len() {
        out.push_str(&format!("\n… ({} lines total)", lines.len()));
    }
    Ok(cut(out))
}

pub fn search_code(root: &Path, query: &str, rel: Option<&str>) -> Result<String, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err(tr("La búsqueda está vacía").into());
    }
    let base = resolve_in(root, rel.unwrap_or("."))?;
    let root_c = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    let walker = ignore::WalkBuilder::new(&base)
        .hidden(false)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
        .build();
    'files: for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if std::fs::metadata(path).map(|m| m.len() > MAX_READ_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        if bytes.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let shown = path.strip_prefix(&root_c).unwrap_or(path).to_string_lossy().replace('\\', "/");
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                let l: String = line.trim().chars().take(200).collect();
                hits.push(format!("{shown}:{}: {l}", i + 1));
                if hits.len() >= 100 {
                    hits.push("… (100+)".into());
                    break 'files;
                }
            }
        }
    }
    Ok(if hits.is_empty() { "(no matches)".into() } else { cut(hits.join("\n")) })
}

/// Ejecuta una herramienta. Devuelve (nombre para el panel, entrada para el panel, resultado, ¿error?).
pub fn run_tool(root: &Path, name: &str, args: &Value) -> (&'static str, Value, String, bool) {
    let s = |k: &str| args[k].as_str().map(str::to_string).or_else(|| args[k].as_i64().map(|n| n.to_string()));
    let n = |k: &str| args[k].as_u64().or_else(|| args[k].as_str().and_then(|v| v.parse().ok()));
    let (ui_name, ui_input, result) = match name {
        "list_files" => {
            let path = s("path").unwrap_or_else(|| ".".into());
            ("Glob", json!({ "path": path }), list_files(root, &path))
        }
        "read_file" => {
            let path = s("path").unwrap_or_default();
            ("Read", json!({ "file_path": path }), read_file(root, &path, n("start_line"), n("max_lines")))
        }
        "search_code" => {
            let query = s("query").unwrap_or_default();
            let path = s("path");
            ("Grep", json!({ "pattern": query }), search_code(root, &query, path.as_deref()))
        }
        other => ("Tool", json!({ "name": other }), Err(trf("Herramienta desconocida: {name}", &[("name", &other)]))),
    };
    match result {
        Ok(text) => (ui_name, ui_input, text, false),
        Err(e) => (ui_name, ui_input, e, true),
    }
}

// ---------- Agente ----------

fn system_prompt(root: &Path) -> String {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!(
        "You are the coding assistant inside Pulso Editor, working on the project folder \"{name}\". \
         You can explore it with the tools list_files, read_file and search_code; use them to look at the real code before answering \
         instead of guessing. You cannot modify files or run commands: if a change is needed, show it in your answer as a code block. \
         Answer in the same language the user writes in, clearly and concisely."
    )
}

/// Una llamada a `/api/chat` con streaming. Devuelve el texto y las herramientas pedidas.
async fn chat_round(
    c: &reqwest::Client,
    base: &str,
    model: &str,
    messages: &[Value],
    cancel: &AtomicBool,
    mut on_text: impl FnMut(&str),
) -> Result<(String, Vec<(String, Value)>), String> {
    let body = json!({ "model": model, "messages": messages, "tools": tools_schema(), "stream": true });
    let mut res = c
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| trf("No se pudo contactar con Ollama: {e}", &[("e", &e)]))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let detail = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&detail).ok().and_then(|v| v["error"].as_str().map(str::to_string)).unwrap_or(detail);
        return Err(trf("Ollama respondió {status}: {error}", &[("status", &status), ("error", &msg)]));
    }
    let (mut text, mut calls, mut pending) = (String::new(), Vec::new(), Vec::<u8>::new());
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(tr("La conversación se detuvo.").into());
        }
        let Some(chunk) = res.chunk().await.map_err(|e| trf("Ollama cortó la respuesta: {e}", &[("e", &e)]))? else { break };
        pending.extend_from_slice(&chunk);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(err) = v["error"].as_str() {
                return Err(trf("Ollama respondió con un error: {error}", &[("error", &err)]));
            }
            if let Some(piece) = v["message"]["content"].as_str().filter(|s| !s.is_empty()) {
                text.push_str(piece);
                on_text(piece);
            }
            if let Some(list) = v["message"]["tool_calls"].as_array() {
                for call in list {
                    let name = call["function"]["name"].as_str().unwrap_or("").to_string();
                    let mut args = call["function"]["arguments"].clone();
                    if let Some(raw) = args.as_str() {
                        args = serde_json::from_str(raw).unwrap_or(Value::Null);
                    }
                    if !name.is_empty() {
                        calls.push((name, args));
                    }
                }
            }
        }
    }
    Ok((text, calls))
}

/// Conversación completa con herramientas. `emit` recibe cada evento (una línea JSON) para el panel.
pub async fn run(
    base: String,
    model: String,
    root: PathBuf,
    conversation: String,
    history: Vec<HistoryMsg>,
    prompt: String,
    cancel: Arc<AtomicBool>,
    emit: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<(), String> {
    let started = Instant::now();
    let send = |v: Value| emit(v.to_string());
    send(json!({ "type": "system", "subtype": "init", "session_id": conversation, "model": model }));
    let mut messages = vec![json!({ "role": "system", "content": system_prompt(&root) })];
    for m in history.iter().filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty()) {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));
    let c = client(None);
    let stamp = started.elapsed().as_nanos() ^ (std::process::id() as u128) << 64;
    let mut final_text = String::new();
    for round in 0..MAX_ROUNDS {
        let turn = format!("local_{stamp:x}_{round}");
        send(json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "id": turn } } }));
        send(json!({ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } } }));
        let (text, calls) = chat_round(&c, &base, &model, &messages, &cancel, |piece| {
            send(json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": piece } } }));
        })
        .await?;
        send(json!({ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 } }));
        let mut content = vec![json!({ "type": "text", "text": text })];
        let mut runs = Vec::new();
        for (k, (name, args)) in calls.iter().enumerate() {
            let id = format!("{turn}_t{k}");
            let (ui_name, ui_input, result, is_error) = run_tool(&root, name, args);
            content.push(json!({ "type": "tool_use", "id": id, "name": ui_name, "input": ui_input }));
            runs.push((id, name.clone(), result, is_error));
        }
        send(json!({ "type": "assistant", "message": { "id": turn, "content": content } }));
        send(json!({ "type": "stream_event", "event": { "type": "message_stop" } }));
        messages.push(json!({ "role": "assistant", "content": text, "tool_calls": calls.iter().map(|(n, a)| json!({ "function": { "name": n, "arguments": a } })).collect::<Vec<_>>() }));
        if runs.is_empty() {
            final_text = text;
            break;
        }
        for (id, name, result, is_error) in runs {
            send(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": id, "content": result, "is_error": is_error }] } }));
            messages.push(json!({ "role": "tool", "content": result, "tool_name": name }));
        }
        if round + 1 == MAX_ROUNDS {
            final_text = tr("El modelo siguió pidiendo herramientas sin terminar de responder; se detuvo tras 12 vueltas.").into();
        }
    }
    send(json!({
        "type": "result", "subtype": "success", "is_error": false, "session_id": conversation,
        "duration_ms": started.elapsed().as_millis() as u64, "total_cost_usd": 0, "result": final_text
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Carpeta propia para cada prueba (corren en paralelo).
    fn tmp() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("pulso-localai-{}-{n}", std::process::id()));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::write(d.join("src/main.ts"), "const saludo = 'hola';\nexport function sumar(a: number, b: number) { return a + b; }\n").unwrap();
        std::fs::write(d.join("README.md"), "# Proyecto\nUsa sumar.\n").unwrap();
        std::fs::write(d.join("node_modules/x/index.js"), "sumar").unwrap();
        d
    }

    #[test]
    fn las_herramientas_no_salen_de_la_carpeta() {
        let root = tmp();
        assert!(resolve_in(&root, "../").is_err());
        assert!(resolve_in(&root, "src/../../").is_err());
        assert!(resolve_in(&root, if cfg!(windows) { "C:\\Windows\\win.ini" } else { "/etc/passwd" }).is_err());
        assert!(resolve_in(&root, "src/main.ts").is_ok());
        let (_, _, msg, err) = run_tool(&root, "read_file", &json!({ "path": "../secreto.txt" }));
        assert!(err, "{msg}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lista_lee_y_busca() {
        let root = tmp();
        let list = list_files(&root, ".").unwrap();
        assert!(list.starts_with("src/"), "{list}");
        assert!(!list.contains("node_modules"), "se omiten carpetas pesadas: {list}");
        let read = read_file(&root, "src/main.ts", Some(2), Some(1)).unwrap();
        assert!(read.contains("    2  export function sumar") && !read.contains("saludo"), "{read}");
        let found = search_code(&root, "SUMAR", None).unwrap();
        assert!(found.contains("src/main.ts:2:") && found.contains("README.md:2:"), "{found}");
        assert!(!found.contains("node_modules"), "{found}");
        let (name, input, _, err) = run_tool(&root, "read_file", &json!({ "path": "README.md" }));
        assert_eq!((name, input["file_path"].as_str(), err), ("Read", Some("README.md"), false));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lee_los_modelos_de_ollama() {
        let models = parse_models(&json!({ "models": [{ "name": "qwen2.5-coder:7b", "details": { "family": "qwen2", "parameter_size": "7.6B" } }] }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5-coder:7b");
        assert_eq!(models[0].note, "qwen2 · 7.6B");
    }

    /// Ollama simulado: primera vuelta pide leer un archivo; segunda responde con texto en dos trozos.
    fn fake_ollama() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = bodies.clone();
        std::thread::spawn(move || {
            for (n, stream) in listener.incoming().take(2).enumerate() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() { break; }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") { len = v.trim().parse().unwrap(); }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                log.lock().unwrap().push(String::from_utf8_lossy(&body).into_owned());
                let reply = if n == 0 {
                    "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"src/main.ts\"}}}]},\"done\":false}\n{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n".to_string()
                } else {
                    "{\"message\":{\"role\":\"assistant\",\"content\":\"sumar \"},\"done\":false}\n{\"message\":{\"role\":\"assistant\",\"content\":\"suma dos números.\"},\"done\":false}\n{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n".to_string()
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply);
            }
        });
        (base, bodies)
    }

    #[test]
    fn conversacion_con_herramienta_contra_un_ollama_simulado() {
        let root = tmp();
        let (base, bodies) = fake_ollama();
        let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = events.clone();
        let emit: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line| sink.lock().unwrap().push(serde_json::from_str(&line).unwrap()));
        tauri::async_runtime::block_on(run(
            base,
            "qwen2.5-coder:7b".into(),
            root.clone(),
            "c1".into(),
            vec![HistoryMsg { role: "user".into(), content: "hola".into() }, HistoryMsg { role: "assistant".into(), content: "¿En qué ayudo?".into() }],
            "¿Qué hace sumar?".into(),
            Arc::new(AtomicBool::new(false)),
            emit,
        ))
        .unwrap();
        let ev = events.lock().unwrap();
        let types: Vec<&str> = ev.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(types.first(), Some(&"system"));
        assert_eq!(types.last(), Some(&"result"));
        // La herramienta aparece como «Read» y su resultado lleva el contenido real del archivo.
        let tool = ev.iter().find(|e| e["type"] == "assistant" && e["message"]["content"][1]["name"] == "Read").expect("tool_use Read");
        assert_eq!(tool["message"]["content"][1]["input"]["file_path"], "src/main.ts");
        let result = ev.iter().find(|e| e["type"] == "user").unwrap();
        assert!(result["message"]["content"][0]["content"].as_str().unwrap().contains("export function sumar"));
        assert_eq!(ev.last().unwrap()["result"], "sumar suma dos números.");
        // La segunda llamada a Ollama incluye el historial, la petición y el resultado de la herramienta.
        let second: Value = serde_json::from_str(&bodies.lock().unwrap()[1]).unwrap();
        let roles: Vec<&str> = second["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "user", "assistant", "tool"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
