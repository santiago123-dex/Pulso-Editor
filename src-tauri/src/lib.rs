use crate::i18n::{tr, trf};
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

mod term;
mod userconf;
mod lsp;
mod gitops;
mod githubauth;
mod githubpolicy;
mod githubdevice;
pub mod aichat;
mod cli;
pub mod termchat;
pub mod termui;
pub mod fsguard;
pub mod procguard;
pub mod i18n;
pub mod localai;
pub mod catalog;
pub mod llm;
pub mod agent;
pub mod agenttools;
pub mod agentperms;
pub mod agentconfig;
pub mod agentmem;
mod updates;
mod diag;
mod project_check;
mod test_runner;
mod git_hunks;
mod inline_ai;
mod dap;
mod dap_config;
mod extensions;

/// Los procesos auxiliares no deben abrir ventanas de consola en Windows.
fn background_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

const SKIP_DIRS: [&str; 7] = [".git", "node_modules", "target", "dist", "build", ".next", ".venv"];

/// Normaliza a barras `/` para que el frontend use un solo formato de ruta.
/// Ruta para la interfaz, con `/`. Quita el prefijo «verbatim» de Windows (`\\?\C:\…`, `\\?\UNC\…`)
/// que deja `canonicalize` en las rutas que valida `fsguard`: si no, el explorador, Ctrl+P y la búsqueda
/// devolverían `//?/C:/…` y el mismo archivo se abriría en dos pestañas distintas.
fn norm(p: &Path) -> String {
    let raw = p.to_string_lossy();
    let plain = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = raw.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        raw.into_owned()
    };
    plain.replace('\\', "/")
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

const MAX_OPEN_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_THEME_FILE_BYTES: u64 = 2 * 1024 * 1024;

fn approved_store(app: &tauri::AppHandle) -> Result<fsguard::ApprovedStore, String> {
    Ok(fsguard::ApprovedStore(app.path().app_data_dir().map_err(|e| e.to_string())?.join("approved-folders.json")))
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Aprueba una carpeta que la persona acaba de elegir (diálogo del sistema o línea de comandos): la recuerda en
/// esta sesión y en las siguientes. Rechaza las demasiado amplias (raíz de una unidad, carpeta personal…).
fn approve_folder(app: &tauri::AppHandle, guard: &fsguard::WorkspaceGuard, raw: &str) -> Result<PathBuf, String> {
    let canon = guard.approve_dir(raw)?;
    if let Some(why) = termui::broad_dir_reason(&canon, user_home_dir().as_deref()) {
        return Err(trf("No se puede usar como carpeta de trabajo: {why}.", &[("why", &why)]));
    }
    if let Ok(store) = approved_store(app) {
        let _ = store.add(&canon);
    }
    Ok(canon)
}

/// Fija la carpeta de trabajo de la ventana. La ventana no decide qué carpetas son válidas: solo se acepta una
/// que la persona aprobó con el diálogo del sistema o la línea de comandos. Una carpeta reciente de una sesión
/// anterior se reabre sin preguntar; cualquier otra pide una confirmación nativa que la ventana no puede saltarse.
#[tauri::command]
async fn set_workspace_root(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(raw) = path.as_deref() {
        if !guard.is_dir_approved(raw) {
            let canon = std::fs::canonicalize(raw).map_err(|e| trf("No se pudo abrir la carpeta: {e}", &[("e", &e)]))?;
            if let Some(why) = termui::broad_dir_reason(&canon, user_home_dir().as_deref()) {
                return Err(trf("No se puede usar como carpeta de trabajo: {why}.", &[("why", &why)]));
            }
            let known = approved_store(&app).map(|s| s.contains(&canon)).unwrap_or(false);
            if !known {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                let msg = trf("Pulso quiere abrir esta carpeta, que no abriste antes con «Abrir carpeta»:\n\n{dir}\n\n¿La abres?", &[("dir", &norm(&canon))]);
                let (yes, no) = (tr("Abrir").to_string(), tr("Cancelar").to_string());
                let handle = app.clone();
                let ok = tauri::async_runtime::spawn_blocking(move || {
                    handle.dialog().message(msg).title("Pulso Editor").kind(MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::OkCancelCustom(yes, no)).blocking_show()
                })
                .await
                .map_err(|e| e.to_string())?;
                if !ok {
                    return Err(tr("Esta carpeta no está autorizada: ábrela con el diálogo «Abrir carpeta».").into());
                }
            }
            approve_folder(&app, &guard, &canon.to_string_lossy())?;
        }
    }
    let resolved = guard.set_root_approved(window.label(), path.as_deref())?;
    Ok(resolved.map(|p| norm(&p)))
}

/// Abre el diálogo del sistema para elegir una carpeta de trabajo. Se hace aquí y no en la ventana: la carpeta
/// elegida queda aprobada, y ninguna otra puede fijarse sin una confirmación.
#[tauri::command]
async fn pick_workspace_folder(app: tauri::AppHandle, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || handle.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(dir) = picked else { return Ok(None) };
    let path = dir.into_path().map_err(|e| e.to_string())?;
    let canon = approve_folder(&app, &guard, &path.to_string_lossy())?;
    Ok(Some(norm(&canon)))
}

fn encode_query_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

static WIN_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Abre una nueva ventana de Pulso Editor, opcionalmente apuntando directamente a una carpeta.
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let n = WIN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("win-{n}");
    let url = match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => format!("index.html?folder={}", encode_query_value(p)),
        None => "index.html".to_string(),
    };
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(PathBuf::from(url)))
        .title("Pulso Editor")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .decorations(false)
        .shadow(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_dir(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<Vec<Entry>, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || list_dir_sync(safe.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

fn list_dir_sync(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == "node_modules" || name == "target" {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(Entry { name, path: norm(&e.path()), is_dir })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Recorre todos los archivos bajo `root`; `f` devuelve false para detener.
fn walk(root: &str, mut f: impl FnMut(PathBuf) -> bool) {
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref()) {
                    stack.push(e.path());
                }
            } else if !f(e.path()) {
                return;
            }
        }
    }
}

/// Lista recursivamente todos los archivos de `path` (para abrir archivo rápido).
#[tauri::command]
async fn list_files(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<Vec<String>, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || list_files_sync(safe.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

fn list_files_sync(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut builder = ignore::WalkBuilder::new(&path);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return !SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref());
            }
            true
        });
    for entry in builder.build().flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push(norm(entry.path()));
            if out.len() >= 20_000 {
                break;
            }
        }
    }
    Ok(out)
}

