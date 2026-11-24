//! Estado de Git para el explorador y la barra de estado (rama, archivos con cambios y remoto).
use super::*;

#[derive(Serialize)]
pub(crate) struct GitFile {
    pub(crate) path: String,
    /// U sin seguimiento, A añadido, M modificado, D eliminado, R renombrado, ! conflicto, I ignorado.
    pub(crate) status: String,
    pub(crate) dir: bool,
}

#[derive(Serialize)]
pub(crate) struct GitInfo {
    pub(crate) branch: String,
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
    pub(crate) dirty: bool,
    pub(crate) files: Vec<GitFile>,
}

pub(crate) fn git_out(path: &str, args: &[&str]) -> Option<String> {
    // Solo lectura: sin candados opcionales y en locale C para parseo determinista.
    let out = background_command("git").env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C").arg("-C").arg(path).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Interpreta la salida de `git status --porcelain=v1 -z -b --ignored`.
pub(crate) fn parse_git_status(text: &str, top: &str) -> GitInfo {
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
                    if let Some(n) = part.strip_prefix("ahead ") {
                        info.ahead = n.parse().unwrap_or(0);
                    }
                    if let Some(n) = part.strip_prefix("behind ") {
                        info.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let bytes = rec.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' {
            continue;
        }
        let file = &rec[3..];
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            records.next();
        }
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
        if status != "I" {
            info.dirty = true;
        }
        info.files.push(GitFile { path: format!("{}/{}", top, file.trim_end_matches('/')), status: status.to_string(), dir: file.ends_with('/') });
    }
    info
}

/// Estado de Git de la carpeta: rama, adelantos y archivos cambiados. None si no es un repositorio.
#[tauri::command]
pub(crate) async fn git_status(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<Option<GitInfo>, String> {
    // Solo carpetas abiertas como espacio de trabajo; para el resto, lo mismo que una carpeta que no es repositorio.
    if guard.ensure_dir(&path).is_err() {
        return Ok(None);
    }
    Ok(tauri::async_runtime::spawn_blocking(move || git_status_sync(path)).await.ok().flatten())
}

pub(crate) fn git_status_sync(path: String) -> Option<GitInfo> {
    let top = git_out(&path, &["rev-parse", "--show-toplevel"])?.trim().replace('\\', "/");
    let text = git_out(&path, &["status", "--porcelain=v1", "-z", "-b", "--ignored"])?;
    Some(parse_git_status(&text, &top))
}

/// Devuelve la URL del remoto `origin` del repo en `path`.
#[tauri::command]
pub(crate) async fn git_remote(guard: tauri::State<'_, fsguard::WorkspaceGuard>, path: String) -> Result<String, String> {
    // La dirección del remoto puede llevar un token incrustado: solo se entrega la de una carpeta abierta.
    guard.ensure_dir(&path)?;
    tauri::async_runtime::spawn_blocking(move || git_remote_sync(path)).await.map_err(|e| e.to_string())?
}

pub(crate) fn git_remote_sync(path: String) -> Result<String, String> {
    let out = background_command("git").env("LC_ALL", "C").args(["-C", &path, "remote", "get-url", "origin"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
