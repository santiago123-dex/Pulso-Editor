//! Cliente MCP (Model Context Protocol) del agente propio: herramientas de servidores externos, por entrada y salida estándar.
//!
//! Se configuran en `mcp.json`, en `~/.pulso/` (los tuyos, siempre) y en `.pulso/` del proyecto (solo si confías en él):
//!
//! ```json
//! { "servers": {
//!     "docs": { "command": "npx", "args": ["-y", "un-servidor-mcp"], "env": { "TOKEN": "…" } }
//! } }
//! ```
//!
//! Cada herramienta del servidor se ofrece al modelo como `mcp__servidor__herramienta`. Antes de **cada** llamada se pregunta a la persona
//! (igual que con las páginas web): un servidor MCP es código que se ejecuta con tus permisos y puede hacer cosas que Pulso no ve.
use crate::i18n::{tr, trf};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_SERVERS: usize = 8;
const MAX_TOOLS_PER_SERVER: usize = 64;
const MAX_LIST_PAGES: usize = 5;
const MAX_RESULT_CHARS: usize = 20_000;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_NAME_LEN: usize = 64;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

// ---------- Configuración ----------

#[derive(Clone, Debug, PartialEq)]
pub struct ServerDef {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Viene del proyecto (no de la carpeta personal).
    pub project: bool,
}

#[derive(Clone, Debug, Default)]
pub struct McpConfig {
    pub servers: Vec<ServerDef>,
}

/// Deja solo letras, números, `_` y `-` (lo que admiten los nombres de herramientas de los proveedores).
fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// Lee un `mcp.json` (acepta `servers` y también `mcpServers`). Lo que no se entiende se ignora.
pub fn parse_servers(text: &str, project: bool) -> Vec<ServerDef> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(map) = v["servers"].as_object().or_else(|| v["mcpServers"].as_object()) else { return Vec::new() };
    let mut out = Vec::new();
    for (name, def) in map {
        let command = def["command"].as_str().unwrap_or("").trim().to_string();
        let name = sanitize(name.trim());
        if command.is_empty() || name.is_empty() || def["disabled"].as_bool() == Some(true) {
            continue;
        }
        let args = def["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let env = def["env"].as_object().map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect()).unwrap_or_default();
        out.push(ServerDef { name, command, args, env, project });
    }
    out
}

impl McpConfig {
    /// Carga los servidores personales y, si hay `root`, los del proyecto (un nombre del proyecto no pisa a uno personal).
    pub fn load(root: &Path, home: Option<&Path>) -> McpConfig {
        let mut servers: Vec<ServerDef> = Vec::new();
        if let Some(h) = home {
            if let Some(t) = crate::agentconfig::read_small(&h.join(".pulso").join("mcp.json"), None) {
                servers.extend(parse_servers(&t, false));
            }
        }
        if let Some(t) = crate::agentconfig::read_small(&root.join(".pulso").join("mcp.json"), Some(root)) {
            for s in parse_servers(&t, true) {
                if !servers.iter().any(|x| x.name == s.name) {
                    servers.push(s);
                }
            }
        }
        servers.truncate(MAX_SERVERS);
        McpConfig { servers }
    }

    /// Sin confianza en el proyecto solo valen los servidores personales: los del proyecto son programas que escribió otra persona.
    pub fn without_project(mut self) -> McpConfig {
        self.servers.retain(|s| !s.project);
        self
    }
}

// ---------- Cliente ----------

type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;
type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