fn read_file_sync(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_OPEN_FILE_BYTES {
        return Err(trf(
            "El archivo es demasiado grande ({size} MB; límite {limit} MB)",
            &[
                ("size", &format!("{:.1}", meta.len() as f64 / (1024.0 * 1024.0))),
                ("limit", &(MAX_OPEN_FILE_BYTES / (1024 * 1024))),
            ],
        ));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ImagePreview {
    data_url: String,
    bytes: u64,
    mime: String,
}

fn image_mime_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

#[tauri::command]
async fn read_image_file(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: String,
) -> Result<ImagePreview, String> {
    use base64::Engine;
    let safe = guard.ensure_read(&path)?;
    let mime = image_mime_for(&safe).ok_or_else(|| tr("Formato de imagen no soportado").to_string())?;
    let meta = fs::metadata(&safe).map_err(|e| e.to_string())?;
    if meta.len() > 15 * 1024 * 1024 {
        return Err(tr("La imagen es demasiado grande (máximo 15 MB)").into());
    }
    let bytes = meta.len();
    let data = tauri::async_runtime::spawn_blocking(move || fs::read(&safe).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ImagePreview {
        data_url: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&data)),
        bytes,
        mime: mime.to_string(),
    })
}

#[tauri::command]
async fn read_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<String, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_file_sync(&safe))
        .await
        .map_err(|e| e.to_string())?
}

/// Lectura acotada para importar archivos de tema `.json`/`.jsonc` elegidos con el diálogo del sistema.
/// Abre el diálogo del sistema para elegir un tema de VS Code. La elección se hace aquí, no en la ventana, para que
/// la ventana no pueda pedir que se lea una ruta inventada: solo se puede leer lo que la persona eligió.
#[tauri::command]
async fn pick_theme_file(app: tauri::AppHandle, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let name = tr("Tema de VS Code");
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter(name, &["json", "jsonc"]).blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        guard.allow_theme_dir(dir);
    }
    Ok(Some(norm(&path)))
}

