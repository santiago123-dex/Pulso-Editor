//! Lanzar la herramienta externa y reenviar su salida línea a línea al panel.
use super::*;

pub(super) const MAX_LINE: usize = 1_000_000;
pub(super) const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Lee una línea hasta `\n` acotando memoria en `max` bytes; si se supera, descarta hasta el fin de línea
/// y marca `truncated = true`. Nunca falla ni corta el stream por bytes no UTF-8.
pub(super) fn read_bounded_line(reader: &mut impl BufRead, max: usize) -> std::io::Result<Option<(String, bool)>> {
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
pub(super) struct AiLine { pub(super) id: String, pub(super) line: String }
#[derive(Serialize, Clone)]
pub(super) struct AiExit { pub(super) id: String, pub(super) code: Option<i32>, pub(super) stderr: String }

/// Agente local (Ollama): corre dentro de Pulso y emite los mismos eventos que las herramientas externas.
pub(super) fn start_local(
    app: AppHandle,
    state: &AiState,
    id: String,
    cwd: String,
    prompt: String,
    model: Option<String>,
    history: Vec<crate::localai::HistoryMsg>,
    images: Vec<String>,
    mode: String,
) -> Result<(), String> {
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).ok_or_else(|| tr("Elige un modelo de Ollama para conversar.").to_string())?;
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.running.lock().map_err(|e| e.to_string())?.insert(id.clone(), AiSlot::Local(cancel.clone()));
    let (emitter, id_line) = (app.clone(), id.clone());
    let emit: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line| {
        let _ = emitter.emit("ai-line", AiLine { id: id_line.clone(), line });
    });
    tauri::async_runtime::spawn(async move {
        let outcome = crate::localai::run(crate::localai::base_url(), model, PathBuf::from(&cwd), id.clone(), history, prompt, images, mode, cancel.clone(), emit).await;
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