/// Escribe un mensaje JSON en una línea.
fn write_line(w: &Writer, msg: &Value) -> Result<(), String> {
    let mut w = w.lock().map_err(|e| e.to_string())?;
    let mut text = msg.to_string();
    text.push('\n');
    w.write_all(text.as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
}

/// Un servidor MCP en marcha. Funciona sobre cualquier par entrada/salida, para poder probarlo sin subproceso.
pub struct McpClient {
    seq: AtomicI64,
    writer: Writer,
    pending: Pending,
    pid: Option<u32>,
    child: Mutex<Option<Child>>,
    /// El servidor cerró su salida: ya no contestará a nada.
    closed: Arc<AtomicBool>,
}

impl McpClient {
    pub fn from_streams<R, W>(reader: R, writer: W, pid: Option<u32>, child: Option<Child>) -> Self
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let writer: Writer = Arc::new(Mutex::new(Box::new(writer)));
        let (pending_r, writer_r) = (Arc::clone(&pending), Arc::clone(&writer));
        let closed = Arc::new(AtomicBool::new(false));
        let closed_r = Arc::clone(&closed);
        std::thread::spawn(move || {
            let mut br = BufReader::new(reader);
            loop {
                let mut line = String::new();
                match br.by_ref().take(MAX_LINE_BYTES as u64).read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
                let has_method = msg.get("method").is_some();
                match (msg.get("id"), has_method) {
                    // Respuesta a una de nuestras peticiones.
                    (Some(id), false) => {
                        let Some(id) = id.as_i64() else { continue };
                        let tx = pending_r.lock().ok().and_then(|mut m| m.remove(&id));
                        if let Some(tx) = tx {
                            let res = match msg.get("error") {
                                Some(e) => Err(e["message"].as_str().unwrap_or("MCP error").to_string()),
                                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(res);
                        }
                    }
                    // Petición del servidor: solo se contesta `ping`; lo demás (muestreo, raíces…) no se ofrece.
                    (Some(id), true) => {
                        let reply = if msg["method"] == "ping" {
                            json!({ "jsonrpc": "2.0", "id": id, "result": {} })
                        } else {
                            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })
                        };
                        let _ = write_line(&writer_r, &reply);
                    }
                    // Notificaciones: se ignoran.
                    _ => {}
                }
            }
            closed_r.store(true, Ordering::SeqCst);
            if let Ok(mut map) = pending_r.lock() {
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err(tr("El servidor MCP se cerró.").into()));
                }
            }
        });
        McpClient { seq: AtomicI64::new(1), writer, pending, pid, child: Mutex::new(child), closed }
    }

    fn request(&self, method: &str, params: Value, timeout: Duration, cancel: &AtomicBool) -> Result<Value, String> {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        // Si el servidor ya se cerró, nadie va a contestar: no se espera al tiempo límite.
        if self.closed.load(Ordering::SeqCst) {
            let _ = self.pending.lock().map(|mut m| m.remove(&id));
            return Err(tr("El servidor MCP se cerró.").into());
        }
        if let Err(e) = write_line(&self.writer, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
            let _ = self.pending.lock().map(|mut m| m.remove(&id));
            return Err(e);
        }
        let deadline = Instant::now() + timeout;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(res) => return res,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let stop = if cancel.load(Ordering::Relaxed) {
                        Some(tr("La conversación se detuvo.").to_string())
                    } else if Instant::now() >= deadline {
                        Some(trf("El servidor MCP no respondió a «{method}» a tiempo.", &[("method", &method)]))
                    } else {
                        None
                    };
                    if let Some(msg) = stop {
                        let _ = self.pending.lock().map(|mut m| m.remove(&id));
                        let _ = write_line(&self.writer, &json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": id } }));
                        return Err(msg);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(tr("El servidor MCP se cerró.").into()),
            }
        }
    }

    fn notify(&self, method: &str) {
        let _ = write_line(&self.writer, &json!({ "jsonrpc": "2.0", "method": method }));
    }

    /// Saludo inicial del protocolo.
    pub fn initialize(&self, cancel: &AtomicBool) -> Result<(), String> {
        let params = json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "pulso-editor", "version": env!("CARGO_PKG_VERSION") } });
        self.request("initialize", params, START_TIMEOUT, cancel)?;
        self.notify("notifications/initialized");
        Ok(())
    }

    /// Las herramientas que ofrece el servidor (con paginación, con tope).
    pub fn list_tools(&self, cancel: &AtomicBool) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let r = self.request("tools/list", params, START_TIMEOUT, cancel)?;
            if let Some(list) = r["tools"].as_array() {
                out.extend(list.iter().cloned());
            }
            cursor = r["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
            if cursor.is_none() || out.len() >= MAX_TOOLS_PER_SERVER {
                break;
            }
        }
        out.truncate(MAX_TOOLS_PER_SERVER);
        Ok(out)
    }

    /// Llama a una herramienta. `(texto, es_error)`.
    pub fn call_tool(&self, tool: &str, args: &Value, cancel: &AtomicBool) -> Result<(String, bool), String> {
        let r = self.request("tools/call", json!({ "name": tool, "arguments": args }), CALL_TIMEOUT, cancel)?;
        Ok((result_text(&r), r["isError"].as_bool() == Some(true)))
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            crate::procguard::kill_tree(pid);
        }
        if let Some(mut c) = self.child.lock().ok().and_then(|mut c| c.take()) {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Texto de un resultado de `tools/call`: el texto tal cual y una nota por lo que Pulso no muestra (imágenes, audio).
pub fn result_text(r: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in r["content"].as_array().into_iter().flatten() {
        match c["type"].as_str().unwrap_or("") {
            "text" => parts.push(c["text"].as_str().unwrap_or("").to_string()),
            "resource" => match c["resource"]["text"].as_str() {
                Some(t) => parts.push(t.to_string()),
                None => parts.push(tr("[recurso binario omitido]").to_string()),
            },
            "image" | "audio" => parts.push(tr("[contenido binario omitido: Pulso solo pasa texto al modelo]").to_string()),
            _ => {}
        }
    }
    let mut text = parts.join("\n");
    if text.trim().is_empty() {
        if let Some(s) = r.get("structuredContent").filter(|s| !s.is_null()) {
            text = s.to_string();
        }
    }
    if text.chars().count() > MAX_RESULT_CHARS {
        text = text.chars().take(MAX_RESULT_CHARS).collect();
        text.push_str("\n… (truncated)");
    }
    text
}

// ---------- Arranque ----------

/// Busca el programa como lo haría un intérprete de comandos: en Windows `npx` es `npx.cmd`, que `Command` no encuentra solo.
fn resolve_program(program: &str) -> String {
    if !cfg!(windows) || program.contains(['\\', '/']) || Path::new(program).extension().is_some() {
        return program.to_string();
    }
    let exts: Vec<String> = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').filter(|e| !e.is_empty()).map(str::to_string).collect();
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for ext in &exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    program.to_string()
}

fn spawn_server(def: &ServerDef, root: &Path) -> Result<McpClient, String> {
    let mut cmd = crate::background_command(&resolve_program(&def.command));
    cmd.args(&def.args).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for (k, v) in &def.env {
        cmd.env(k, v);
    }
    crate::procguard::configure_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| trf("No se pudo iniciar el servidor MCP «{name}»: {e}", &[("name", &def.name), ("e", &e)]))?;
    crate::procguard::attach_job(&child);
    let pid = child.id();
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return Err(tr("No se pudo hablar con el servidor MCP.").to_string());
    };
    Ok(McpClient::from_streams(stdout, stdin, Some(pid), Some(child)))
}