#[tauri::command]
async fn read_theme_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<String, String> {
    let safe = guard.ensure_theme_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = safe.as_path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext != "json" && ext != "jsonc" {
            return Err(tr("Solo se pueden importar archivos de tema .json o .jsonc").into());
        }
        let meta = fs::metadata(p).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > MAX_THEME_FILE_BYTES {
            return Err(tr("El archivo de tema es demasiado grande o no es válido").into());
        }
        fs::read_to_string(p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn mtime_ms(p: &Path) -> Option<u64> {
    let t = fs::metadata(p).ok()?.modified().ok()?;
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// Escribe en un archivo temporal del mismo directorio y lo renombra sobre el original,
/// así un fallo a mitad de camino nunca deja el archivo a medias.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    // Mantener el enlace y reemplazar su destino, sin recurrir a escritura truncada.
    let resolved;
    let path = if fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        resolved = fs::canonicalize(path)?;
        resolved.as_path()
    } else { path };
    let meta = fs::metadata(path).ok();
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{}.pulso-{}-{}.tmp", name, std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
    let mut created = false;
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        created = true;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if let Some(m) = &meta {
            let _ = fs::set_permissions(&tmp, m.permissions());
        }
        fs::rename(&tmp, path)
    })();
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            if created { let _ = fs::remove_file(&tmp); }
            // Si no se puede reemplazar, preservar el original y comunicar el error.
            Err(e)
        }
    }
}

fn write_checked(path: &Path, bytes: &[u8], expected_mtime: Option<u64>) -> Result<u64, String> {
    if let (Some(expected), Some(current)) = (expected_mtime, mtime_ms(path)) {
        if expected != current {
            return Err("CONFLICT".into());
        }
    }
    write_atomic(path, bytes).map_err(|e| e.to_string())?;
    Ok(mtime_ms(path).unwrap_or(0))
}

/// Guarda el archivo. Si `expected_mtime` no coincide con el del disco devuelve "CONFLICT".
#[tauri::command]
async fn write_file(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: String,
    contents: String,
    expected_mtime: Option<u64>,
) -> Result<u64, String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_file_sync(safe.to_string_lossy().into_owned(), contents, expected_mtime)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn write_file_sync(path: String, contents: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    write_checked(Path::new(&path), contents.as_bytes(), expected_mtime)
}

/// Fecha de modificación en milisegundos desde la época Unix.
#[tauri::command]
async fn file_mtime(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<u64, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || file_mtime_sync(safe.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

fn file_mtime_sync(path: String) -> Result<u64, String> {
    let m = fs::metadata(&path).map_err(|e| e.to_string())?;
    let t = m.modified().map_err(|e| e.to_string())?;
    Ok(t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
}

// ---------- Copias de recuperación (cambios sin guardar) ----------
#[derive(Serialize, Deserialize)]
struct Backup {
    path: String,
    contents: String,
    base_mtime: u64,
    saved_at: u64,
}

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

fn backup_file(dir: &Path, path: &str) -> PathBuf {
    dir.join(format!("{}.json", fnv(path)))
}

fn backup_write_in(dir: &Path, path: &str, contents: &str, base_mtime: u64) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let saved_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let b = Backup { path: path.to_string(), contents: contents.to_string(), base_mtime, saved_at };
    let json = serde_json::to_vec(&b).map_err(|e| e.to_string())?;
    write_atomic(&backup_file(dir, path), &json).map_err(|e| e.to_string())
}

fn backup_remove_in(dir: &Path, path: &str) -> Result<(), String> {
    match fs::remove_file(backup_file(dir, path)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn backup_list_in(dir: &Path) -> Vec<Backup> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Backup> = rd
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice(&b).ok())
        .collect();
    out.sort_by_key(|b| b.saved_at);
    out
}

fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery"))
}

const AI_HISTORY_MAX: usize = 20_000_000;

fn ai_history_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-chats.json"))
}

fn ai_history_read_in(file: &Path) -> String {
    fs::read_to_string(file).unwrap_or_default()
}

fn ai_history_write_in(file: &Path, text: &str) -> Result<(), String> {
    if text.len() > AI_HISTORY_MAX { return Err(tr("El historial del asistente es demasiado grande.").into()); }
    if serde_json::from_str::<serde_json::Value>(text).map(|v| !v.is_array()).unwrap_or(true) {
        return Err(tr("El historial del asistente no tiene un formato válido.").into());
    }
    if let Some(dir) = file.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    write_atomic(file, text.as_bytes()).map_err(|e| e.to_string())
}

