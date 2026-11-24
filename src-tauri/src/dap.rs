//! Cliente del protocolo DAP (Debug Adapter Protocol) en Rust:
//! framing `Content-Length`, ciclo de vida de sesión, puntos de interrupción,
//! pila de llamadas, variables y consola de evaluación.
use crate::dap_config::{
    default_launch_template, expand_vars, load_workspace_configs, resolve_adapter, LaunchConfig,
};
use crate::fsguard::WorkspaceGuard;
use crate::i18n::{tr, trf};
use crate::{background_command, procguard};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{ChildStdin, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Lee un mensaje DAP enmarcado con `Content-Length: N\r\n\r\n<JSON>`.
pub fn read_dap_message<R: BufRead>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("Content-Length") {
                content_length = v.trim().parse::<usize>().ok();
            }
        }
    }
    let len = content_length.ok_or_else(|| tr("Mensaje DAP sin cabecera Content-Length.").to_string())?;
    if len > 16 * 1024 * 1024 {
        return Err(tr("Mensaje DAP demasiado grande.").to_string());
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let val: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
    Ok(Some(val))
}

/// Escribe un mensaje DAP con su cabecera `Content-Length`.
pub fn write_dap_message<W: Write>(writer: &mut W, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    writer.write_all(&body).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapEventPayload {
    pub event: String,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapBreakpointInput {
    pub path: String,
    pub lines: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapStackFrame {
    pub id: i64,
    pub name: String,
    pub source: Option<String>,
    pub line: i64,
    pub column: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapScope {
    pub name: String,
    pub variables_reference: i64,
    pub expensive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapVariable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub var_type: String,
    pub variables_reference: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapEvalResult {
    pub result: String,
    #[serde(rename = "type")]
    pub var_type: String,
    pub variables_reference: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapConfigsResponse {
    pub trusted: bool,
    pub configs: Vec<LaunchConfig>,
}

type PendingMap = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;

/// Cliente DAP genérico sobre cualquier par entrada/salida (permite pruebas unitarias sin subproceso).
pub struct DapClient {
    seq: AtomicI64,
    writer: Mutex<Box<dyn Write + Send>>,
    pending: PendingMap,
    pid: Option<u32>,
}

impl DapClient {
    pub fn from_streams<R, W, F>(reader: R, writer: W, pid: Option<u32>, on_event: F) -> Self
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
        F: Fn(DapEventPayload) + Send + Sync + 'static,
    {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = Arc::clone(&pending);
        std::thread::spawn(move || {
            let mut br = BufReader::new(reader);
            loop {
                match read_dap_message(&mut br) {
                    Ok(Some(msg)) => {
                        let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
                        match kind {
                            "response" => {
                                let req_seq = msg.get("request_seq").and_then(Value::as_i64).unwrap_or(0);
                                let tx = pending_reader.lock().ok().and_then(|mut m| m.remove(&req_seq));
                                if let Some(tx) = tx {
                                    let ok = msg.get("success").and_then(Value::as_bool).unwrap_or(false);
                                    if ok {
                                        let _ = tx.send(Ok(msg.get("body").cloned().unwrap_or(Value::Null)));
                                    } else {
                                        let err = msg
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Error del adaptador DAP")
                                            .to_string();
                                        let _ = tx.send(Err(err));
                                    }
                                }
                            }
                            "event" => {
                                let event = msg.get("event").and_then(Value::as_str).unwrap_or("").to_string();
                                let body = msg.get("body").cloned().unwrap_or(Value::Null);
                                on_event(DapEventPayload { event, body });
                            }
                            _ => {}
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            if let Ok(mut map) = pending_reader.lock() {
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err(tr("La sesión de depuración terminó inesperadamente. Si depuras Python, comprueba que debugpy esté instalado (`pip install debugpy`).").into()));
                }
            }
            on_event(DapEventPayload {
                event: "terminated".into(),
                body: json!({}),
            });
        });

        Self {
            seq: AtomicI64::new(1),
            writer: Mutex::new(Box::new(writer)),
            pending,
            pid,
        }
    }

    pub fn request(&self, command: &str, arguments: Value, timeout: Duration) -> Result<Value, String> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(seq, tx);

        let payload = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        {
            let mut w = self.writer.lock().map_err(|e| e.to_string())?;
            if let Err(e) = write_dap_message(&mut *w, &payload) {
                let _ = self.pending.lock().map(|mut m| m.remove(&seq));
                return Err(e);
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(res) => res,
            Err(_) => {
                let _ = self.pending.lock().map(|mut m| m.remove(&seq));
                Err(trf(
                    "El depurador no respondió a «{command}» a tiempo.",
                    &[("command", &command)],
                ))
            }
        }
    }

    pub fn shutdown(&self) {
        let _ = self.request(
            "disconnect",
            json!({ "terminateDebuggee": true }),
            Duration::from_millis(800),
        );
        if let Some(pid) = self.pid {
            procguard::kill_tree(pid);
        }
    }
}

#[derive(Default)]
pub struct DapState {
    session: Mutex<Option<Arc<DapClient>>>,
}

impl DapState {
    pub fn stop(&self) {
        if let Ok(mut guard) = self.session.lock() {
            if let Some(client) = guard.take() {
                client.shutdown();
            }
        }
    }

    fn current(&self) -> Result<Arc<DapClient>, String> {
        self.session
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| tr("No hay ninguna sesión de depuración activa.").into())
    }
}

fn spawn_adapter(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    on_event: impl Fn(DapEventPayload) + Send + Sync + 'static,
) -> Result<DapClient, String> {
    let mut cmd = background_command(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    procguard::configure_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        trf(
            "No se pudo iniciar el adaptador de depuración ({program}): {e}",
            &[("program", &program), ("e", &e)],
        )
    })?;
    procguard::attach_job(&child);
    let pid = child.id();
    let stdin: ChildStdin = child
        .stdin
        .take()
        .ok_or_else(|| tr("El adaptador de depuración no abrió entrada estándar.").to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| tr("El adaptador de depuración no abrió salida estándar.").to_string())?;
    let stderr = child.stderr.take();

    let on_event = Arc::new(on_event);
    if let Some(err_stream) = stderr {
        let emit_err = Arc::clone(&on_event);
        std::thread::spawn(move || {
            let reader = BufReader::new(err_stream);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    emit_err(DapEventPayload {
                        event: "output".into(),
                        body: json!({ "category": "stderr", "output": format!("{line}\n") }),
                    });
                }
            }
        });
    }

    procguard::reap_detached(child);
    let emit_main = Arc::clone(&on_event);
    Ok(DapClient::from_streams(stdout, stdin, Some(pid), move |ev| {
        emit_main(ev);
    }))
}

#[tauri::command]
pub fn dap_list_configs(
    app: AppHandle,
    guard: State<'_, WorkspaceGuard>,
    active_file: Option<String>,
) -> Result<DapConfigsResponse, String> {
    let root = guard
        .current_root()
        .ok_or_else(|| tr("Abre una carpeta antes de usar el depurador.").to_string())?;
    Ok(DapConfigsResponse {
        trusted: crate::aichat::project_trusted(&app, &root),
        configs: load_workspace_configs(&root, active_file.as_deref()),
    })
}

#[tauri::command]
pub fn dap_create_launch_file(guard: State<'_, WorkspaceGuard>) -> Result<String, String> {
    let root = guard
        .current_root()
        .ok_or_else(|| tr("Abre una carpeta antes de usar el depurador.").to_string())?;
    let target = root.join(".pulso").join("launch.json");
    let target_str = target.to_string_lossy().into_owned();
    let safe = guard.ensure_write(&target_str)?;
    if !safe.exists() {
        if let Some(parent) = safe.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&safe, default_launch_template()).map_err(|e| e.to_string())?;
    }
    Ok(crate::norm(&safe))
}

#[tauri::command]
pub async fn dap_launch(
    app: AppHandle,
    state: State<'_, DapState>,
    guard: State<'_, WorkspaceGuard>,
    config_name: String,
    active_file: Option<String>,
    breakpoints: Vec<DapBreakpointInput>,
) -> Result<(), String> {
    let root = guard
        .current_root()
        .ok_or_else(|| tr("Abre una carpeta antes de usar el depurador.").to_string())?;
    if !crate::aichat::project_trusted(&app, &root) {
        return Err(tr("Esta carpeta no es de confianza. Confía en el proyecto antes de depurar código.").into());
    }
    // La configuración se lee de los archivos del proyecto, no de lo que mande la ventana: así la ventana no puede
    // inventarse un `adapterCommand` ni un programa que ejecutar.
    let config = load_workspace_configs(&root, active_file.as_deref())
        .into_iter()
        .find(|c| c.name == config_name)
        .ok_or_else(|| tr("No existe esa configuración de depuración.").to_string())?;

    let root_str = root.to_string_lossy().into_owned();
    let program_raw = expand_vars(&config.program, &root_str, active_file.as_deref());
    if program_raw.trim().is_empty() {
        return Err(tr("Indica un archivo de programa para depurar o abre un archivo en el editor.").into());
    }
    let program_path = if Path::new(&program_raw).is_absolute() {
        program_raw
    } else {
        root.join(&program_raw).to_string_lossy().into_owned()
    };
    let safe_program = guard.ensure_read(&program_path)?;

    let cwd_raw = config
        .cwd
        .as_deref()
        .map(|c| expand_vars(c, &root_str, active_file.as_deref()))
        .unwrap_or_else(|| root_str.clone());
    let safe_cwd = guard.ensure_read(&cwd_raw)?;
    if !safe_cwd.is_dir() {
        return Err(tr("El directorio de trabajo de depuración no es una carpeta válida.").into());
    }

    let mut safe_bps: Vec<(String, Vec<u32>)> = Vec::new();
    for bp in breakpoints {
        if bp.lines.is_empty() {
            continue;
        }
        if let Ok(p) = guard.ensure_read(&bp.path) {
            safe_bps.push((p.to_string_lossy().into_owned(), bp.lines));
        }
    }

    let (adapter_bin, adapter_args) = resolve_adapter(&config, &root)?;
    let args: Vec<String> = config
        .args
        .iter()
        .map(|a| expand_vars(a, &root_str, active_file.as_deref()))
        .collect();
    let env = config.env.clone();

    // Detiene cualquier sesión previa antes de lanzar una nueva.
    state.stop();

    let app_clone = app.clone();
    let client = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<DapClient>, String> {
        let client = Arc::new(spawn_adapter(&adapter_bin, &adapter_args, &safe_cwd, &env, move |ev| {
            let _ = app_clone.emit("dap-event", ev);
        })?);

        client.request(
            "initialize",
            json!({
                "clientID": "pulso-editor",
                "clientName": "Pulso Editor",
                "adapterID": config.kind,
                "pathFormat": "path",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "supportsVariableType": true,
                "supportsRunInTerminalRequest": false
            }),
            Duration::from_secs(10),
        )?;

        let launch_args = json!({
            "name": config.name,
            "type": config.kind,
            "request": "launch",
            "program": safe_program.to_string_lossy(),
            "args": args,
            "cwd": safe_cwd.to_string_lossy(),
            "env": env,
            "console": "internalConsole",
            "redirectOutput": true,
            "justMyCode": true
        });
        client.request("launch", launch_args, Duration::from_secs(15))?;

        for (bp_path, lines) in safe_bps {
            let bps: Vec<Value> = lines.into_iter().map(|line| json!({ "line": line })).collect();
            let _ = client.request(
                "setBreakpoints",
                json!({
                    "source": { "path": bp_path },
                    "breakpoints": bps,
                }),
                Duration::from_secs(5),
            );
        }

        let _ = client.request("configurationDone", json!({}), Duration::from_secs(10));
        Ok(client)
    })
    .await
    .map_err(|e| e.to_string())??;

    *state.session.lock().map_err(|e| e.to_string())? = Some(client);
    Ok(())
}

#[tauri::command]
pub async fn dap_stop(state: State<'_, DapState>) -> Result<(), String> {
    let client = state.session.lock().map_err(|e| e.to_string())?.take();
    if let Some(c) = client {
        let _ = tauri::async_runtime::spawn_blocking(move || c.shutdown()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn dap_set_breakpoints(
    state: State<'_, DapState>,
    guard: State<'_, WorkspaceGuard>,
    path: String,
    lines: Vec<u32>,
) -> Result<Value, String> {
    let safe = guard.ensure_read(&path)?;
    let client = state.current()?;
    let bps: Vec<Value> = lines.into_iter().map(|line| json!({ "line": line })).collect();
    tauri::async_runtime::spawn_blocking(move || {
        client.request(
            "setBreakpoints",
            json!({
                "source": { "path": safe.to_string_lossy() },
                "breakpoints": bps,
            }),
            Duration::from_secs(5),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dap_continue(state: State<'_, DapState>, thread_id: i64) -> Result<(), String> {
    let client = state.current()?;
    tauri::async_runtime::spawn_blocking(move || {
        client.request("continue", json!({ "threadId": thread_id }), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn dap_next(state: State<'_, DapState>, thread_id: i64) -> Result<(), String> {
    let client = state.current()?;
    tauri::async_runtime::spawn_blocking(move || {
        client.request("next", json!({ "threadId": thread_id }), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn dap_step_in(state: State<'_, DapState>, thread_id: i64) -> Result<(), String> {
    let client = state.current()?;
    tauri::async_runtime::spawn_blocking(move || {
        client.request("stepIn", json!({ "threadId": thread_id }), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn dap_step_out(state: State<'_, DapState>, thread_id: i64) -> Result<(), String> {
    let client = state.current()?;
    tauri::async_runtime::spawn_blocking(move || {
        client.request("stepOut", json!({ "threadId": thread_id }), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn dap_pause(state: State<'_, DapState>, thread_id: i64) -> Result<(), String> {
    let client = state.current()?;
    tauri::async_runtime::spawn_blocking(move || {
        client.request("pause", json!({ "threadId": thread_id }), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn dap_stack_trace(state: State<'_, DapState>, thread_id: i64) -> Result<Vec<DapStackFrame>, String> {
    let client = state.current()?;
    let body = tauri::async_runtime::spawn_blocking(move || {
        client.request(
            "stackTrace",
            json!({ "threadId": thread_id, "startFrame": 0, "levels": 40 }),
            Duration::from_secs(5),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let frames = body
        .get("stackFrames")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|f| DapStackFrame {
                    id: f.get("id").and_then(Value::as_i64).unwrap_or(0),
                    name: f.get("name").and_then(Value::as_str).unwrap_or("<frame>").to_string(),
                    source: f
                        .get("source")
                        .and_then(|s| s.get("path"))
                        .and_then(Value::as_str)
                        .map(|p| p.replace('\\', "/")),
                    line: f.get("line").and_then(Value::as_i64).unwrap_or(1),
                    column: f.get("column").and_then(Value::as_i64).unwrap_or(1),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(frames)
}

#[tauri::command]
pub async fn dap_scopes(state: State<'_, DapState>, frame_id: i64) -> Result<Vec<DapScope>, String> {
    let client = state.current()?;
    let body = tauri::async_runtime::spawn_blocking(move || {
        client.request("scopes", json!({ "frameId": frame_id }), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    let scopes = body
        .get("scopes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|s| DapScope {
                    name: s.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    variables_reference: s.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
                    expensive: s.get("expensive").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(scopes)
}

#[tauri::command]
pub async fn dap_variables(state: State<'_, DapState>, variables_reference: i64) -> Result<Vec<DapVariable>, String> {
    let client = state.current()?;
    let body = tauri::async_runtime::spawn_blocking(move || {
        client.request(
            "variables",
            json!({ "variablesReference": variables_reference }),
            Duration::from_secs(5),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let vars = body
        .get("variables")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|v| DapVariable {
                    name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    value: v.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                    var_type: v.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
                    variables_reference: v.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(vars)
}

#[tauri::command]
pub async fn dap_evaluate(
    state: State<'_, DapState>,
    expression: String,
    frame_id: Option<i64>,
) -> Result<DapEvalResult, String> {
    let client = state.current()?;
    let body = tauri::async_runtime::spawn_blocking(move || {
        let mut args = json!({ "expression": expression, "context": "repl" });
        if let Some(fid) = frame_id {
            args["frameId"] = json!(fid);
        }
        client.request("evaluate", args, Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(DapEvalResult {
        result: body.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
        var_type: body.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
        variables_reference: body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct ChanWriter(mpsc::Sender<Vec<u8>>);
    impl Write for ChanWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.send(buf.to_vec()).map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"))?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct ChanReader {
        rx: mpsc::Receiver<Vec<u8>>,
        buf: Vec<u8>,
        pos: usize,
    }
    impl Read for ChanReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.buf.len() {
                match self.rx.recv() {
                    Ok(chunk) => {
                        self.buf = chunk;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = (self.buf.len() - self.pos).min(out.len());
            out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    #[test]
    fn framing_roundtrip_preserves_utf8_json() {
        let mut buf = Vec::new();
        let msg = json!({"seq": 1, "type": "request", "command": "evaluate", "arguments": {"expression": "ñandú"}});
        write_dap_message(&mut buf, &msg).unwrap();
        let mut cur = Cursor::new(buf);
        let decoded = read_dap_message(&mut cur).unwrap().unwrap();
        assert_eq!(decoded, msg);
        assert!(read_dap_message(&mut cur).unwrap().is_none());
    }

    #[test]
    fn client_handles_request_response_and_events() {
        let (c2s_tx, c2s_rx) = mpsc::channel::<Vec<u8>>();
        let (s2c_tx, s2c_rx) = mpsc::channel::<Vec<u8>>();

        // Servidor DAP simulado en hilo aparte.
        std::thread::spawn(move || {
            let mut reader = BufReader::new(ChanReader { rx: c2s_rx, buf: Vec::new(), pos: 0 });
            let mut writer = ChanWriter(s2c_tx);
            while let Ok(Some(req)) = read_dap_message(&mut reader) {
                let seq = req["seq"].as_i64().unwrap_or(1);
                let cmd = req["command"].as_str().unwrap_or("");
                match cmd {
                    "initialize" => {
                        let _ = write_dap_message(&mut writer, &json!({
                            "seq": 1, "type": "response", "request_seq": seq, "success": true, "command": cmd, "body": {"supportsConfigurationDoneRequest": true}
                        }));
                        let _ = write_dap_message(&mut writer, &json!({
                            "seq": 2, "type": "event", "event": "initialized", "body": {}
                        }));
                    }
                    "evaluate" => {
                        let _ = write_dap_message(&mut writer, &json!({
                            "seq": 3, "type": "response", "request_seq": seq, "success": true, "command": cmd, "body": {"result": "42", "type": "int", "variablesReference": 0}
                        }));
                    }
                    "fail_cmd" => {
                        let _ = write_dap_message(&mut writer, &json!({
                            "seq": 4, "type": "response", "request_seq": seq, "success": false, "command": cmd, "message": "fallo simulado"
                        }));
                    }
                    _ => break,
                }
            }
        });

        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let ev_clone = Arc::clone(&events);
        let client = DapClient::from_streams(
            ChanReader { rx: s2c_rx, buf: Vec::new(), pos: 0 },
            ChanWriter(c2s_tx),
            None,
            move |ev| {
                if let Ok(mut list) = ev_clone.lock() {
                    list.push(ev.event);
                }
            },
        );

        let init = client.request("initialize", json!({}), Duration::from_secs(2)).unwrap();
        assert_eq!(init["supportsConfigurationDoneRequest"], json!(true));

        let eval = client.request("evaluate", json!({"expression": "21*2"}), Duration::from_secs(2)).unwrap();
        assert_eq!(eval["result"], json!("42"));

        let err = client.request("fail_cmd", json!({}), Duration::from_secs(2)).unwrap_err();
        assert!(err.contains("fallo simulado"));

        std::thread::sleep(Duration::from_millis(50));
        let seen = events.lock().unwrap();
        assert!(seen.iter().any(|e| e == "initialized"));
    }
}
