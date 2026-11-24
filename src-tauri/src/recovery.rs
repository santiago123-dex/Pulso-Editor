//! Copias de recuperación de cambios sin guardar y el historial del chat de IA.
use super::*;

// ---------- Copias de recuperación (cambios sin guardar) ----------
#[derive(Serialize, Deserialize)]
pub(crate) struct Backup {
    pub(crate) path: String,
    pub(crate) contents: String,
    pub(crate) base_mtime: u64,
    pub(crate) saved_at: u64,
}

pub(crate) fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

pub(crate) fn backup_file(dir: &Path, path: &str) -> PathBuf {
    dir.join(format!("{}.json", fnv(path)))
}

pub(crate) fn backup_write_in(dir: &Path, path: &str, contents: &str, base_mtime: u64) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let saved_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let b = Backup { path: path.to_string(), contents: contents.to_string(), base_mtime, saved_at };
    let json = serde_json::to_vec(&b).map_err(|e| e.to_string())?;
    write_atomic(&backup_file(dir, path), &json).map_err(|e| e.to_string())
}

pub(crate) fn backup_remove_in(dir: &Path, path: &str) -> Result<(), String> {
    match fs::remove_file(backup_file(dir, path)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn backup_list_in(dir: &Path) -> Vec<Backup> {
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

pub(crate) fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery"))
}

pub(crate) const AI_HISTORY_MAX: usize = 20_000_000;

pub(crate) fn ai_history_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-chats.json"))
}

pub(crate) fn ai_history_read_in(file: &Path) -> String {
    fs::read_to_string(file).unwrap_or_default()
}

pub(crate) fn ai_history_write_in(file: &Path, text: &str) -> Result<(), String> {
    if text.len() > AI_HISTORY_MAX { return Err(tr("El historial del asistente es demasiado grande.").into()); }
    if serde_json::from_str::<serde_json::Value>(text).map(|v| !v.is_array()).unwrap_or(true) {
        return Err(tr("El historial del asistente no tiene un formato válido.").into());
    }
    if let Some(dir) = file.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    write_atomic(file, text.as_bytes()).map_err(|e| e.to_string())
}

/// Conversaciones del asistente de IA: viven en un archivo de los datos de la aplicación, no en localStorage (que comparte cuota con los ajustes).
#[tauri::command]
pub(crate) async fn ai_history_read(app: tauri::AppHandle) -> Result<String, String> {
    let file = ai_history_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || ai_history_read_in(&file)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn ai_history_write(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let file = ai_history_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || ai_history_write_in(&file, &text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn backup_write(app: tauri::AppHandle, path: String, contents: String, base_mtime: u64) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup_write_in(&dir, &path, &contents, base_mtime)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn backup_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup_remove_in(&dir, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn backup_list(app: tauri::AppHandle) -> Result<Vec<Backup>, String> {
    let dir = recovery_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup_list_in(&dir)).await.map_err(|e| e.to_string())
}
