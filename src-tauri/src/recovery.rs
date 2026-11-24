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

/// Cuántos historiales que no se pudieron descifrar se guardan aparte (si vuelve la clave, se pueden recuperar).
const AI_HISTORY_LOCKED_KEEP: usize = 3;
const AI_HISTORY_LOCKED_PREFIX: &str = "ai-chats.locked-";

/// Lectura y escritura del historial no se mezclan: una escritura puede crear la clave, y dos a la vez crearían dos.
static AI_HISTORY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// El historial cifrado, si hay dónde guardar la clave.
fn ai_history_seal(text: &str, keys: &dyn crate::chatcrypt::KeyStore) -> Result<Vec<u8>, String> {
    let key = match keys.get()? {
        Some(k) => k,
        None => {
            let k = crate::chatcrypt::new_key()?;
            keys.set(&k)?;
            k
        }
    };
    crate::chatcrypt::encrypt(&key, text.as_bytes())
}

/// Aparta un historial que no se puede leer (otra clave, archivo alterado) en vez de dejar que se pise: no se pierde nada, y si
/// la clave vuelve se recupera devolviéndole el nombre `ai-chats.json`. Solo se conservan los últimos.
fn ai_history_set_aside(file: &Path) {
    let Some(dir) = file.parent() else { return };
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let _ = fs::rename(file, dir.join(format!("{AI_HISTORY_LOCKED_PREFIX}{stamp:020}.bin")));
    let mut locked: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(AI_HISTORY_LOCKED_PREFIX))).collect();
    locked.sort();
    while locked.len() > AI_HISTORY_LOCKED_KEEP {
        let _ = fs::remove_file(locked.remove(0));
    }
}

/// Lee el historial. Un archivo cifrado se descifra con la clave del almacén; el historial antiguo (en texto) se lee tal cual y se cifra
/// al momento. Si el archivo cifrado no se puede abrir (la clave ya no está o no coincide), se aparta y se empieza uno vacío.
pub(crate) fn ai_history_read_in(file: &Path, keys: &dyn crate::chatcrypt::KeyStore) -> String {
    let _guard = AI_HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(bytes) = fs::read(file) else { return String::new() };
    if crate::chatcrypt::is_encrypted(&bytes) {
        let opened = match keys.get() {
            Ok(Some(key)) => crate::chatcrypt::decrypt(&key, &bytes).ok().and_then(|p| String::from_utf8(p).ok()),
            _ => None,
        };
        return match opened {
            Some(text) => text,
            None => {
                ai_history_set_aside(file);
                String::new()
            }
        };
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if serde_json::from_str::<serde_json::Value>(&text).is_ok_and(|v| v.is_array()) {
        // Sin almacén de claves (Linux sin Secret Service, por ejemplo) se queda en texto, como antes.
        if let Ok(sealed) = ai_history_seal(&text, keys) {
            let _ = write_atomic(file, &sealed);
        }
    }
    text
}

pub(crate) fn ai_history_write_in(file: &Path, text: &str, keys: &dyn crate::chatcrypt::KeyStore) -> Result<(), String> {
    if text.len() > AI_HISTORY_MAX { return Err(tr("El historial del asistente es demasiado grande.").into()); }
    if serde_json::from_str::<serde_json::Value>(text).map(|v| !v.is_array()).unwrap_or(true) {
        return Err(tr("El historial del asistente no tiene un formato válido.").into());
    }
    let _guard = AI_HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = file.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    // Si no hay almacén de claves, mejor guardar en texto que perder las conversaciones.
    let bytes = ai_history_seal(text, keys).unwrap_or_else(|_| text.as_bytes().to_vec());
    write_atomic(file, &bytes).map_err(|e| e.to_string())
}

/// Conversaciones del asistente de IA: viven en un archivo de los datos de la aplicación, no en localStorage (que comparte cuota con los ajustes).
/// El archivo va cifrado (ver `chatcrypt.rs`).
#[tauri::command]
pub(crate) async fn ai_history_read(app: tauri::AppHandle) -> Result<String, String> {
    let file = ai_history_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || ai_history_read_in(&file, &crate::chatcrypt::HISTORY_KEY)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn ai_history_write(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let file = ai_history_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || ai_history_write_in(&file, &text, &crate::chatcrypt::HISTORY_KEY)).await.map_err(|e| e.to_string())?
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
