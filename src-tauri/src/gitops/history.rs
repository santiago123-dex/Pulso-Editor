//! Historial de commits, archivos de un commit y culpa (blame).
use super::*;

// ---------- Historial y culpa (blame) ----------
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /// Fecha ISO 8601 del autor.
    pub date: String,
    pub subject: String,
    /// Ramas y etiquetas que apuntan a este commit.
    pub refs: Vec<String>,
}

pub(super) const REC: char = '\u{1e}';
pub(super) const FLD: char = '\u{1f}';

/// Lee la salida de `git log --format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D`.
pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split(REC)
        .filter(|r| !r.trim().is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.trim_end_matches('\n').split(FLD).collect();
            if f.len() < 6 { return None; }
            let refs = f.get(6).map(|d| d.split(", ").map(|x| x.trim()).filter(|x| !x.is_empty()).map(|x| x.to_string()).collect()).unwrap_or_default();
            Some(Commit { hash: f[0].trim().to_string(), short: f[1].to_string(), author: f[2].to_string(), email: f[3].to_string(), date: f[4].to_string(), subject: f[5].to_string(), refs })
        })
        .collect()
}

pub(super) fn valid_hash(h: &str) -> bool {
    (7..=64).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit())
}

pub(super) const MAX_LOG: u32 = 200;

/// Historial de commits de HEAD (o de un archivo, siguiendo sus renombrados), de `limit` en `limit`.
pub(super) fn log_sync(root: &str, path: Option<&str>, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
    let top = top_of(root)?;
    if !has_head(&top) { return Ok(Vec::new()); }
    if let Some(p) = path { if !safe_relative(p) { return Err(tr("Ruta no válida").into()); } }
    let limit = limit.clamp(1, MAX_LOG).to_string();
    let skip = skip.to_string();
    let mut args: Vec<&str> = vec!["log", "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D", "-n", &limit, "--skip", &skip];
    if path.is_some() { args.push("--follow"); }
    args.push("--");
    if let Some(p) = path { args.push(p); }
    Ok(parse_log(&run(&top, &args)?))
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct CommitFile {
    /// M, A, D o R.
    pub status: String,
    pub path: String,
    /// Nombre anterior si se renombró.
    pub orig: Option<String>,
}

/// Lee `git show --name-status -z`: `M\0ruta\0` y, para renombrados, `R100\0antes\0después\0`.
pub fn parse_name_status(out: &str) -> Vec<CommitFile> {
    let mut parts = out.split('\0').filter(|x| !x.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let status = code.chars().next().map(|c| c.to_string()).unwrap_or_default();
        if status == "R" || status == "C" {
            let (Some(a), Some(b)) = (parts.next(), parts.next()) else { break };
            files.push(CommitFile { status: "R".into(), path: b.to_string(), orig: Some(a.to_string()) });
        } else {
            let Some(path) = parts.next() else { break };
            let status = if status == "T" { "M".to_string() } else { status };
            files.push(CommitFile { status, path: path.to_string(), orig: None });
        }
    }
    files
}

pub(super) fn commit_files_sync(root: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    if !valid_hash(hash) { return Err(tr("Identificador de commit no válido").into()); }
    let top = top_of(root)?;
    Ok(parse_name_status(&run(&top, &["show", "--name-status", "-M", "-z", "--format=", hash])?))
}

/// Las dos versiones de un archivo en un commit: la del padre y la del propio commit.
pub(super) fn commit_sources_sync(root: &str, hash: &str, path: &str, orig: Option<&str>) -> Result<DiffSources, String> {
    if !valid_hash(hash) { return Err(tr("Identificador de commit no válido").into()); }
    if !safe_relative(path) { return Err(tr("Ruta no válida").into()); }
    if let Some(o) = orig {
        if !safe_relative(o) { return Err(tr("Ruta de origen no válida").into()); }
    }
    let top = top_of(root)?;
    let a = blob(&top, &format!("{hash}^:{}", orig.unwrap_or(path)))?;
    let b = blob(&top, &format!("{hash}:{path}"))?;
    if a.len() > MAX_DIFF_BYTES || b.len() > MAX_DIFF_BYTES {
        return Err(tr("El archivo es demasiado grande para mostrar diferencias").into());
    }
    let binary = a.iter().take(8000).any(|&x| x == 0) || b.iter().take(8000).any(|&x| x == 0);
    if binary { return Ok(DiffSources { original: String::new(), modified: String::new(), binary: true }); }
    Ok(DiffSources { original: String::from_utf8_lossy(&a).into_owned(), modified: String::from_utf8_lossy(&b).into_owned(), binary: false })
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct BlameLine {
    pub line: u32,
    /// Vacío si la línea aún no está en ningún commit.
    pub hash: String,
    pub author: String,
    /// Segundos Unix.
    pub time: i64,
    pub summary: String,
}

/// Lee `git blame --line-porcelain`: cada línea trae su bloque completo de cabeceras.
pub fn parse_blame(out: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    let (mut hash, mut final_line, mut author, mut time, mut summary) = (String::new(), 0u32, String::new(), 0i64, String::new());
    for l in out.lines() {
        if let Some(content) = l.strip_prefix('\t') {
            let _ = content;
            let uncommitted = hash.chars().all(|c| c == '0');
            lines.push(BlameLine { line: final_line, hash: if uncommitted { String::new() } else { hash.clone() }, author: author.clone(), time, summary: summary.clone() });
            continue;
        }
        if let Some(v) = l.strip_prefix("author ") { author = v.to_string(); }
        else if let Some(v) = l.strip_prefix("author-time ") { time = v.trim().parse().unwrap_or(0); }
        else if let Some(v) = l.strip_prefix("summary ") { summary = v.to_string(); }
        else {
            let f: Vec<&str> = l.split(' ').collect();
            if f.len() >= 3 && f[0].len() >= 40 && f[0].chars().all(|c| c.is_ascii_hexdigit()) {
                hash = f[0].to_string();
                final_line = f[2].parse().unwrap_or(0);
            }
        }
    }
    lines
}

pub(super) fn blame_sync(root: &str, path: &str) -> Result<Vec<BlameLine>, String> {
    if !safe_relative(path) { return Err(tr("Ruta no válida").into()); }
    let top = top_of(root)?;
    if !has_head(&top) { return Ok(Vec::new()); }
    Ok(parse_blame(&run(&top, &["blame", "--line-porcelain", "--", path])?))
}
