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
use tauri::Manager;

mod term;
mod userconf;
mod lsp;
mod gitops;

/// Los procesos auxiliares no deben abrir ventanas de consola en Windows.
fn background_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

const SKIP_DIRS: [&str; 7] = [".git", "node_modules", "target", "dist", "build", ".next", ".venv"];

/// Normaliza a barras `/` para que el frontend use un solo formato de ruta.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_sync(path)).await.map_err(|e| e.to_string())?
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
async fn list_files(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_files_sync(path)).await.map_err(|e| e.to_string())?
}

fn list_files_sync(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    walk(&path, |p| {
        out.push(norm(&p));
        out.len() < 20_000
    });
    Ok(out)
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read_to_string(&path).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
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
async fn write_file(path: String, contents: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || write_file_sync(path, contents, expected_mtime)).await.map_err(|e| e.to_string())?
}

fn write_file_sync(path: String, contents: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    write_checked(Path::new(&path), contents.as_bytes(), expected_mtime)
}

/// Fecha de modificación en milisegundos desde la época Unix.
#[tauri::command]
async fn file_mtime(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || file_mtime_sync(path)).await.map_err(|e| e.to_string())?
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

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    keyring::Entry::new(SECRET_SERVICE, &name)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    match keyring::Entry::new(SECRET_SERVICE, &name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err("Ya existe un archivo o carpeta con ese nombre".into());
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::File::create(p).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("Ya existe un archivo o carpeta con ese nombre".into());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("Ya existe un archivo o carpeta con ese nombre".into());
    }
    let f = from.replace('\\', "/");
    let t = to.replace('\\', "/");
    if t.starts_with(&format!("{}/", f.trim_end_matches('/'))) {
        return Err("No se puede mover una carpeta dentro de sí misma".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Mueve el archivo o carpeta a la papelera de reciclaje.
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let p = path.replace('/', "\\");
        let _ = Command::new("explorer").arg(format!("/select,{}", p)).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").args(["-R", &path]).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = Path::new(&path).parent().map(|d| d.to_path_buf()).unwrap_or_default();
        let _ = Command::new("xdg-open").arg(dir).spawn();
    }
    Ok(())
}

fn build_regex(query: &str, case_sensitive: bool, use_regex: bool, whole_word: bool) -> Result<Regex, String> {
    if query.is_empty() {
        return Err("La búsqueda está vacía".into());
    }
    let mut pat = if use_regex { query.to_string() } else { regex::escape(query) };
    if whole_word {
        pat = format!(r"\b(?:{})\b", pat);
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Expresión regular no válida: {}", e))
}

#[derive(Serialize)]
struct Match {
    path: String,
    line: u32,
    col: u32,
    len: u32,
    text: String,
}

fn included(path: &str, include: &[String]) -> bool {
    if include.is_empty() {
        return true;
    }
    let lower = path.to_lowercase();
    include.iter().any(|pat| {
        let pat = pat.trim().to_lowercase().replace('\\', "/");
        if pat.is_empty() {
            return false;
        }
        match pat.strip_prefix('*') {
            Some(rest) => lower.ends_with(rest),
            None => lower.contains(&pat),
        }
    })
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
    root: String, query: String, case_sensitive: bool, use_regex: bool, whole_word: bool, include: Vec<String>,
    unsaved: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<Match>, String> {
    let unsaved = unsaved.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || search_files_sync(root, query, case_sensitive, use_regex, whole_word, include, &unsaved)).await.map_err(|e| e.to_string())?
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
    const MAX: usize = 5000;
    let re = build_regex(&query, case_sensitive, use_regex, whole_word)?;
    let mut out: Vec<Match> = Vec::new();
    walk(&root, |p| {
        let path = norm(&p);
        if !included(&path, &include) {
            return true;
        }
        // Un documento abierto con cambios sin guardar se busca con su contenido en pantalla, no con el del disco.
        let text = match unsaved.get(&path) {
            Some(t) => t.clone(),
            None => match read_text(&p) { Some(t) => t, None => return true },
        };
        for (i, line) in text.lines().enumerate() {
            for m in re.find_iter(line) {
                if m.start() == m.end() {
                    continue;
                }
                out.push(Match {
                    path: path.clone(),
                    line: (i + 1) as u32,
                    col: line[..m.start()].encode_utf16().count() as u32 + 1,
                    len: line[m.start()..m.end()].encode_utf16().count() as u32,
                    text: line.chars().take(300).collect(),
                });
                if out.len() >= MAX {
                    return false;
                }
            }
        }
        true
    });
    Ok(out)
}

/// Reemplaza las coincidencias de un archivo con las mismas reglas que la búsqueda (línea a línea,
/// conservando los finales de línea) y lo guarda con escritura atómica y detección de cambios.
/// Si `expected` no coincide con lo que hay ahora en disco, no escribe nada.
#[tauri::command]
async fn replace_in_file(
    path: String, query: String, replacement: String, case_sensitive: bool, use_regex: bool, whole_word: bool,
    expected: Option<u32>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || replace_in_file_sync(path, query, replacement, case_sensitive, use_regex, whole_word, expected)).await.map_err(|e| e.to_string())?
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
    let text = read_text(p).ok_or_else(|| "El archivo es binario, demasiado grande o no es UTF-8; no se modifica".to_string())?;
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
            return Err(format!("El archivo cambió desde la búsqueda ({} coincidencias previstas, {} ahora)", e, count));
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
fn scan_vscode_themes() -> Vec<ThemeRef> {
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
    let out = background_command("git").arg("-C").arg(path).args(args).output().ok()?;
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
        if rec.len() < 4 { continue; }
        let (xy, file) = rec.split_at(3);
        let (x, y) = (xy.as_bytes()[0] as char, xy.as_bytes()[1] as char);
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
async fn git_status(path: String) -> Option<GitInfo> {
    tauri::async_runtime::spawn_blocking(move || git_status_sync(path)).await.ok().flatten()
}

fn git_status_sync(path: String) -> Option<GitInfo> {
    let top = git_out(&path, &["rev-parse", "--show-toplevel"])?.trim().replace('\\', "/");
    let text = git_out(&path, &["status", "--porcelain=v1", "-z", "-b", "--ignored"])?;
    Some(parse_git_status(&text, &top))
}

/// Devuelve la URL del remoto `origin` del repo en `path`.
#[tauri::command]
async fn git_remote(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_remote_sync(path)).await.map_err(|e| e.to_string())?
}

fn git_remote_sync(path: String) -> Result<String, String> {
    let out = background_command("git")
        .args(["-C", &path, "remote", "get-url", "origin"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(term::TermState::default())
        .manage(lsp::LspState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            list_files,
            read_file,
            write_file,
            file_mtime,
            backup_write,
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
            gitops::git_diff_sources
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar Pulso Editor")
        .run(|app, event| {
            // Al salir se cierran las terminales para no dejar shells huérfanas.
            if let tauri::RunEvent::Exit = event {
                app.state::<term::TermState>().kill_all();
                app.state::<lsp::LspState>().stop();
            }
        });
}

#[cfg(test)]
mod tests;
