//! Archivos y carpetas: listar, leer, escribir de forma atómica, crear, renombrar, borrar e imágenes.
use super::*;

#[derive(Serialize)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
}

pub(crate) const MAX_OPEN_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const MAX_THEME_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn list_dir(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<Vec<Entry>, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || list_dir_sync(safe.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

pub(crate) fn list_dir_sync(path: String) -> Result<Vec<Entry>, String> {
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
pub(crate) fn walk(root: &str, mut f: impl FnMut(PathBuf) -> bool) {
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
pub(crate) async fn list_files(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<Vec<String>, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || list_files_sync(safe.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

pub(crate) fn list_files_sync(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut builder = ignore::WalkBuilder::new(&path);
    builder.hidden(false).git_ignore(true).git_global(false).git_exclude(true).require_git(false).filter_entry(|entry| {
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

pub(crate) fn read_file_sync(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_OPEN_FILE_BYTES {
        return Err(trf(
            "El archivo es demasiado grande ({size} MB; límite {limit} MB)",
            &[("size", &format!("{:.1}", meta.len() as f64 / (1024.0 * 1024.0))), ("limit", &(MAX_OPEN_FILE_BYTES / (1024 * 1024)))],
        ));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub(crate) struct ImagePreview {
    pub(crate) data_url: String,
    pub(crate) bytes: u64,
    pub(crate) mime: String,
}

pub(crate) fn image_mime_for(path: &Path) -> Option<&'static str> {
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
pub(crate) async fn read_image_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<ImagePreview, String> {
    use base64::Engine;
    let safe = guard.ensure_read(&path)?;
    let mime = image_mime_for(&safe).ok_or_else(|| tr("Formato de imagen no soportado").to_string())?;
    let meta = fs::metadata(&safe).map_err(|e| e.to_string())?;
    if meta.len() > 15 * 1024 * 1024 {
        return Err(tr("La imagen es demasiado grande (máximo 15 MB)").into());
    }
    let bytes = meta.len();
    let data = tauri::async_runtime::spawn_blocking(move || fs::read(&safe).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())??;
    Ok(ImagePreview { data_url: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&data)), bytes, mime: mime.to_string() })
}

#[tauri::command]
pub(crate) async fn read_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<String, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_file_sync(&safe)).await.map_err(|e| e.to_string())?
}

/// Lectura acotada para importar archivos de tema `.json`/`.jsonc` elegidos con el diálogo del sistema.
/// Abre el diálogo del sistema para elegir un tema de VS Code. La elección se hace aquí, no en la ventana, para que
/// la ventana no pueda pedir que se lea una ruta inventada: solo se puede leer lo que la persona eligió.
#[tauri::command]
pub(crate) async fn pick_theme_file(app: tauri::AppHandle, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<Option<String>, String> {
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
pub(crate) async fn read_theme_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<String, String> {
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

pub(crate) fn mtime_ms(p: &Path) -> Option<u64> {
    let t = fs::metadata(p).ok()?.modified().ok()?;
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// Escribe en un archivo temporal del mismo directorio y lo renombra sobre el original,
/// así un fallo a mitad de camino nunca deja el archivo a medias.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    // Mantener el enlace y reemplazar su destino, sin recurrir a escritura truncada.
    let resolved;
    let path = if fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        resolved = fs::canonicalize(path)?;
        resolved.as_path()
    } else {
        path
    };
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
            if created {
                let _ = fs::remove_file(&tmp);
            }
            // Si no se puede reemplazar, preservar el original y comunicar el error.
            Err(e)
        }
    }
}

pub(crate) fn write_checked(path: &Path, bytes: &[u8], expected_mtime: Option<u64>) -> Result<u64, String> {
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
pub(crate) async fn write_file(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: String,
    contents: String,
    expected_mtime: Option<u64>,
) -> Result<u64, String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || write_file_sync(safe.to_string_lossy().into_owned(), contents, expected_mtime))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn write_file_sync(path: String, contents: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    write_checked(Path::new(&path), contents.as_bytes(), expected_mtime)
}

/// Fecha de modificación en milisegundos desde la época Unix.
#[tauri::command]
pub(crate) async fn file_mtime(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<u64, String> {
    let safe = guard.ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || file_mtime_sync(safe.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

pub(crate) fn file_mtime_sync(path: String) -> Result<u64, String> {
    let m = fs::metadata(&path).map_err(|e| e.to_string())?;
    let t = m.modified().map_err(|e| e.to_string())?;
    Ok(t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
}

pub(crate) fn create_file_sync(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(tr("Ya existe un archivo o carpeta con ese nombre").into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub(crate) async fn create_file(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || create_file_sync(&safe)).await.map_err(|e| e.to_string())?
}

pub(crate) fn create_dir_sync(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(tr("Ya existe un archivo o carpeta con ese nombre").into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn create_dir(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || create_dir_sync(&safe)).await.map_err(|e| e.to_string())?
}

pub(crate) fn rename_path_sync(from: &Path, to: &Path) -> Result<(), String> {
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
pub(crate) async fn rename_path(guard: tauri::State<'_, fsguard::WorkspaceGuard>, from: String, to: String) -> Result<(), String> {
    let safe_from = guard.ensure_write(&from)?;
    let safe_to = guard.ensure_write(&to)?;
    tauri::async_runtime::spawn_blocking(move || rename_path_sync(&safe_from, &safe_to)).await.map_err(|e| e.to_string())?
}

/// Mueve el archivo o carpeta a la papelera de reciclaje.
#[tauri::command]
pub(crate) async fn delete_path(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || trash::delete(&safe).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn reveal_in_explorer(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<(), String> {
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
            let dir = if safe.is_dir() { safe.clone() } else { safe.parent().map(|d| d.to_path_buf()).unwrap_or(safe) };
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
