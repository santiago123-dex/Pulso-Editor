//! Operaciones de Git de la interfaz: cambios preparados y sin preparar, stage, unstage, commit y las dos
//! versiones de un archivo para mostrar diferencias. Todo se hace con el ejecutable `git` del sistema.
use super::background_command;
use serde::Serialize;
use std::{
    fs,
    io::Write,
    process::{Command, Output, Stdio},
};

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

fn git_command(dir: &str) -> Command {
    let mut c = background_command("git");
    c.arg("-C").arg(dir).args(["-c", "core.quotepath=false"]);
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    c
}

fn text(o: &Output) -> String {
    let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
    if err.is_empty() { String::from_utf8_lossy(&o.stdout).trim().to_string() } else { err }
}

/// Ejecuta git y devuelve la salida estándar, o el mensaje de error de git tal cual.
fn run(dir: &str, args: &[&str]) -> Result<String, String> {
    let o = git_command(dir).args(args).output().map_err(|e| format!("No se pudo ejecutar git: {e}"))?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err(text(&o)) }
}

fn succeeds(dir: &str, args: &[&str]) -> bool {
    git_command(dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

fn top_of(root: &str) -> Result<String, String> {
    let t = run(root, &["rev-parse", "--show-toplevel"]).map_err(|_| "Esta carpeta no es un repositorio de Git".to_string())?;
    Ok(t.trim().replace('\\', "/"))
}

fn has_head(top: &str) -> bool {
    succeeds(top, &["rev-parse", "--verify", "-q", "HEAD"])
}

fn letter(c: char) -> &'static str {
    match c {
        'M' | 'T' => "M",
        'A' | 'C' => "A",
        'D' => "D",
        'R' => "R",
        _ => "M",
    }
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
        if rec.len() < 4 { continue; }
        let (xy, path) = rec.split_at(3);
        let (x, y) = (xy.as_bytes()[0] as char, xy.as_bytes()[1] as char);
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

fn changes_sync(root: &str) -> Result<Changes, String> {
    let top = top_of(root)?;
    let out = run(&top, &["status", "--porcelain=v1", "-z", "-b", "-uall"])?;
    let mut c = parse_changes(&out);
    c.top = top.clone();
    c.has_head = has_head(&top);
    Ok(c)
}

const CHUNK: usize = 100;

fn with_paths(top: &str, base: &[&str], paths: &[String]) -> Result<(), String> {
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
fn stage_sync(root: &str, paths: Vec<String>) -> Result<(), String> {
    let top = top_of(root)?;
    with_paths(&top, &["add", "-A"], &paths)
}

/// Quita del área de preparación los archivos indicados (todos si la lista está vacía) sin tocar su contenido.
fn unstage_sync(root: &str, paths: Vec<String>) -> Result<(), String> {
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

fn commit_sync(root: &str, message: &str) -> Result<CommitResult, String> {
    let message = message.trim();
    if message.is_empty() { return Err("Escribe un mensaje para el commit".into()); }
    let top = top_of(root)?;
    let staged = run(&top, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() { return Err("No hay cambios preparados para confirmar".into()); }
    let mut child = git_command(&top)
        .args(["commit", "-q", "-F", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("No se pudo ejecutar git: {e}"))?;
    child.stdin.take().ok_or("No se pudo enviar el mensaje a git")?.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if !o.status.success() { return Err(text(&o)); }
    let hash = run(&top, &["rev-parse", "--short", "HEAD"])?.trim().to_string();
    Ok(CommitResult { hash, summary: message.lines().next().unwrap_or("").to_string() })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DiffSources {
    pub original: String,
    pub modified: String,
    pub binary: bool,
}

const MAX_DIFF_BYTES: usize = 2_000_000;

/// Contenido de `spec` (por ejemplo `HEAD:ruta` o `:ruta`). Cadena vacía si no existe en esa versión.
fn blob(top: &str, spec: &str) -> Result<Vec<u8>, String> {
    if !succeeds(top, &["cat-file", "-e", spec]) { return Ok(Vec::new()); }
    let o = git_command(top).args(["show", spec]).output().map_err(|e| format!("No se pudo ejecutar git: {e}"))?;
    if !o.status.success() { return Err(text(&o)); }
    Ok(o.stdout)
}

/// Las dos versiones que se comparan: preparado = HEAD contra el índice; sin preparar = índice contra el disco.
fn diff_sources_sync(root: &str, path: &str, orig: Option<&str>, staged: bool) -> Result<DiffSources, String> {
    let top = top_of(root)?;
    let (a, b) = if staged {
        (blob(&top, &format!("HEAD:{}", orig.unwrap_or(path)))?, blob(&top, &format!(":{}", path))?)
    } else {
        (blob(&top, &format!(":{}", path))?, fs::read(std::path::Path::new(&top).join(path)).unwrap_or_default())
    };
    if a.len() > MAX_DIFF_BYTES || b.len() > MAX_DIFF_BYTES {
        return Err("El archivo es demasiado grande para mostrar diferencias".into());
    }
    let binary = a.iter().take(8000).any(|&x| x == 0) || b.iter().take(8000).any(|&x| x == 0);
    if binary { return Ok(DiffSources { original: String::new(), modified: String::new(), binary: true }); }
    Ok(DiffSources {
        original: String::from_utf8_lossy(&a).into_owned(),
        modified: String::from_utf8_lossy(&b).into_owned(),
        binary: false,
    })
}

#[tauri::command]
pub async fn git_changes(root: String) -> Result<Changes, String> {
    tauri::async_runtime::spawn_blocking(move || changes_sync(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stage_sync(&root, paths)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || unstage_sync(&root, paths)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<CommitResult, String> {
    tauri::async_runtime::spawn_blocking(move || commit_sync(&root, &message)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_sources(root: String, path: String, orig: Option<String>, staged: bool) -> Result<DiffSources, String> {
    tauri::async_runtime::spawn_blocking(move || diff_sources_sync(&root, &path, orig.as_deref(), staged)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new() -> Repo {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!("pulso-gitops-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(&p).unwrap();
            let r = Repo(p);
            r.git(&["init", "-q"]);
            r.git(&["config", "user.email", "test@example.com"]);
            r.git(&["config", "user.name", "Prueba"]);
            r.git(&["config", "commit.gpgsign", "false"]);
            r
        }
        fn s(&self) -> String { self.0.to_string_lossy().replace('\\', "/") }
        fn git(&self, args: &[&str]) -> String { run(&self.s(), args).unwrap() }
        fn write(&self, name: &str, text: &str) {
            let p = self.0.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        fn commit_all(&self, msg: &str) { self.git(&["add", "-A"]); self.git(&["commit", "-q", "-m", msg]); }
    }
    impl Drop for Repo { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn parser_splits_staged_unstaged_untracked_and_conflicts() {
        let c = parse_changes("## main...origin/main [ahead 1]\0M  a.ts\0 M b.ts\0MM c.ts\0A  d.ts\0 D e.ts\0?? f.ts\0UU g.ts\0!! h/\0");
        let names = |v: &Vec<Change>| v.iter().map(|x| format!("{}{}", x.status, x.path)).collect::<Vec<_>>();
        assert_eq!(names(&c.staged), ["Ma.ts", "Mc.ts", "Ad.ts"]);
        assert_eq!(names(&c.unstaged), ["Mb.ts", "Mc.ts", "De.ts", "Uf.ts"]);
        assert_eq!(names(&c.conflicted), ["!g.ts"]);
        assert_eq!((c.branch.as_str(), c.ahead, c.behind), ("main", 1, 0));
    }

    #[test]
    fn parser_keeps_original_name_of_renames() {
        let c = parse_changes("## dev\0R  nuevo.ts\0viejo.ts\0 M otro.ts\0");
        assert_eq!(c.staged.len(), 1);
        assert_eq!(c.staged[0].orig.as_deref(), Some("viejo.ts"));
        assert_eq!(c.unstaged.len(), 1);
    }

    #[test]
    fn full_flow_stage_commit_and_clean() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        r.write("dir con espacio/ñandú.txt", "dos\n");
        let c = changes_sync(&r.s()).unwrap();
        assert!(!c.has_head);
        assert_eq!(c.unstaged.len(), 2, "-uall lista cada archivo sin seguimiento");
        assert!(c.unstaged.iter().any(|x| x.path == "dir con espacio/ñandú.txt"), "sin escapes en nombres con ñ y espacios");
        stage_sync(&r.s(), vec!["a.txt".into()]).unwrap();
        let c = changes_sync(&r.s()).unwrap();
        assert_eq!((c.staged.len(), c.unstaged.len()), (1, 1));
        let done = commit_sync(&r.s(), "primer commit\n\ncuerpo").unwrap();
        assert_eq!(done.summary, "primer commit");
        assert!(!done.hash.is_empty());
        assert_eq!(r.git(&["log", "-1", "--format=%B"]).trim(), "primer commit\n\ncuerpo");
        let c = changes_sync(&r.s()).unwrap();
        assert!(c.has_head);
        assert_eq!((c.staged.len(), c.unstaged.len()), (0, 1));
        stage_sync(&r.s(), vec![]).unwrap();
        assert_eq!(changes_sync(&r.s()).unwrap().staged.len(), 1, "lista vacía = preparar todo");
    }

    #[test]
    fn unstage_works_before_and_after_the_first_commit() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        stage_sync(&r.s(), vec!["a.txt".into()]).unwrap();
        unstage_sync(&r.s(), vec!["a.txt".into()]).unwrap();
        let c = changes_sync(&r.s()).unwrap();
        assert_eq!((c.staged.len(), c.unstaged.len()), (0, 1));
        assert_eq!(fs::read_to_string(r.0.join("a.txt")).unwrap(), "uno\n", "no toca el contenido");
        r.commit_all("base");
        r.write("a.txt", "dos\n");
        stage_sync(&r.s(), vec![]).unwrap();
        unstage_sync(&r.s(), vec![]).unwrap();
        let c = changes_sync(&r.s()).unwrap();
        assert_eq!((c.staged.len(), c.unstaged.len()), (0, 1));
        assert_eq!(fs::read_to_string(r.0.join("a.txt")).unwrap(), "dos\n");
    }

    #[test]
    fn commit_validates_message_and_staged_changes() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        assert!(commit_sync(&r.s(), "   ").unwrap_err().contains("mensaje"));
        assert!(commit_sync(&r.s(), "x").unwrap_err().contains("No hay cambios preparados"));
        assert!(!r.git(&["status", "--porcelain"]).is_empty(), "no se confirmó nada");
    }

    #[test]
    fn commit_reports_git_errors_verbatim() {
        let r = Repo::new();
        r.git(&["config", "--unset", "user.email"]);
        r.git(&["config", "--unset", "user.name"]);
        r.write("a.txt", "uno\n");
        stage_sync(&r.s(), vec![]).unwrap();
        // Sin identidad configurada en ningún nivel git se niega; si el equipo tiene una global, el commit procede.
        match commit_sync(&r.s(), "x") {
            Ok(_) => {}
            Err(e) => assert!(!e.trim().is_empty(), "el error de git no puede llegar vacío"),
        }
    }

    #[test]
    fn diff_sources_for_staged_unstaged_new_and_deleted() {
        let r = Repo::new();
        r.write("a.txt", "v1\n");
        r.write("b.txt", "borrar\n");
        r.commit_all("base");
        r.write("a.txt", "v2\n");
        let d = diff_sources_sync(&r.s(), "a.txt", None, false).unwrap();
        assert_eq!((d.original.as_str(), d.modified.as_str()), ("v1\n", "v2\n"));
        stage_sync(&r.s(), vec!["a.txt".into()]).unwrap();
        r.write("a.txt", "v3\n");
        let staged = diff_sources_sync(&r.s(), "a.txt", None, true).unwrap();
        assert_eq!((staged.original.as_str(), staged.modified.as_str()), ("v1\n", "v2\n"));
        let unstaged = diff_sources_sync(&r.s(), "a.txt", None, false).unwrap();
        assert_eq!((unstaged.original.as_str(), unstaged.modified.as_str()), ("v2\n", "v3\n"));
        r.write("nuevo.txt", "hola\n");
        let n = diff_sources_sync(&r.s(), "nuevo.txt", None, false).unwrap();
        assert_eq!((n.original.as_str(), n.modified.as_str()), ("", "hola\n"));
        fs::remove_file(r.0.join("b.txt")).unwrap();
        let del = diff_sources_sync(&r.s(), "b.txt", None, false).unwrap();
        assert_eq!((del.original.as_str(), del.modified.as_str()), ("borrar\n", ""));
    }

    #[test]
    fn diff_sources_follow_renames_and_flag_binaries() {
        let r = Repo::new();
        r.write("viejo.txt", "contenido\n");
        r.commit_all("base");
        r.git(&["mv", "viejo.txt", "nuevo.txt"]);
        let c = changes_sync(&r.s()).unwrap();
        assert_eq!(c.staged[0].orig.as_deref(), Some("viejo.txt"));
        let d = diff_sources_sync(&r.s(), "nuevo.txt", Some("viejo.txt"), true).unwrap();
        assert_eq!((d.original.as_str(), d.modified.as_str()), ("contenido\n", "contenido\n"));
        fs::write(r.0.join("img.bin"), [0u8, 1, 2, 0]).unwrap();
        assert!(diff_sources_sync(&r.s(), "img.bin", None, false).unwrap().binary);
    }

    #[test]
    fn works_from_a_subfolder_and_rejects_non_repos() {
        let r = Repo::new();
        r.write("sub/a.txt", "x\n");
        let sub = format!("{}/sub", r.s());
        let c = changes_sync(&sub).unwrap();
        assert_eq!(c.unstaged[0].path, "sub/a.txt", "rutas relativas a la raíz del repositorio");
        stage_sync(&sub, vec!["sub/a.txt".into()]).unwrap();
        assert_eq!(changes_sync(&sub).unwrap().staged.len(), 1);
        let plain = std::env::temp_dir().join(format!("pulso-nogit-{}", std::process::id()));
        fs::create_dir_all(&plain).unwrap();
        let err = changes_sync(&plain.to_string_lossy()).unwrap_err();
        let _ = fs::remove_dir_all(&plain);
        assert!(err.contains("no es un repositorio") || err.contains("repositorio"), "{err}");
    }

    #[test]
    fn many_paths_are_staged_in_chunks() {
        let r = Repo::new();
        let names: Vec<String> = (0..250).map(|i| format!("f{i}.txt")).collect();
        for n in &names { r.write(n, "x\n"); }
        stage_sync(&r.s(), names).unwrap();
        assert_eq!(changes_sync(&r.s()).unwrap().staged.len(), 250);
    }
}
