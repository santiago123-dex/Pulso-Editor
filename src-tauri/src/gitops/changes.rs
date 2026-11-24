//! Cambios del árbol de trabajo: estado, preparar y quitar, commits, descartar y fuentes de las diferencias.
use super::*;

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Change {
    /// Ruta relativa a la raíz del repositorio, con `/`.
    pub path: String,
    /// M modificado, A añadido, D eliminado, R renombrado, U sin seguimiento, ! conflicto.
    pub status: String,
    /// Nombre anterior en un renombrado.
    pub orig: Option<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Changes {
    pub top: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// Falso en un repositorio recién creado, sin ningún commit.
    pub has_head: bool,
    pub staged: Vec<Change>,
    pub unstaged: Vec<Change>,
    pub conflicted: Vec<Change>,
}

/// Interpreta `git status --porcelain=v1 -z -b -uall`.
pub fn parse_changes(out: &str) -> Changes {
    let mut c = Changes::default();
    let mut records = out.split('\0');
    while let Some(rec) = records.next() {
        if let Some(head) = rec.strip_prefix("## ") {
            let name = head.split(" [").next().unwrap_or(head);
            c.branch = match name.strip_prefix("No commits yet on ") {
                Some(b) => b.to_string(),
                None => name.split("...").next().unwrap_or(name).to_string(),
            };
            if let Some(i) = head.find('[') {
                for part in head[i + 1..].trim_end_matches(']').split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") { c.ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = part.strip_prefix("behind ") { c.behind = n.parse().unwrap_or(0); }
                }
            }
            continue;
        }
        let bytes = rec.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' { continue; }
        let path = &rec[3..];
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        let orig = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') { records.next().map(|s| s.to_string()) } else { None };
        let make = |status: &str| Change { path: path.to_string(), status: status.to_string(), orig: orig.clone() };
        if (x, y) == ('?', '?') { c.unstaged.push(make("U")); continue; }
        if (x, y) == ('!', '!') { continue; }
        if x == 'U' || y == 'U' || (x, y) == ('A', 'A') || (x, y) == ('D', 'D') { c.conflicted.push(make("!")); continue; }
        if x != ' ' { c.staged.push(make(letter(x))); }
        if y != ' ' { c.unstaged.push(make(letter(y))); }
    }
    c
}

pub(super) fn changes_sync(root: &str) -> Result<Changes, String> {
    let top = top_of(root)?;
    let out = run(&top, &["status", "--porcelain=v1", "-z", "-b", "-uall"])?;
    let mut c = parse_changes(&out);
    c.top = top.clone();
    c.has_head = has_head(&top);
    Ok(c)
}

pub(super) const CHUNK: usize = 100;

pub(super) fn with_paths(top: &str, base: &[&str], paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        let mut args: Vec<&str> = base.to_vec();
        args.extend(["--", "."]);
        return run(top, &args).map(|_| ());
    }
    for chunk in paths.chunks(CHUNK) {
        let mut args: Vec<&str> = base.to_vec();
        args.push("--");
        args.extend(chunk.iter().map(|s| s.as_str()));
        run(top, &args)?;
    }
    Ok(())
}

/// Prepara los archivos indicados (todos si la lista está vacía).
pub(super) fn stage_sync(root: &str, paths: Vec<String>) -> Result<(), String> {
    let top = top_of(root)?;
    with_paths(&top, &["add", "-A"], &paths)
}