/// Arranca un servidor, hace el saludo y le pide sus herramientas. El error ya trae el nombre del servidor.
fn connect(def: &ServerDef, root: &Path, cancel: &AtomicBool) -> Result<(McpClient, Vec<Value>), String> {
    let client = spawn_server(def, root)?;
    match client.initialize(cancel).and_then(|_| client.list_tools(cancel)) {
        Ok(list) => Ok((client, list)),
        Err(e) => Err(trf("El servidor MCP «{name}» no arrancó: {e}", &[("name", &def.name), ("e", &e)])),
    }
}

// ---------- Estado, para la pantalla de servidores ----------

#[derive(Clone, Debug, serde::Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
}

/// Cómo está un servidor configurado. `state`: `ok` (arrancó), `error` (no arrancó) o `blocked` (es del proyecto y todavía no se confía en él:
/// no se arranca).
#[derive(Clone, Debug, serde::Serialize)]
pub struct ServerStatus {
    pub name: String,
    /// El programa y sus argumentos, como se escribieron (sin las variables de entorno, que pueden llevar claves).
    pub command: String,
    pub project: bool,
    pub state: &'static str,
    pub error: String,
    pub tools: Vec<ToolInfo>,
}

fn command_line(def: &ServerDef) -> String {
    std::iter::once(def.command.as_str()).chain(def.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ").chars().take(300).collect()
}

fn status_of(def: &ServerDef, state: &'static str, error: String, tools: Vec<ToolInfo>) -> ServerStatus {
    ServerStatus { name: def.name.clone(), command: command_line(def), project: def.project, state, error, tools }
}

/// Arranca cada servidor (en paralelo), le pide sus herramientas y lo cierra. Los del proyecto solo se arrancan con `trusted`; sin
/// confianza salen como `blocked`, sin ejecutar nada. Devuelve un estado por servidor, en el orden de la configuración.
pub fn probe(config: &McpConfig, root: &Path, trusted: bool, cancel: &Arc<AtomicBool>) -> Vec<ServerStatus> {
    let handles: Vec<_> = config
        .servers
        .iter()
        .cloned()
        .map(|def| {
            let (root, cancel) = (root.to_path_buf(), Arc::clone(cancel));
            std::thread::spawn(move || {
                if def.project && !trusted {
                    return status_of(&def, "blocked", String::new(), vec![]);
                }
                match connect(&def, &root, &cancel) {
                    Ok((client, list)) => {
                        let tools = list
                            .iter()
                            .filter_map(|t| Some(ToolInfo { name: t["name"].as_str().filter(|n| !n.is_empty())?.to_string(), description: t["description"].as_str().unwrap_or("").chars().take(300).collect() }))
                            .collect();
                        drop(client);
                        status_of(&def, "ok", String::new(), tools)
                    }
                    Err(e) => status_of(&def, "error", e, vec![]),
                }
            })
        })
        .collect();
    handles
        .into_iter()
        .zip(&config.servers)
        .map(|(h, def)| h.join().unwrap_or_else(|_| status_of(def, "error", tr("Un servidor MCP falló al arrancar.").to_string(), vec![])))
        .collect()
}

// ---------- Herramientas ofrecidas al modelo ----------

pub struct McpTool {
    /// Nombre que ve el modelo: `mcp__servidor__herramienta`.
    pub full_name: String,
    pub server: String,
    /// Nombre original en el servidor.
    pub tool: String,
    description: String,
    schema: Value,
    client: Arc<McpClient>,
}

/// Los servidores arrancados y sus herramientas. Al soltarse se cierran los servidores.
#[derive(Default)]
pub struct McpTools {
    pub tools: Vec<McpTool>,
    /// Avisos para la persona (un servidor que no arrancó, por ejemplo).
    pub notes: Vec<String>,
}

fn full_name(server: &str, tool: &str, taken: &[McpTool]) -> String {
    let base = format!("mcp__{}__{}", sanitize(server), sanitize(tool));
    let mut name: String = base.chars().take(MAX_NAME_LEN).collect();
    let mut n = 2;
    while taken.iter().any(|t| t.full_name == name) {
        let suffix = format!("_{n}");
        name = format!("{}{suffix}", base.chars().take(MAX_NAME_LEN - suffix.len()).collect::<String>());
        n += 1;
    }
    name
}

impl McpTools {
    /// Arranca los servidores (en paralelo) y pide sus herramientas. Bloquea hasta terminar.
    pub fn start(config: &McpConfig, root: &Path, cancel: &Arc<AtomicBool>) -> McpTools {
        let handles: Vec<_> = config
            .servers
            .iter()
            .cloned()
            .map(|def| {
                let (root, cancel) = (root.to_path_buf(), Arc::clone(cancel));
                std::thread::spawn(move || -> Result<(String, Arc<McpClient>, Vec<Value>), String> {
                    let (client, list) = connect(&def, &root, &cancel)?;
                    Ok((def.name, Arc::new(client), list))
                })
            })
            .collect();
        let mut out = McpTools::default();
        for h in handles {
            match h.join() {
                Ok(Ok((server, client, list))) => out.add_server(&server, client, list),
                Ok(Err(e)) => out.notes.push(e),
                Err(_) => out.notes.push(tr("Un servidor MCP falló al arrancar.").to_string()),
            }
        }
        out
    }

    pub fn add_server(&mut self, server: &str, client: Arc<McpClient>, list: Vec<Value>) {
        for t in list {
            let Some(tool) = t["name"].as_str().filter(|n| !n.is_empty()) else { continue };
            let schema = if t["inputSchema"]["type"] == "object" { t["inputSchema"].clone() } else { json!({ "type": "object", "properties": {} }) };
            let full = full_name(server, tool, &self.tools);
            self.tools.push(McpTool {
                full_name: full,
                server: server.to_string(),
                tool: tool.to_string(),
                description: t["description"].as_str().unwrap_or("").to_string(),
                schema,
                client: Arc::clone(&client),
            });
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn get(&self, full_name: &str) -> Option<&McpTool> {
        self.tools.iter().find(|t| t.full_name == full_name)
    }

    /// Las herramientas en el formato de funciones que entiende `llm::specs_from_openai`.
    pub fn specs_json(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|t| {
                    let desc = format!("[MCP · {}] {}", t.server, t.description);
                    json!({ "type": "function", "function": { "name": t.full_name, "description": desc, "parameters": t.schema } })
                })
                .collect(),
        )
    }
}

impl McpTool {
    /// Lo que se le enseña a la persona al pedirle permiso.
    pub fn approval_detail(&self, args: &Value) -> String {
        let mut shown = serde_json::to_string_pretty(args).unwrap_or_default();
        if shown.chars().count() > 1_500 {
            shown = shown.chars().take(1_500).collect::<String>() + "…";
        }
        format!("{} → {}\n{shown}", self.server, self.tool)
    }

    pub fn call(&self, args: &Value, cancel: &AtomicBool) -> Result<(String, bool), String> {
        self.client.call_tool(&self.tool, args, cancel)
    }

    pub fn client(&self) -> Arc<McpClient> {
        Arc::clone(&self.client)
    }
}

/// Un servidor MCP simulado en memoria, para las pruebas de este módulo y las del bucle del agente.
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Condvar;

    /// Un «tubo» en memoria: lo que se escribe por un extremo se lee por el otro.
    #[derive(Clone, Default)]
    pub struct Pipe(Arc<(Mutex<(VecDeque<u8>, bool)>, Condvar)>);

    impl Pipe {
        pub fn close(&self) {
            let (m, c) = &*self.0;
            m.lock().unwrap().1 = true;
            c.notify_all();
        }
    }

    impl Write for Pipe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (m, c) = &*self.0;
            m.lock().unwrap().0.extend(buf);
            c.notify_all();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let (m, c) = &*self.0;
            let mut g = m.lock().unwrap();
            while g.0.is_empty() {
                if g.1 {
                    return Ok(0);
                }
                g = c.wait(g).unwrap();
            }
            let n = buf.len().min(g.0.len());
            for slot in buf.iter_mut().take(n) {
                *slot = g.0.pop_front().unwrap();
            }
            Ok(n)
        }
    }

    /// Servidor MCP simulado: contesta `initialize`, `tools/list` (dos páginas) y `tools/call`; pide un `ping` y una petición desconocida.
    fn mock_server(to_server: Pipe, from_server: Pipe) {
        std::thread::spawn(move || {
            let mut br = BufReader::new(to_server);
            let mut out = from_server.clone();
            let mut say = |v: Value| {
                let mut s = v.to_string();
                s.push('\n');
                out.write_all(s.as_bytes()).unwrap();
            };
            loop {
                let mut line = String::new();
                if br.read_line(&mut line).unwrap_or(0) == 0 {
                    from_server.close();
                    return;
                }
                let Ok(m) = serde_json::from_str::<Value>(line.trim()) else { continue };
                let (Some(id), Some(method)) = (m.get("id").cloned(), m["method"].as_str()) else { continue };
                match method {
                    "initialize" => say(json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": PROTOCOL_VERSION, "capabilities": { "tools": {} }, "serverInfo": { "name": "mock", "version": "1" } } })),
                    "tools/list" => {
                        if m["params"]["cursor"].is_null() {
                            say(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [{ "name": "echo", "description": "Repite el texto", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } } }], "nextCursor": "p2" } }));
                        } else {
                            say(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [{ "name": "echo", "description": "Otra con el mismo nombre" }, { "name": "falla.mal nombre" }] } }));
                        }
                    }
                    "tools/call" => {
                        // Antes de contestar, el servidor hace dos peticiones al cliente (una conocida y otra no).
                        say(json!({ "jsonrpc": "2.0", "id": 900, "method": "ping" }));
                        say(json!({ "jsonrpc": "2.0", "id": 901, "method": "sampling/createMessage", "params": {} }));
                        let name = m["params"]["name"].as_str().unwrap_or("");
                        if name == "echo" {
                            let text = m["params"]["arguments"]["text"].as_str().unwrap_or("");
                            say(json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": format!("eco: {text}") }, { "type": "image", "data": "AAAA", "mimeType": "image/png" }] } }));
                        } else if name == "colgar" {
                            // No contesta nunca.
                        } else {
                            say(json!({ "jsonrpc": "2.0", "id": id, "result": { "isError": true, "content": [{ "type": "text", "text": "no existe" }] } }));
                        }
                    }
                    _ => say(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })),
                }
            }
        });
    }

    pub fn client() -> (McpClient, Pipe, Pipe) {
        let (to_server, from_server) = (Pipe::default(), Pipe::default());
        mock_server(to_server.clone(), from_server.clone());
        (McpClient::from_streams(from_server.clone(), to_server.clone(), None, None), to_server, from_server)
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::client;
    use super::*;

    #[test]
    fn parses_servers_and_ignores_the_broken_ones() {
        let text = r#"{ "servers": {
            "docs": { "command": "npx", "args": ["-y", "pkg", 3], "env": { "TOKEN": "abc", "N": 1 } },
            "sin comando": { "args": [] },
            "apagado": { "command": "x", "disabled": true },
            "con espacios y ñ": { "command": "node" }
        } }"#;
        let s = parse_servers(text, true);
        assert_eq!(s.len(), 2);
        let docs = s.iter().find(|d| d.name == "docs").unwrap();
        assert_eq!(*docs, ServerDef { name: "docs".into(), command: "npx".into(), args: vec!["-y".into(), "pkg".into()], env: vec![("TOKEN".into(), "abc".into())], project: true });
        assert!(s.iter().any(|d| d.name == "con_espacios_y__"));
        assert!(parse_servers("{ no es json", false).is_empty());
        assert!(parse_servers(r#"{"mcpServers": {"a": {"command": "x"}}}"#, false).len() == 1);
    }

    #[test]
    fn project_servers_need_trust_and_do_not_override_personal_ones() {
        let base = std::env::temp_dir().join(format!("pulso-mcp-cfg-{}", std::process::id()));
        let (home, root) = (base.join("home"), base.join("proj"));
        std::fs::create_dir_all(home.join(".pulso")).unwrap();
        std::fs::create_dir_all(root.join(".pulso")).unwrap();
        std::fs::write(home.join(".pulso").join("mcp.json"), r#"{"servers":{"a":{"command":"mio"}}}"#).unwrap();
        std::fs::write(root.join(".pulso").join("mcp.json"), r#"{"servers":{"a":{"command":"ajeno"},"b":{"command":"otro"}}}"#).unwrap();
        let cfg = McpConfig::load(&root, Some(&home));
        assert_eq!(cfg.servers.iter().map(|s| (s.name.as_str(), s.command.as_str(), s.project)).collect::<Vec<_>>(), vec![("a", "mio", false), ("b", "otro", true)]);
        let sin = cfg.without_project();
        assert_eq!(sin.servers.len(), 1);
        assert_eq!(sin.servers[0].command, "mio");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn handshake_lists_tools_across_pages_and_names_them_safely() {
        let (c, _, _) = client();
        let cancel = AtomicBool::new(false);
        c.initialize(&cancel).unwrap();
        let list = c.list_tools(&cancel).unwrap();
        assert_eq!(list.len(), 3);
        let mut tools = McpTools::default();
        tools.add_server("mi servidor", Arc::new(c), list);
        let names: Vec<&str> = tools.tools.iter().map(|t| t.full_name.as_str()).collect();
        // Los dos `echo` no chocan y el nombre raro queda con caracteres válidos.
        assert_eq!(names, vec!["mcp__mi_servidor__echo", "mcp__mi_servidor__echo_2", "mcp__mi_servidor__falla_mal_nombre"]);
        assert_eq!(tools.get("mcp__mi_servidor__echo_2").unwrap().tool, "echo");
        let specs = crate::llm::specs_from_openai(&tools.specs_json());
        assert_eq!(specs.len(), 3);
        assert!(specs[0].description.starts_with("[MCP · mi servidor]"));
        // Sin esquema, se ofrece uno vacío válido.
        assert_eq!(specs[1].parameters["type"], "object");
    }

    #[test]
    fn long_names_are_cut_to_the_provider_limit() {
        let long = "x".repeat(100);
        let n = full_name("srv", &long, &[]);
        assert_eq!(n.chars().count(), MAX_NAME_LEN);
    }

    #[test]
    fn calls_a_tool_answers_server_requests_and_omits_binary_content() {
        let (c, _, _) = client();
        let cancel = AtomicBool::new(false);
        c.initialize(&cancel).unwrap();
        let (text, is_error) = c.call_tool("echo", &json!({ "text": "hola" }), &cancel).unwrap();
        assert!(!is_error);
        assert!(text.starts_with("eco: hola"), "{text}");
        assert!(text.contains("binario omitido"), "{text}");
        // Sigue funcionando después de las peticiones del servidor (ping y una desconocida).
        let (text, is_error) = c.call_tool("no-existe", &json!({}), &cancel).unwrap();
        assert!(is_error && text == "no existe");
    }

    #[test]
    fn cancelling_stops_a_call_that_never_answers() {
        let (c, _, _) = client();
        let cancel = Arc::new(AtomicBool::new(false));
        c.initialize(&cancel).unwrap();
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let e = c.call_tool("colgar", &json!({}), &cancel).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!e.is_empty());
    }

    #[test]
    fn a_closed_server_fails_pending_requests() {
        let (c, to_server, from_server) = client();
        let cancel = AtomicBool::new(false);
        c.initialize(&cancel).unwrap();
        to_server.close();
        from_server.close();
        // El cliente se entera de que se cerró en otro hilo: se espera a que lo note (si no, la llamada podría llegar antes).
        let deadline = Instant::now() + Duration::from_secs(10);
        while !c.closed.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(c.closed.load(Ordering::SeqCst));
        assert!(c.call_tool("echo", &json!({}), &cancel).is_err());
    }

    #[test]
    fn result_text_handles_structured_content_and_truncates() {
        assert_eq!(result_text(&json!({ "structuredContent": { "a": 1 } })), r#"{"a":1}"#);
        assert_eq!(result_text(&json!({ "content": [{ "type": "resource", "resource": { "text": "contenido" } }] })), "contenido");
        let big = "y".repeat(MAX_RESULT_CHARS + 50);
        let t = result_text(&json!({ "content": [{ "type": "text", "text": big }] }));
        assert!(t.ends_with("(truncated)") && t.chars().count() < MAX_RESULT_CHARS + 30);
    }

    /// Con un proceso de verdad (necesita `node`; si no está, la prueba no hace nada) y con uno que no existe.
    #[test]
    fn starts_a_real_server_process_and_reports_one_that_cannot_start() {
        if std::process::Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("pulso-mcp-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = r#"
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const send = (r) => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }));
  if (m.method === 'initialize') send({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'n', version: '1' } } });
  else if (m.method === 'tools/list') send({ result: { tools: [{ name: 'suma', description: 'suma', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] } });
  else if (m.method === 'tools/call') send({ result: { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] } });
});
"#;
        std::fs::write(dir.join("server.js"), script).unwrap();
        let def = |name: &str, command: &str, args: Vec<String>| ServerDef { name: name.into(), command: command.into(), args, env: vec![], project: false };
        let config = McpConfig { servers: vec![def("js", "node", vec!["server.js".into()]), def("roto", "programa-que-no-existe-pulso", vec![])] };
        let cancel = Arc::new(AtomicBool::new(false));
        let tools = McpTools::start(&config, &dir, &cancel);
        assert_eq!(tools.notes.len(), 1, "{:?}", tools.notes);
        assert!(tools.notes[0].contains("roto"), "{:?}", tools.notes);
        let t = tools.get("mcp__js__suma").expect("la herramienta del servidor real");
        let (text, is_error) = t.call(&json!({ "a": 2, "b": 3 }), &cancel).unwrap();
        assert_eq!((text.as_str(), is_error), ("5", false));
        drop(tools);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El sondeo de la pantalla de servidores: uno que funciona, uno que no existe y uno del proyecto sin confianza, que **no se ejecuta**
    /// (necesita `node`; si no está, la prueba no hace nada).
    #[test]
    fn probe_reports_each_server_and_never_runs_an_untrusted_project_one() {
        if std::process::Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("pulso-mcp-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("se-ejecuto.txt");
        // Si este servidor llegara a arrancar, dejaría un archivo.
        std::fs::write(dir.join("peligroso.js"), "require('fs').writeFileSync('se-ejecuto.txt', 'x'); setTimeout(() => {}, 60000);").unwrap();
        std::fs::write(
            dir.join("server.js"),
            "const rl = require('readline').createInterface({ input: process.stdin });\nrl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;\n  const send = (r) => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }));\n  if (m.method === 'initialize') send({ result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'n', version: '1' } } });\n  else if (m.method === 'tools/list') send({ result: { tools: [{ name: 'suma', description: 'Suma dos números' }, { name: 'resta' }] } }); });",
        )
        .unwrap();
        let def = |name: &str, command: &str, args: &[&str], project: bool| ServerDef { name: name.into(), command: command.into(), args: args.iter().map(|a| a.to_string()).collect(), env: vec![("TOKEN".into(), "secreto".into())], project };
        let config = McpConfig {
            servers: vec![def("js", "node", &["server.js"], false), def("roto", "programa-que-no-existe-pulso", &[], false), def("ajeno", "node", &["peligroso.js"], true)],
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let s = probe(&config, &dir, false, &cancel);
        assert_eq!(s.iter().map(|x| (x.name.as_str(), x.state)).collect::<Vec<_>>(), vec![("js", "ok"), ("roto", "error"), ("ajeno", "blocked")]);
        assert_eq!(s[0].tools.iter().map(|t| (t.name.as_str(), t.description.as_str())).collect::<Vec<_>>(), vec![("suma", "Suma dos números"), ("resta", "")]);
        assert!(s[1].error.contains("roto"), "{}", s[1].error);
        assert!(s[2].tools.is_empty() && s[2].project);
        // Las variables de entorno (pueden llevar claves) no salen en el estado.
        assert!(!format!("{s:?}").contains("secreto"));
        assert_eq!(s[0].command, "node server.js");
        std::thread::sleep(Duration::from_millis(500));
        assert!(!marker.exists(), "un servidor del proyecto sin confianza no debe ejecutarse");
        // Con confianza sí se arranca (y se cierra al terminar el sondeo).
        let trusted = probe(&McpConfig { servers: vec![def("ajeno", "node", &["server.js"], true)] }, &dir, true, &cancel);
        assert_eq!(trusted[0].state, "ok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_finds_cmd_shims_such_as_npx() {
        if !cfg!(windows) || std::process::Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let p = resolve_program("npx");
        assert!(p.to_lowercase().ends_with(".cmd"), "{p}");
        // Con ruta o con extensión se deja como está.
        assert_eq!(resolve_program("C:\\x\\y.exe"), "C:\\x\\y.exe");
        assert_eq!(resolve_program("node.exe"), "node.exe");
    }

    #[test]
    fn approval_detail_shows_server_tool_and_arguments() {
        let (c, _, _) = client();
        let mut tools = McpTools::default();
        tools.add_server("docs", Arc::new(c), vec![json!({ "name": "buscar" })]);
        let d = tools.get("mcp__docs__buscar").unwrap().approval_detail(&json!({ "q": "rust" }));
        assert!(d.starts_with("docs → buscar\n") && d.contains("\"q\": \"rust\""), "{d}");
    }
}
