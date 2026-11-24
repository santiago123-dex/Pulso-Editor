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

#[tauri::command]
pub async fn ai_detect() -> Result<AiTool, String> {
    tauri::async_runtime::spawn_blocking(detect_claude).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_detect_provider(app: AppHandle, provider: String) -> Result<AiTool, String> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "cloud" => Ok(detect_cloud(&app)),
        "claude" => Ok(detect_claude()),
        "codex" => Ok(detect_codex()),
        "antigravity" | "gemini" => Ok(detect_antigravity()),
        _ => Err(tr("Proveedor de IA no soportado").to_string()),
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_detect_all(app: AppHandle) -> Result<AllAiTools, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t_claude = thread::spawn(detect_claude);
        let t_codex = thread::spawn(detect_codex);
        let t_agy = thread::spawn(detect_antigravity);
        let t_local = thread::spawn(crate::localai::detect);
        AllAiTools {
            claude: t_claude.join().unwrap_or_default(),
            codex: t_codex.join().unwrap_or_default(),
            antigravity: t_agy.join().unwrap_or_default(),
            local: t_local.join().unwrap_or_default(),
            cloud: detect_cloud(&app),
        }
    }).await.map_err(|e| e.to_string())
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

/// Guarda una imagen adjunta al chat de IA dentro de los datos de la aplicación y devuelve su ruta en disco.
#[tauri::command]
pub fn ai_save_image(app: AppHandle, name: Option<String>, mime: String, data_base64: String) -> Result<SavedImage, String> {
    use base64::Engine;
    let ext = ext_for_image_mime(&mime)
        .ok_or_else(|| tr("Formato de imagen no soportado. Usa PNG, JPG, WEBP o GIF.").to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|_| tr("No se pudo leer la imagen adjunta.").to_string())?;
    if bytes.is_empty() {
        return Err(tr("La imagen está vacía.").into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(tr("La imagen supera el límite de 10 MB.").into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = IMG_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file_name = format!("img_{ms}_{seq}.{ext}");
    let full = dir.join(&file_name);
    std::fs::write(&full, &bytes).map_err(|e| e.to_string())?;
    let display = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| file_name.clone());
    Ok(SavedImage {
        path: full.to_string_lossy().replace('\\', "/"),
        name: display,
    })
}

/// Lee una imagen guardada en `ai-images/` y devuelve un `data:` URL para mostrarla ampliada en el visor.
#[tauri::command]
pub fn ai_read_image_data_url(app: AppHandle, path: String) -> Result<String, String> {
    use base64::Engine;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-images");
    let dir_canon = std::fs::canonicalize(&dir).map_err(|_| tr("No se encontró la imagen adjunta.").to_string())?;
    let target = std::fs::canonicalize(Path::new(&path)).map_err(|_| tr("No se encontró la imagen adjunta.").to_string())?;
    if !target.starts_with(&dir_canon) || !target.is_file() {
        return Err(tr("No se encontró la imagen adjunta.").into());
    }
    let mime = mime_for_image_ext(&target)
        .ok_or_else(|| tr("Formato de imagen no soportado. Usa PNG, JPG, WEBP o GIF.").to_string())?;
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_IMAGE_BYTES {
        return Err(tr("La imagen supera el límite de 10 MB.").into());
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Elimina archivos antiguos de `ai-images/` que ya no estén referenciados por ninguna conversación guardada.
#[tauri::command]
pub fn ai_prune_images(app: AppHandle, keep_paths: Vec<String>) -> Result<usize, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-images");
    if !dir.is_dir() {
        return Ok(0);
    }
    let keep: std::collections::HashSet<String> = keep_paths
        .into_iter()
        .filter_map(|p| std::fs::canonicalize(Path::new(&p)).ok())
        .map(|p| p.to_string_lossy().to_ascii_lowercase())
        .collect();
    let grace = Duration::from_secs(300);
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(0); };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() { continue; }
        let Ok(canon) = std::fs::canonicalize(&p) else { continue; };
        if keep.contains(&canon.to_string_lossy().to_ascii_lowercase()) { continue; }
        if let Ok(meta) = entry.metadata() {
            if let Ok(mtime) = meta.modified() {
                if now.duration_since(mtime).unwrap_or_default() < grace { continue; }
            }
        }
        if std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn ai_send(
    app: AppHandle,
    state: State<'_, AiState>,
    guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>,
    id: String,
    cwd: String,
    prompt: String,
    session: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    mode: String,
    provider: Option<String>,
    history: Option<Vec<crate::localai::HistoryMsg>>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    if !safe_token(&id) { return Err(tr("Identificador de conversación no válido").into()); }
    // El agente lee (y edita, si se le deja) todo lo que haya bajo `cwd`: tiene que ser una carpeta abierta en Pulso.
    guard.ensure_dir(&cwd).map_err(|_| tr("Abre una carpeta de proyecto para hablar con la IA."))?;
    if let Some(reason) = crate::termui::broad_dir_reason(Path::new(&cwd), user_home().as_deref()) {
        return Err(trf("No se permite lanzar la IA en esa carpeta ({reason}). Abre una carpeta de proyecto concreta.", &[("reason", &reason)]));
    }
    if prompt.trim().is_empty() { return Err(tr("El mensaje está vacío.").into()); }
    let image_paths = validate_images(images)?;

    // Reservar el slot ANTES de spawnear elimina carreras de doble envío y PIDs obsoletos.
    {
        let mut map = state.running.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&id) {
            return Err(tr("Esta conversación ya está respondiendo.").into());
        }
        map.insert(id.clone(), AiSlot::Starting);
    }

    if provider.as_deref() == Some("cloud") {
        return start_cloud(app, &state, id, cwd, prompt, model, history.unwrap_or_default(), image_paths, mode).await;
    }
    if provider.as_deref() == Some("local") {
        return start_local(app, &state, id, cwd, prompt, model, history.unwrap_or_default(), image_paths, mode);
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
                let mut seen_dirs = std::collections::HashSet::new();
                for img in &image_paths {
                    if let Some(parent) = Path::new(img).parent() {
                        let dir = parent.to_string_lossy().into_owned();
                        if !dir.is_empty() && seen_dirs.insert(dir.clone()) {
                            prefix.push("--add-dir".into());
                            prefix.push(dir);
                        }
                    }
                }
                (prog, prefix)
            }
            "codex" => {
                let (prog, mut prefix) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
                let mut codex_args = build_codex_args(&opts)?;
                if opts.session.is_none() && !image_paths.is_empty() {
                    // Insertar `--image <ruta>` justo antes del `-` final de stdin.
                    let insert_at = codex_args.len().saturating_sub(1);
                    let mut extra = Vec::with_capacity(image_paths.len() * 2);
                    for img in &image_paths {
                        extra.push("--image".into());
                        extra.push(img.clone());
                    }
                    codex_args.splice(insert_at..insert_at, extra);
                }
                prefix.extend(codex_args);
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

/// Pregunta con un diálogo nativo si se confía en el proyecto y lo recuerda. La pregunta la hace Rust, no la ventana:
/// una ventana comprometida no puede darse la confianza a sí misma.
#[tauri::command]
pub async fn project_trust_request(app: AppHandle, guard: State<'_, crate::fsguard::WorkspaceGuard>, cwd: String) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let dir = guard.ensure_dir(&cwd)?;
    if project_trusted(&app, &dir) {
        return Ok(true);
    }
    let msg = trf("¿Confías en los autores de esta carpeta?\n\n{dir}\n\nSi confías, el agente de IA leerá sus AGENTS.md, skills, subagentes y comandos y los tratará como instrucciones, ejecutará sus ganchos y servidores MCP, y podrás depurarlo (depurar ejecuta código del proyecto). Si no es tu proyecto o no conoces a quien lo escribió, no confíes.", &[("dir", &dir.display())]);
    let (yes, no) = (tr("Confiar").to_string(), tr("No confiar").to_string());
    let handle = app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || {
        handle.dialog().message(msg).title("Pulso Editor").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom(yes, no)).blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if !ok {
        return Ok(false);
    }
    let file = trust_file(&app).ok_or_else(|| tr("No se pudo guardar la confianza en la carpeta.").to_string())?;
    let canon = std::fs::canonicalize(&dir).unwrap_or(dir);
    let updated = crate::termui::add_trusted(&std::fs::read_to_string(&file).unwrap_or_default(), &canon);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&file, updated).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Lo que el agente propio carga para una carpeta: instrucciones, skills, subagentes y comandos con `/`.
#[tauri::command]
pub async fn agent_config(app: AppHandle, guard: State<'_, crate::fsguard::WorkspaceGuard>, cwd: String) -> Result<Vec<ConfigEntry>, String> {
    let dir = guard.ensure_dir(&cwd)?;
    let trusted = project_trusted(&app, &dir);
    let cfg = tauri::async_runtime::spawn_blocking(move || crate::agentconfig::Config::load(Path::new(&cwd))).await.map_err(|e| e.to_string())?;
    let p = |path: &Path| path.to_string_lossy().replace('\\', "/");
    let mut out = Vec::new();
    for i in &cfg.instructions {
        out.push(ConfigEntry { kind: "instruction".into(), name: i.source.clone(), description: format!("{} bytes", i.text.len()), path: p(&i.path), user: i.user, blocked: !trusted && !i.user });
    }
    for s in &cfg.skills {
        out.push(ConfigEntry { kind: "skill".into(), name: s.name.clone(), description: s.description.clone(), path: p(&s.dir.join("SKILL.md")), user: s.user, blocked: !trusted && !s.user });
    }
    for a in &cfg.agents {
        out.push(ConfigEntry { kind: "agent".into(), name: a.name.clone(), description: a.description.clone(), path: a.path.as_deref().map(p).unwrap_or_default(), user: a.user, blocked: !trusted && !a.user && !a.builtin });
    }
    for c in &cfg.commands {
        out.push(ConfigEntry { kind: "command".into(), name: format!("/{}", c.name), description: c.description.clone(), path: p(&c.path), user: c.user, blocked: !trusted && !c.user && !c.path.as_os_str().is_empty() });
    }
    Ok(out)
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
mod tests;

mod antigravity;
mod args;
mod cli;
mod cloud;
mod codex;
mod detect;
mod images;
mod stream;

pub use antigravity::*;
pub use args::*;
pub use cli::*;
pub use cloud::*;
pub use codex::*;
pub use detect::*;
pub use images::*;
pub use stream::*;