/// Quita del área de preparación los archivos indicados (todos si la lista está vacía) sin tocar su contenido.
pub(super) fn unstage_sync(root: &str, paths: Vec<String>) -> Result<(), String> {
    let top = top_of(root)?;
    if has_head(&top) {
        with_paths(&top, &["restore", "--staged"], &paths)
    } else {
        // Sin commits no existe HEAD al que volver: se quitan del índice.
        with_paths(&top, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], &paths)
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CommitResult {
    pub hash: String,
    pub summary: String,
}

pub(super) fn commit_sync(root: &str, message: &str) -> Result<CommitResult, String> {
    let message = message.trim();
    if message.is_empty() { return Err(tr("Escribe un mensaje para el commit").into()); }
    let top = top_of(root)?;
    let staged = run(&top, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() { return Err(tr("No hay cambios preparados para confirmar").into()); }
    let mut child = git_command(&top)
        .args(["commit", "-q", "-F", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    let mut stdin = child.stdin.take().ok_or(tr("No se pudo enviar el mensaje a git"))?;
    let msg_bytes = message.as_bytes().to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&msg_bytes));
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if let Ok(Err(e)) = writer.join() {
        if o.status.success() {
            return Err(e.to_string());
        }
    }
    if !o.status.success() { return Err(text(&o)); }
    let hash = run(&top, &["rev-parse", "--short", "HEAD"])?.trim().to_string();
    Ok(CommitResult { hash, summary: message.lines().next().unwrap_or("").to_string() })
}

pub(super) fn last_commit_message_sync(root: &str) -> Result<String, String> {
    let top = top_of(root)?;
    if !succeeds(&top, &["rev-parse", "--verify", "HEAD"]) {
        return Err(tr("Todavía no hay ningún commit en este repositorio").into());
    }
    Ok(run(&top, &["log", "-1", "--pretty=%B"])?.trim().to_string())
}

pub(super) fn amend_sync(root: &str, message: Option<&str>) -> Result<CommitResult, String> {
    let top = top_of(root)?;
    if !succeeds(&top, &["rev-parse", "--verify", "HEAD"]) {
        return Err(tr("Todavía no hay ningún commit que corregir").into());
    }
    let clean = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(msg) = clean {
        let mut child = git_command(&top)
            .args(["commit", "--amend", "-q", "-F", "-"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
        let mut stdin = child.stdin.take().ok_or(tr("No se pudo enviar el mensaje a git"))?;
        let msg_bytes = msg.as_bytes().to_vec();
        let writer = std::thread::spawn(move || stdin.write_all(&msg_bytes));
        let o = child.wait_with_output().map_err(|e| e.to_string())?;
        if let Ok(Err(e)) = writer.join() {
            if o.status.success() { return Err(e.to_string()); }
        }
        if !o.status.success() { return Err(text(&o)); }
    } else {
        run(&top, &["commit", "--amend", "--no-edit", "-q"])?;
    }
    let hash = run(&top, &["rev-parse", "--short", "HEAD"])?.trim().to_string();
    let summary = run(&top, &["log", "-1", "--pretty=%s"])?.trim().to_string();
    Ok(CommitResult { hash, summary })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DiffSources {
    pub original: String,
    pub modified: String,
    pub binary: bool,
}

pub(super) const MAX_DIFF_BYTES: usize = 2_000_000;

/// Contenido de `spec` (por ejemplo `HEAD:ruta` o `:ruta`). Comprueba primero el tamaño con `cat-file -s`
/// para no cargar blobs enormes en RAM. Cadena vacía si no existe en esa versión.
pub(super) fn blob(top: &str, spec: &str) -> Result<Vec<u8>, String> {
    let size_out = git_command(top)
        .args(["cat-file", "-s", spec])
        .output()
        .map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    if !size_out.status.success() {
        return Ok(Vec::new());
    }
    if let Ok(sz) = String::from_utf8_lossy(&size_out.stdout).trim().parse::<usize>() {
        if sz > MAX_DIFF_BYTES {
            return Err(tr("El archivo es demasiado grande para mostrar diferencias").into());
        }
    }
    let o = git_command(top).args(["show", spec]).output().map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    if !o.status.success() { return Err(text(&o)); }
    Ok(o.stdout)
}

pub(super) fn read_disk_for_diff(path: &std::path::Path) -> Result<Vec<u8>, String> {
    match fs::metadata(path) {
        Ok(m) => {
            if m.len() > MAX_DIFF_BYTES as u64 {
                return Err(tr("El archivo es demasiado grande para mostrar diferencias").into());
            }
            fs::read(path).map_err(|e| e.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Las dos versiones que se comparan: preparado = HEAD contra el índice; sin preparar = índice contra el disco.
pub(super) fn diff_sources_sync(root: &str, path: &str, orig: Option<&str>, staged: bool) -> Result<DiffSources, String> {
    if !safe_relative(path) { return Err(tr("Ruta no válida").into()); }
    if let Some(o) = orig {
        if !safe_relative(o) { return Err(tr("Ruta de origen no válida").into()); }
    }
    let top = top_of(root)?;
    let (a, b) = if staged {
        (blob(&top, &format!("HEAD:{}", orig.unwrap_or(path)))?, blob(&top, &format!(":{}", path))?)
    } else {
        (blob(&top, &format!(":{}", path))?, read_disk_for_diff(&std::path::Path::new(&top).join(path))?)
    };
    if a.len() > MAX_DIFF_BYTES || b.len() > MAX_DIFF_BYTES {
        return Err(tr("El archivo es demasiado grande para mostrar diferencias").into());
    }
    let binary = a.iter().take(8000).any(|&x| x == 0) || b.iter().take(8000).any(|&x| x == 0);
    if binary { return Ok(DiffSources { original: String::new(), modified: String::new(), binary: true }); }
    Ok(DiffSources {
        original: String::from_utf8_lossy(&a).into_owned(),
        modified: String::from_utf8_lossy(&b).into_owned(),
        binary: false,
    })
}

// ---------- Descartar cambios ----------
#[derive(serde::Deserialize, Debug, Clone)]
pub struct DiscardItem {
    pub path: String,
    pub status: String,
}

/// La ruta debe quedarse dentro del repositorio: nada de `..`, rutas absolutas ni unidades de Windows.
pub(super) fn safe_relative(path: &str) -> bool {
    let p = std::path::Path::new(path);
    let has_drive = path.len() >= 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.as_bytes()[1] == b':';
    !path.is_empty()
        && !has_drive
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && p.is_relative()
        && !p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_) | std::path::Component::RootDir))
}

/// Descarta los cambios sin preparar. Los modificados y eliminados vuelven a la versión preparada;
/// los archivos sin seguimiento se retiran con `remove_untracked` (en la aplicación, a la papelera).
pub(super) fn discard_sync(root: &str, items: Vec<DiscardItem>, remove_untracked: &dyn Fn(&std::path::Path) -> Result<(), String>) -> Result<usize, String> {
    let top = top_of(root)?;
    if let Some(bad) = items.iter().find(|i| !safe_relative(&i.path)) {
        return Err(trf("Ruta no válida: {path}", &[("path", &bad.path)]));
    }
    let tracked: Vec<String> = items.iter().filter(|i| i.status != "U" && i.status != "!").map(|i| i.path.clone()).collect();
    let untracked: Vec<&DiscardItem> = items.iter().filter(|i| i.status == "U").collect();
    if !tracked.is_empty() { with_paths(&top, &["restore"], &tracked)?; }
    for u in &untracked {
        remove_untracked(&std::path::Path::new(&top).join(&u.path))?;
    }
    Ok(tracked.len() + untracked.len())
}