/// Conversaciones del asistente de IA: viven en un archivo de los datos de la aplicación, no en localStorage (que comparte cuota con los ajustes).
#[tauri::command]
async fn ai_history_read(app: tauri::AppHandle) -> Result<String, String> {
    let file = ai_history_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || ai_history_read_in(&file)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ai_history_write(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let file = ai_history_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || ai_history_write_in(&file, &text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_write(app: tauri::AppHandle, path: String, contents: String, base_mtime: u64) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup_write_in(&dir, &path, &contents, base_mtime)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup_remove_in(&dir, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_list(app: tauri::AppHandle) -> Result<Vec<Backup>, String> {
    let dir = recovery_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup_list_in(&dir)).await.map_err(|e| e.to_string())
}

// ---------- Almacén seguro de credenciales del sistema ----------
const SECRET_SERVICE: &str = "pulso-editor";

fn ensure_allowed_secret_key(name: &str) -> Result<(), String> {
    if name == "github-token" {
        Ok(())
    } else {
        Err(tr("Clave de credencial no permitida").into())
    }
}

#[tauri::command]
async fn secret_get(name: String) -> Result<Option<String>, String> {
    ensure_allowed_secret_key(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SECRET_SERVICE, &name).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secret_set(name: String, value: String) -> Result<(), String> {
    ensure_allowed_secret_key(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(SECRET_SERVICE, &name)
            .and_then(|e| e.set_password(&value))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secret_delete(name: String) -> Result<(), String> {
    ensure_allowed_secret_key(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        match keyring::Entry::new(SECRET_SERVICE, &name).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn create_file_sync(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(tr("Ya existe un archivo o carpeta con ese nombre").into())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn create_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || create_file_sync(&safe))
        .await
        .map_err(|e| e.to_string())?
}

fn create_dir_sync(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(tr("Ya existe un archivo o carpeta con ese nombre").into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_dir(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || create_dir_sync(&safe))
        .await
        .map_err(|e| e.to_string())?
}

fn rename_path_sync(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(tr("Ya existe un archivo o carpeta con ese nombre").into());
    }
    let from_res = fsguard::resolve_safe(from).unwrap_or_else(|_| from.to_path_buf());
    let to_res = fsguard::resolve_safe(to).unwrap_or_else(|_| to.to_path_buf());
    if to_res.starts_with(&from_res) && to_res != from_res {
        return Err(tr("No se puede mover una carpeta dentro de sí misma").into());
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_path(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    from: String,
    to: String,
) -> Result<(), String> {
    let safe_from = guard.ensure_write(&from)?;
    let safe_to = guard.ensure_write(&to)?;
    tauri::async_runtime::spawn_blocking(move || rename_path_sync(&safe_from, &safe_to))
        .await
        .map_err(|e| e.to_string())?
}

/// Mueve el archivo o carpeta a la papelera de reciclaje.
#[tauri::command]
async fn delete_path(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || trash::delete(&safe).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn reveal_in_explorer(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(windows, target_os = "macos"))]
        let p_str = safe.to_string_lossy().into_owned();
        #[cfg(windows)]
        let mut cmd = {
            let p = p_str.replace('/', "\\");
            let mut c = Command::new("explorer");
            c.arg(format!("/select,{}", p));
            c
        };
        #[cfg(target_os = "macos")]
        let mut cmd = {
            let mut c = Command::new("open");
            c.args(["-R", &p_str]);
            c
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut cmd = {
            let dir = if safe.is_dir() {
                safe.clone()
            } else {
                safe.parent().map(|d| d.to_path_buf()).unwrap_or(safe)
            };
            let mut c = Command::new("xdg-open");
            c.arg(dir);
            c
        };
        let child = cmd.spawn().map_err(|e| trf("No se pudo abrir el explorador de archivos: {e}", &[("e", &e)]))?;
        procguard::reap_detached(child);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn build_regex(query: &str, case_sensitive: bool, use_regex: bool, whole_word: bool) -> Result<Regex, String> {
    if query.is_empty() {
        return Err(tr("La búsqueda está vacía").into());
    }
    let mut pat = if use_regex { query.to_string() } else { regex::escape(query) };
    if whole_word {
        pat = format!(r"\b(?:{})\b", pat);
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| trf("Expresión regular no válida: {e}", &[("e", &e)]))
}

#[derive(Serialize)]
struct Match {
    path: String,
    line: u32,
    col: u32,
    len: u32,
    text: String,
}

fn prepare_include(include: &[String]) -> Option<Vec<String>> {
    if include.is_empty() {
        return None;
    }
    Some(
        include
            .iter()
            .map(|p| p.trim().to_lowercase().replace('\\', "/"))
            .filter(|p| !p.is_empty())
            .collect(),
    )
}

fn included_prepared(path: &str, patterns: &Option<Vec<String>>) -> bool {
    let Some(patterns) = patterns else {
        return true;
    };
    let lower = path.to_lowercase();
    patterns.iter().any(|pat| match pat.strip_prefix('*') {
        Some(rest) => lower.ends_with(rest),
        None => lower.contains(pat),
    })
}

#[cfg(test)]
fn included(path: &str, include: &[String]) -> bool {
    included_prepared(path, &prepare_include(include))
}

/// Lee un archivo de texto; devuelve None si es binario, muy grande o no UTF-8.
fn read_text(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > 2_000_000 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[tauri::command]
async fn search_files(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    root: String, query: String, case_sensitive: bool, use_regex: bool, whole_word: bool, include: Vec<String>,
    unsaved: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<Match>, String> {
    let safe_root = guard.ensure_read(&root)?;
    let unsaved = unsaved.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        search_files_sync(safe_root.to_string_lossy().into_owned(), query, case_sensitive, use_regex, whole_word, include, &unsaved)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_files_sync(
    root: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    include: Vec<String>,
    unsaved: &std::collections::HashMap<String, String>,
) -> Result<Vec<Match>, String> {
    use std::sync::{atomic::AtomicUsize, Mutex};
    const MAX: usize = 5000;
    let re = build_regex(&query, case_sensitive, use_regex, whole_word)?;
    let patterns = prepare_include(&include);
    let out = Mutex::new(Vec::<Match>::new());
    let total = AtomicUsize::new(0);

    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy();
                if SKIP_DIRS.contains(&name.as_ref()) {
                    return false;
                }
            }
            true
        });

    builder.build_parallel().run(|| {
        Box::new(|entry_res| {
            if total.load(Ordering::Relaxed) >= MAX {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry_res else { return ignore::WalkState::Continue };
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let p = entry.path();
            let path = norm(p);
            if !included_prepared(&path, &patterns) {
                return ignore::WalkState::Continue;
            }
            // Un documento abierto con cambios sin guardar se busca con su contenido en pantalla, no con el del disco.
            let owned;
            let text: &str = match unsaved.get(&path) {
                Some(t) => t.as_str(),
                None => match read_text(p) {
                    Some(t) => { owned = t; owned.as_str() }
                    None => return ignore::WalkState::Continue,
                },
            };
            let mut local: Vec<Match> = Vec::new();
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    if m.start() == m.end() {
                        continue;
                    }
                    local.push(Match {
                        path: path.clone(),
                        line: (i + 1) as u32,
                        col: line[..m.start()].encode_utf16().count() as u32 + 1,
                        len: line[m.start()..m.end()].encode_utf16().count() as u32,
                        text: line.chars().take(300).collect(),
                    });
                    if local.len() >= MAX {
                        break;
                    }
                }
                if local.len() >= MAX {
                    break;
                }
            }
            if !local.is_empty() {
                if let Ok(mut guard) = out.lock() {
                    let rem = MAX.saturating_sub(guard.len());
                    if rem == 0 {
                        total.store(MAX, Ordering::Relaxed);
                        return ignore::WalkState::Quit;
                    }
                    let take = local.len().min(rem);
                    guard.extend(local.into_iter().take(take));
                    total.store(guard.len(), Ordering::Relaxed);
                    if guard.len() >= MAX {
                        return ignore::WalkState::Quit;
                    }
                }
            }
            ignore::WalkState::Continue
        })
    });

    let mut results = out.into_inner().unwrap_or_default();
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)).then(a.col.cmp(&b.col)));
    Ok(results)
}

/// Reemplaza las coincidencias de un archivo con las mismas reglas que la búsqueda (línea a línea,
/// conservando los finales de línea) y lo guarda con escritura atómica y detección de cambios.
/// Si `expected` no coincide con lo que hay ahora en disco, no escribe nada.
#[tauri::command]
async fn replace_in_file(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: String, query: String, replacement: String, case_sensitive: bool, use_regex: bool, whole_word: bool,
    expected: Option<u32>,
) -> Result<u32, String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        replace_in_file_sync(safe.to_string_lossy().into_owned(), query, replacement, case_sensitive, use_regex, whole_word, expected)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn replace_in_file_sync(
    path: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    expected: Option<u32>,
) -> Result<u32, String> {
    let re = build_regex(&query, case_sensitive, use_regex, whole_word)?;
    let p = Path::new(&path);
    let mtime = mtime_ms(p);
    let text = read_text(p).ok_or_else(|| tr("El archivo es binario, demasiado grande o no es UTF-8; no se modifica").to_string())?;
    let mut out = String::with_capacity(text.len());
    let mut count = 0u32;
    for seg in text.split_inclusive('\n') {
        let body = seg.strip_suffix('\n').unwrap_or(seg);
        let body = body.strip_suffix('\r').unwrap_or(body);
        let ending = &seg[body.len()..];
        let n = re.find_iter(body).filter(|m| m.start() != m.end()).count() as u32;
        if n == 0 {
            out.push_str(seg);
            continue;
        }
        count += n;
        if use_regex {
            out.push_str(&re.replace_all(body, replacement.as_str()));
        } else {
            out.push_str(&re.replace_all(body, NoExpand(replacement.as_str())));
        }
        out.push_str(ending);
    }
    if count == 0 {
        return Ok(0);
    }
    if let Some(e) = expected {
        if e != count {
            return Err(trf("El archivo cambió desde la búsqueda ({expected} coincidencias previstas, {now} ahora)", &[("expected", &e), ("now", &count)]));
        }
    }
    write_checked(p, out.as_bytes(), mtime)?;
    Ok(count)
}

#[derive(Serialize)]
struct ThemeRef {
    label: String,
    dir: String,
    rel: String,
    ui: String,
    ext: String,
}

/// Busca los temas de color de las extensiones instaladas en VS Code.
#[tauri::command]
async fn scan_vscode_themes() -> Vec<ThemeRef> {
    tauri::async_runtime::spawn_blocking(scan_vscode_themes_sync)
        .await
        .unwrap_or_default()
}

fn scan_vscode_themes_sync() -> Vec<ThemeRef> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(Path::new(&home).join(".vscode").join("extensions")) else { return out };
    for e in rd.flatten() {
        let Ok(text) = fs::read_to_string(e.path().join("package.json")) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(themes) = v["contributes"]["themes"].as_array() else { continue };
        let ext = v["displayName"].as_str().or(v["name"].as_str()).unwrap_or("").to_string();
        for t in themes {
            let Some(rel) = t["path"].as_str() else { continue };
            let Some(label) = t["label"].as_str().or(t["id"].as_str()) else { continue };
            out.push(ThemeRef {
                label: label.to_string(),
                dir: norm(&e.path()),
                rel: rel.to_string(),
                ui: t["uiTheme"].as_str().unwrap_or("vs-dark").to_string(),
                ext: ext.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out
}

#[derive(Serialize)]
struct GitFile {
    path: String,
    /// U sin seguimiento, A añadido, M modificado, D eliminado, R renombrado, ! conflicto, I ignorado.
    status: String,
    dir: bool,
}

#[derive(Serialize)]
struct GitInfo {
    branch: String,
    ahead: u32,
    behind: u32,
    dirty: bool,
    files: Vec<GitFile>,
}

fn git_out(path: &str, args: &[&str]) -> Option<String> {
    // Solo lectura: sin candados opcionales y en locale C para parseo determinista.
    let out = background_command("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Interpreta la salida de `git status --porcelain=v1 -z -b --ignored`.
fn parse_git_status(text: &str, top: &str) -> GitInfo {
    let mut info = GitInfo { branch: String::new(), ahead: 0, behind: 0, dirty: false, files: Vec::new() };
    let mut records = text.split('\0');
    while let Some(rec) = records.next() {
        if let Some(head) = rec.strip_prefix("## ") {
            let name = head.split(" [").next().unwrap_or(head);
            info.branch = match name.strip_prefix("No commits yet on ") {
                Some(b) => b.to_string(),
                None => name.split("...").next().unwrap_or(name).to_string(),
            };
            if let Some(i) = head.find('[') {
                for part in head[i + 1..].trim_end_matches(']').split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") { info.ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = part.strip_prefix("behind ") { info.behind = n.parse().unwrap_or(0); }
                }
            }
            continue;
        }
        let bytes = rec.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' { continue; }
        let file = &rec[3..];
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' { records.next(); }
        let status = match (x, y) {
            ('?', '?') => "U",
            ('!', '!') => "I",
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "!",
            (_, 'M') | (_, 'T') | ('M', _) | ('T', _) => "M",
            (_, 'D') | ('D', _) => "D",
            (_, 'R') | ('R', _) | (_, 'C') | ('C', _) => "R",
            ('A', _) | (_, 'A') => "A",
            _ => "M",
        };
        if status != "I" { info.dirty = true; }
        info.files.push(GitFile {
            path: format!("{}/{}", top, file.trim_end_matches('/')),
            status: status.to_string(),
            dir: file.ends_with('/'),
        });
    }
    info
}

/// Estado de Git de la carpeta: rama, adelantos y archivos cambiados. None si no es un repositorio.
#[tauri::command]
async fn git_status(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<Option<GitInfo>, String> {
    // Solo carpetas abiertas como espacio de trabajo; para el resto, lo mismo que una carpeta que no es repositorio.
    if guard.ensure_dir(&path).is_err() {
        return Ok(None);
    }
    Ok(tauri::async_runtime::spawn_blocking(move || git_status_sync(path)).await.ok().flatten())
}

fn git_status_sync(path: String) -> Option<GitInfo> {
    let top = git_out(&path, &["rev-parse", "--show-toplevel"])?.trim().replace('\\', "/");
    let text = git_out(&path, &["status", "--porcelain=v1", "-z", "-b", "--ignored"])?;
    Some(parse_git_status(&text, &top))
}

/// Devuelve la URL del remoto `origin` del repo en `path`.
#[tauri::command]
async fn git_remote(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<String, String> {
    // La dirección del remoto puede llevar un token incrustado: solo se entrega la de una carpeta abierta.
    guard.ensure_dir(&path)?;
    tauri::async_runtime::spawn_blocking(move || git_remote_sync(path)).await.map_err(|e| e.to_string())?
}

fn git_remote_sync(path: String) -> Result<String, String> {
    let out = background_command("git")
        .env("LC_ALL", "C")
        .args(["-C", &path, "remote", "get-url", "origin"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn authorize_cli_targets(app: &tauri::AppHandle, guard: &fsguard::WorkspaceGuard, targets: &[cli::CliTarget]) {
    for t in targets {
        if t.kind == "file" {
            guard.allow_file(Path::new(&t.path));
        } else if t.kind == "dir" {
            // Una carpeta que la persona escribió en la terminal (`pulso carpeta`) cuenta como elegida por ella.
            let _ = approve_folder(app, guard, &t.path);
        }
    }
}

/// Argumentos con los que se lanzó este proceso (`pulso archivo`, `pulso -g archivo:línea`).
#[tauri::command]
fn cli_startup_targets(app: tauri::AppHandle, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Vec<cli::CliTarget> {
    let targets = cli::startup_targets();
    authorize_cli_targets(&app, &guard, &targets);
    targets
}

/// Añade la carpeta del programa (donde está `pulso.exe`) al PATH del usuario, para escribir `pulso .` en cualquier terminal.
#[tauri::command]
async fn install_cli_command() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_cli_command_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn install_cli_command_sync() -> Result<String, String> {
    #[cfg(not(windows))]
    { return Ok(tr("En Linux y macOS el paquete ya instala el comando `pulso` en el PATH; no hace falta hacer nada más.").into()); }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or(tr("No se encontró la carpeta del programa"))?.to_path_buf();
        if !dir.join("pulso.exe").exists() { return Err(tr("No se encontró pulso.exe junto a Pulso Editor (¿es una compilación de desarrollo?).").into()); }
        let _ = std::fs::remove_file(dir.join("pulso.cmd"));
        let script = "$d = $args[0]; $p = [Environment]::GetEnvironmentVariable('Path','User'); $parts = @(); if ($p) { $parts = $p -split ';' | Where-Object { $_ }; }; if ($parts -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User'); 'added' } else { 'present' }";
        let out = background_command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script, &dir.to_string_lossy()])
            .output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(trf("Listo: `pulso` quedó disponible en {dir}. Abre una terminal nueva para usarlo.", &[("dir", &dir.display())]))
    }
}

/// Sufijo del identificador en las compilaciones de desarrollo (sin optimizar: `target/debug/pulso-editor.exe`,
/// `tauri dev`). Con su propio identificador guardan configuración, sesión, copias de recuperación y datos del
/// WebView en otra carpeta, y pueden abrirse a la vez que la versión instalada sin tocar sus datos.
/// Las credenciales del sistema (el token de GitHub) se siguen compartiendo.
pub const DEV_IDENTIFIER_SUFFIX: &str = ".dev";

fn app_context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    if cfg!(debug_assertions) {
        let config = context.config_mut();
        config.identifier = format!("{}{}", config.identifier, DEV_IDENTIFIER_SUFFIX);
    }
    context
}

pub fn run() {
    tauri::Builder::default()
        // Una sola ventana: si se vuelve a lanzar `pulso archivo`, los argumentos llegan a la que ya está abierta.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let targets = cli::parse_args(&args[1.min(args.len())..], std::path::Path::new(&cwd));
            authorize_cli_targets(app, &app.state::<fsguard::WorkspaceGuard>(), &targets);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                // Windows no deja que un proceso en segundo plano robe el foco; subirla un instante por encima del resto sí la trae al frente.
                let _ = w.set_always_on_top(true);
                let _ = w.set_focus();
                let _ = w.set_always_on_top(false);
            }
            let _ = app.emit("cli-open", targets);
        }))
        .manage(fsguard::WorkspaceGuard::default())
        .manage(githubauth::GithubState::default())
        .manage(term::TermState::default())
        .manage(lsp::LspState::default())
        .manage(aichat::AiState::default())
        .manage(catalog::CatalogState::default())
        .manage(std::sync::Arc::new(agentperms::Broker::default()))
        .manage(dap::DapState::default())
        .manage(extensions::ExtensionState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<fsguard::WorkspaceGuard>().remove_window(window.label());
                window.state::<lsp::LspState>().stop_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_workspace_root,
            pick_workspace_folder,
            aichat::project_trust_request,
            open_new_window,
            list_dir,
            cli_startup_targets,
            install_cli_command,
            list_files,
            read_file,
            read_image_file,
            read_theme_file,
            catalog::catalog_get,
            aichat::agent_config,
            agentperms::ai_permission_respond,
            agentperms::agent_rules_list,
            agentperms::agent_rules_remove,
            agentperms::agent_rules_add_deny,
            agentmem::agent_memory_list,
            agentmem::agent_memory_remove,
            catalog::provider_key_set,
            catalog::provider_key_delete,
            pick_theme_file,
            write_file,
            file_mtime,
            backup_write,
            ai_history_read,
            ai_history_write,
            backup_remove,
            backup_list,
            secret_get,
            secret_set,
            secret_delete,
            term::term_shells,
            userconf::terminal_config_files,
            userconf::installed_fonts,
            term::term_spawn,
            term::term_write,
            term::term_resize,
            term::term_kill,
            term::term_kill_all,
            lsp::lsp_host_pid,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            reveal_in_explorer,
            search_files,
            replace_in_file,
            scan_vscode_themes,
            git_status,
            git_remote,
            gitops::git_changes,
            gitops::git_stage,
            gitops::git_unstage,
            gitops::git_commit,
            gitops::git_last_commit_message,
            gitops::git_commit_amend,
            gitops::git_delete_branch,
            gitops::git_rename_branch,
            gitops::git_diff_sources,
            gitops::git_branches,
            gitops::git_switch,
            gitops::git_discard,
            gitops::git_push,
            gitops::git_pull,
            gitops::git_log,
            gitops::git_commit_files,
            gitops::git_commit_sources,
            gitops::git_blame,
            githubauth::github_init,
            githubauth::github_has_token,
            githubauth::github_set_token,
            githubauth::github_connect,
            githubauth::github_disconnect,
            githubauth::github_api,
            githubauth::open_external,
            githubdevice::github_device_available,
            githubdevice::github_device_start,
            githubdevice::github_device_poll,
            githubdevice::github_device_cancel,
            aichat::ai_detect,
            aichat::ai_detect_provider,
            aichat::ai_detect_all,
            aichat::ai_usage,
            aichat::ai_extra_usage,
            aichat::ai_send,
            aichat::ai_stop,
            aichat::ai_save_image,
            aichat::ai_read_image_data_url,
            aichat::ai_prune_images,
            updates::update_check,
            updates::update_install,
            diag::diag_log,
            diag::diag_collect,
            i18n::i18n_set_lang,
            project_check::project_check,
            test_runner::test_detect,
            test_runner::test_run,
            git_hunks::git_file_hunks,
            git_hunks::git_apply_hunk,
            inline_ai::ai_inline_complete,
            dap::dap_list_configs,
            dap::dap_trust_workspace,
            dap::dap_create_launch_file,
            dap::dap_launch,
            dap::dap_stop,
            dap::dap_set_breakpoints,
            dap::dap_continue,
            dap::dap_next,
            dap::dap_step_in,
            dap::dap_step_out,
            dap::dap_pause,
            dap::dap_stack_trace,
            dap::dap_scopes,
            dap::dap_variables,
            dap::dap_evaluate,
            extensions::ext_list,
            extensions::ext_set_enabled,
            extensions::ext_uninstall,
            extensions::ext_pick_for_install,
            extensions::ext_confirm_install
        ])
        .build(app_context())
        .expect("error al iniciar Pulso Editor")
        .run(|app, event| {
            // Al salir se cierran las terminales, LSP y procesos de IA para no dejar procesos huérfanos.
            if let tauri::RunEvent::Exit = event {
                app.state::<term::TermState>().kill_all();
                app.state::<lsp::LspState>().stop();
                app.state::<aichat::AiState>().stop_all();
                app.state::<dap::DapState>().stop();
            }
        });
}

#[cfg(test)]
mod tests;
