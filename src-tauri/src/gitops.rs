//! Operaciones de Git de la interfaz: cambios preparados y sin preparar, stage, unstage, commit y las dos
//! versiones de un archivo para mostrar diferencias. Todo se hace con el ejecutable `git` del sistema.
use crate::i18n::{tr, trf};
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
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    c
}

fn text(o: &Output) -> String {
    let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
    if err.is_empty() { String::from_utf8_lossy(&o.stdout).trim().to_string() } else { err }
}

/// Ejecuta git y devuelve la salida estándar, o el mensaje de error de git tal cual.
fn run(dir: &str, args: &[&str]) -> Result<String, String> {
    let o = git_command(dir).args(args).output().map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err(text(&o)) }
}

fn succeeds(dir: &str, args: &[&str]) -> bool {
    git_command(dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// Distingue «git no está instalado» de «esta carpeta no es un repositorio»: piden cosas distintas a la persona.
fn explain_top_error(err: &str) -> String {
    if err.starts_with(tr("No se pudo ejecutar git")) {
        tr("No se encontró Git. Instálalo (git-scm.com) y reinicia Pulso para usar el control de código fuente").to_string()
    } else {
        tr("Esta carpeta no es un repositorio de Git").to_string()
    }
}

fn top_of(root: &str) -> Result<String, String> {
    let t = run(root, &["rev-parse", "--show-toplevel"]).map_err(|e| explain_top_error(&e))?;
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

fn last_commit_message_sync(root: &str) -> Result<String, String> {
    let top = top_of(root)?;
    if !succeeds(&top, &["rev-parse", "--verify", "HEAD"]) {
        return Err(tr("Todavía no hay ningún commit en este repositorio").into());
    }
    Ok(run(&top, &["log", "-1", "--pretty=%B"])?.trim().to_string())
}

fn amend_sync(root: &str, message: Option<&str>) -> Result<CommitResult, String> {
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

fn delete_branch_sync(root: &str, name: &str, force: bool) -> Result<(), String> {
    valid_branch_name(name)?;
    let top = top_of(root)?;
    run(&top, &["branch", if force { "-D" } else { "-d" }, name]).map(|_| ())
}

fn rename_branch_sync(root: &str, old_name: &str, new_name: &str) -> Result<(), String> {
    valid_branch_name(old_name)?;
    valid_branch_name(new_name)?;
    let top = top_of(root)?;
    if !succeeds(&top, &["check-ref-format", "--branch", new_name]) {
        return Err(trf("«{name}» no es un nombre de rama válido", &[("name", &new_name)]));
    }
    run(&top, &["branch", "-m", old_name, new_name]).map(|_| ())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DiffSources {
    pub original: String,
    pub modified: String,
    pub binary: bool,
}

const MAX_DIFF_BYTES: usize = 2_000_000;

/// Contenido de `spec` (por ejemplo `HEAD:ruta` o `:ruta`). Comprueba primero el tamaño con `cat-file -s`
/// para no cargar blobs enormes en RAM. Cadena vacía si no existe en esa versión.
fn blob(top: &str, spec: &str) -> Result<Vec<u8>, String> {
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

fn read_disk_for_diff(path: &std::path::Path) -> Result<Vec<u8>, String> {
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
fn diff_sources_sync(root: &str, path: &str, orig: Option<&str>, staged: bool) -> Result<DiffSources, String> {
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

// ---------- Ramas ----------
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    /// Rama que solo existe en un remoto (por ejemplo `origin/dev`).
    pub remote: bool,
    pub upstream: Option<String>,
}

fn branches_sync(root: &str) -> Result<Vec<Branch>, String> {
    let top = top_of(root)?;
    let out = run(&top, &["for-each-ref", "--format=%(refname)%09%(HEAD)%09%(upstream:short)", "refs/heads", "refs/remotes"])?;
    let mut local: Vec<Branch> = Vec::new();
    let mut remote: Vec<Branch> = Vec::new();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let (Some(name), Some(head), upstream) = (parts.next(), parts.next(), parts.next()) else { continue };
        let upstream = upstream.filter(|u| !u.is_empty()).map(|u| u.to_string());
        if let Some(n) = name.strip_prefix("refs/heads/") {
            local.push(Branch { name: n.to_string(), current: head.trim() == "*", remote: false, upstream });
        } else if let Some(n) = name.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") { continue; }
            remote.push(Branch { name: n.to_string(), current: false, remote: true, upstream: None });
        }
    }
    // Una rama remota que ya existe en local no se repite.
    remote.retain(|r| !local.iter().any(|l| r.name.split_once('/').map(|(_, short)| short == l.name).unwrap_or(false)));
    local.sort_by(|a, b| b.current.cmp(&a.current).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    remote.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    local.extend(remote);
    Ok(local)
}

fn valid_branch_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() { return Err(tr("Escribe un nombre para la rama").into()); }
    if name.starts_with('-') { return Err(tr("El nombre de la rama no puede empezar por «-»").into()); }
    Ok(())
}

/// Cambia a una rama existente (creando la local si solo existe en el remoto) o crea una nueva.
fn switch_sync(root: &str, name: &str, create: bool) -> Result<(), String> {
    valid_branch_name(name)?;
    let top = top_of(root)?;
    if create {
        if !succeeds(&top, &["check-ref-format", "--branch", name]) {
            return Err(trf("«{name}» no es un nombre de rama válido", &[("name", &name)]));
        }
        return run(&top, &["switch", "-c", name]).map(|_| ());
    }
    let is_local = succeeds(&top, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]);
    if !is_local && succeeds(&top, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/{name}")]) {
        let short = name.split_once('/').map(|(_, s)| s).unwrap_or(name);
        valid_branch_name(short)?;
        if !succeeds(&top, &["check-ref-format", "--branch", short]) {
            return Err(trf("«{short}» no es un nombre de rama válido", &[("short", &short)]));
        }
        return run(&top, &["switch", "-c", short, "--track", name]).map(|_| ());
    }
    run(&top, &["switch", name]).map(|_| ())
}

// ---------- Descartar cambios ----------
#[derive(serde::Deserialize, Debug, Clone)]
pub struct DiscardItem {
    pub path: String,
    pub status: String,
}

/// La ruta debe quedarse dentro del repositorio: nada de `..`, rutas absolutas ni unidades de Windows.
fn safe_relative(path: &str) -> bool {
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
fn discard_sync(root: &str, items: Vec<DiscardItem>, remove_untracked: &dyn Fn(&std::path::Path) -> Result<(), String>) -> Result<usize, String> {
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

// ---------- Sincronización con el remoto ----------
const NET_TIMEOUT_SECS: u64 = 120;

/// Ejecuta un comando con límite de tiempo: si queda esperando (por ejemplo, un inicio de sesión), se detiene.
fn run_timeout(mut cmd: Command, secs: u64) -> Result<Output, String> {
    use std::{io::Read, thread, time::{Duration, Instant}};
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::procguard::configure_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    crate::procguard::attach_job(&child);
    let pid = child.id();
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let mut err = child.stderr.take().ok_or(tr("sin salida de error"))?;
    let t_out = thread::spawn(move || { let mut b = Vec::new(); let _ = out.read_to_end(&mut b); b });
    let t_err = thread::spawn(move || { let mut b = Vec::new(); let _ = err.read_to_end(&mut b); b });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if Instant::now() >= deadline => {
                crate::procguard::kill_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                let _ = t_out.join();
                let _ = t_err.join();
                return Err(trf("La operación tardó más de {secs} s y se canceló. Si Git esperaba un inicio de sesión, inicia sesión desde una terminal y reinténtalo", &[("secs", &secs)]));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    Ok(Output { status, stdout: t_out.join().unwrap_or_default(), stderr: t_err.join().unwrap_or_default() })
}

fn run_net(top: &str, args: &[&str], secs: u64) -> Result<String, String> {
    let mut c = git_command(top);
    c.args(args);
    let o = run_timeout(c, secs)?;
    if o.status.success() { Ok(text(&o)) } else { Err(text(&o)) }
}

fn current_branch(top: &str) -> Result<String, String> {
    let b = run(top, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if b == "HEAD" { return Err(tr("Estás en HEAD desacoplado: cambia a una rama antes de sincronizar").into()); }
    Ok(b)
}

fn push_sync(root: &str, secs: u64) -> Result<String, String> {
    let top = top_of(root)?;
    let branch = current_branch(&top)?;
    if succeeds(&top, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) {
        return run_net(&top, &["push"], secs);
    }
    if succeeds(&top, &["remote", "get-url", "origin"]) {
        return run_net(&top, &["push", "--set-upstream", "origin", &branch], secs);
    }
    Err(tr("Esta rama no tiene remoto. Añade uno con «git remote add origin <url>» en la terminal").into())
}

fn pull_sync(root: &str, secs: u64) -> Result<String, String> {
    let top = top_of(root)?;
    current_branch(&top)?;
    match run_net(&top, &["pull", "--ff-only"], secs) {
        Ok(t) => Ok(t),
        Err(e) if e.contains("Not possible to fast-forward") || e.contains("divergent") => Err(trf(
            "{e}\n\nTu rama y la remota tienen cambios distintos. Pulso solo trae cambios que se pueden aplicar sin mezclar; resuélvelo en la terminal (git pull --rebase o git merge).",
            &[("e", &e)],
        )),
        Err(e) if e.contains("no tracking information") => {
            Err(tr("Esta rama no sigue a ninguna rama remota. Haz push primero para crearla en el remoto").into())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn git_branches(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String) -> Result<Vec<Branch>, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || branches_sync(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_switch(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, name: String, create: bool) -> Result<(), String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || switch_sync(&root, &name, create)).await.map_err(|e| e.to_string())?
}

/// Descarta cambios sin preparar. Los archivos sin seguimiento van a la papelera de reciclaje.
#[tauri::command]
pub async fn git_discard(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, items: Vec<DiscardItem>) -> Result<usize, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || {
        discard_sync(&root, items, &|p| trash::delete(p).map_err(|e| trf("No se pudo enviar a la papelera {path}: {e}", &[("path", &p.display()), ("e", &e)])))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String) -> Result<String, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || push_sync(&root, NET_TIMEOUT_SECS)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String) -> Result<String, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || pull_sync(&root, NET_TIMEOUT_SECS)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_changes(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String) -> Result<Changes, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || changes_sync(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, paths: Vec<String>) -> Result<(), String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || stage_sync(&root, paths)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, paths: Vec<String>) -> Result<(), String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || unstage_sync(&root, paths)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, message: String) -> Result<CommitResult, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || commit_sync(&root, &message)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_last_commit_message(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String) -> Result<String, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || last_commit_message_sync(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit_amend(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, message: Option<String>) -> Result<CommitResult, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || amend_sync(&root, message.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_delete_branch(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, name: String, force: bool) -> Result<(), String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || delete_branch_sync(&root, &name, force)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rename_branch(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, old_name: String, new_name: String) -> Result<(), String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || rename_branch_sync(&root, &old_name, &new_name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_sources(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, path: String, orig: Option<String>, staged: bool) -> Result<DiffSources, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || diff_sources_sync(&root, &path, orig.as_deref(), staged)).await.map_err(|e| e.to_string())?
}

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

const REC: char = '\u{1e}';
const FLD: char = '\u{1f}';

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

fn valid_hash(h: &str) -> bool {
    (7..=64).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit())
}

const MAX_LOG: u32 = 200;

/// Historial de commits de HEAD (o de un archivo, siguiendo sus renombrados), de `limit` en `limit`.
fn log_sync(root: &str, path: Option<&str>, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
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

fn commit_files_sync(root: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    if !valid_hash(hash) { return Err(tr("Identificador de commit no válido").into()); }
    let top = top_of(root)?;
    Ok(parse_name_status(&run(&top, &["show", "--name-status", "-M", "-z", "--format=", hash])?))
}

/// Las dos versiones de un archivo en un commit: la del padre y la del propio commit.
fn commit_sources_sync(root: &str, hash: &str, path: &str, orig: Option<&str>) -> Result<DiffSources, String> {
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

fn blame_sync(root: &str, path: &str) -> Result<Vec<BlameLine>, String> {
    if !safe_relative(path) { return Err(tr("Ruta no válida").into()); }
    let top = top_of(root)?;
    if !has_head(&top) { return Ok(Vec::new()); }
    Ok(parse_blame(&run(&top, &["blame", "--line-porcelain", "--", path])?))
}

#[tauri::command]
pub async fn git_log(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, path: Option<String>, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || log_sync(&root, path.as_deref(), skip, limit)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit_files(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, hash: String) -> Result<Vec<CommitFile>, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || commit_files_sync(&root, &hash)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit_sources(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, hash: String, path: String, orig: Option<String>) -> Result<DiffSources, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || commit_sources_sync(&root, &hash, &path, orig.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_blame(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, path: String) -> Result<Vec<BlameLine>, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || blame_sync(&root, &path)).await.map_err(|e| e.to_string())?
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
            // Los saltos de línea no deben cambiar según la configuración global de cada equipo.
            r.git(&["config", "core.autocrlf", "false"]);
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
    fn missing_git_is_not_reported_as_a_missing_repository() {
        assert!(explain_top_error("No se pudo ejecutar git: program not found").contains("No se encontró Git"));
        assert!(explain_top_error("fatal: not a git repository").contains("no es un repositorio"));
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

    // ---------- Ramas, descartar y sincronización (con remoto local, sin red) ----------
    fn with_remote() -> (Repo, Repo) {
        let remote = Repo::new();
        remote.git(&["config", "receive.denyCurrentBranch", "ignore"]);
        let bare = std::env::temp_dir().join(format!("pulso-bare-{}-{}", std::process::id(), remote.0.file_name().unwrap().to_string_lossy()));
        let _ = fs::remove_dir_all(&bare);
        run(&remote.s(), &["init", "-q", "--bare", &bare.to_string_lossy()]).unwrap();
        let local = Repo::new();
        local.write("a.txt", "uno\n");
        local.commit_all("base");
        local.git(&["remote", "add", "origin", &bare.to_string_lossy()]);
        drop(remote);
        (local, Repo(bare))
    }

    #[test]
    fn branches_list_current_first_and_hide_duplicated_remotes() {
        let (local, _bare) = with_remote();
        push_sync(&local.s(), 30).unwrap();
        local.git(&["switch", "-c", "zeta"]);
        local.git(&["switch", "-c", "alfa"]);
        let b = branches_sync(&local.s()).unwrap();
        assert!(b[0].current && b[0].name == "alfa", "{b:?}");
        let names: Vec<&str> = b.iter().map(|x| x.name.as_str()).collect();
        assert!(names.contains(&"zeta") && names.contains(&"master") || names.contains(&"main"));
        assert!(b.iter().all(|x| !x.name.ends_with("/HEAD")));
        assert!(!b.iter().any(|x| x.remote), "las ramas remotas que ya existen en local no se repiten: {b:?}");
    }

    #[test]
    fn create_and_switch_branches_with_validation() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        r.commit_all("base");
        switch_sync(&r.s(), "nueva", true).unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "nueva");
        assert!(switch_sync(&r.s(), "nueva", true).is_err(), "no se puede crear una rama que ya existe");
        assert!(switch_sync(&r.s(), "mala..rama", true).unwrap_err().contains("no es un nombre"));
        assert!(switch_sync(&r.s(), "-f", false).unwrap_err().contains("empezar por"));
        assert!(switch_sync(&r.s(), "  ", true).is_err());
        let first = branches_sync(&r.s()).unwrap().into_iter().find(|b| !b.current).unwrap().name;
        switch_sync(&r.s(), &first, false).unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(), first);
        assert!(switch_sync(&r.s(), "no-existe", false).is_err());
    }

    #[test]
    fn switching_with_conflicting_changes_is_refused_and_keeps_the_work() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        r.commit_all("base");
        switch_sync(&r.s(), "otra", true).unwrap();
        r.write("a.txt", "en otra\n");
        r.commit_all("cambio en otra");
        let main = r.git(&["rev-parse", "--abbrev-ref", "@{-1}"]).trim().to_string();
        switch_sync(&r.s(), &main, false).unwrap();
        r.write("a.txt", "trabajo sin guardar en commit\n");
        let err = switch_sync(&r.s(), "otra", false).unwrap_err();
        assert!(!err.trim().is_empty());
        assert_eq!(fs::read_to_string(r.0.join("a.txt")).unwrap(), "trabajo sin guardar en commit\n", "no se pierde el trabajo");
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(), main);
    }

    #[test]
    fn switching_to_a_remote_only_branch_creates_a_tracking_branch() {
        let (local, bare) = with_remote();
        local.git(&["switch", "-c", "remota"]);
        local.write("b.txt", "x\n");
        local.commit_all("en remota");
        push_sync(&local.s(), 30).unwrap();
        local.git(&["switch", "-"]);
        local.git(&["branch", "-D", "remota"]);
        local.git(&["fetch", "-q", "origin"]);
        let b = branches_sync(&local.s()).unwrap();
        assert!(b.iter().any(|x| x.remote && x.name == "origin/remota"), "{b:?}");
        switch_sync(&local.s(), "origin/remota", false).unwrap();
        assert_eq!(local.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "remota");
        assert_eq!(local.git(&["rev-parse", "--abbrev-ref", "@{u}"]).trim(), "origin/remota");
        drop(bare);
    }

    #[test]
    fn discard_restores_tracked_files_and_removes_untracked_through_the_given_function() {
        let r = Repo::new();
        r.write("a.txt", "v1\n");
        r.write("b.txt", "b\n");
        r.commit_all("base");
        r.write("a.txt", "v2\n");
        fs::remove_file(r.0.join("b.txt")).unwrap();
        r.write("nuevo.txt", "n\n");
        let removed = std::cell::RefCell::new(Vec::new());
        let items = vec![
            DiscardItem { path: "a.txt".into(), status: "M".into() },
            DiscardItem { path: "b.txt".into(), status: "D".into() },
            DiscardItem { path: "nuevo.txt".into(), status: "U".into() },
        ];
        let n = discard_sync(&r.s(), items, &|p| { removed.borrow_mut().push(p.to_path_buf()); fs::remove_file(p).map_err(|e| e.to_string()) }).unwrap();
        assert_eq!(n, 3);
        assert_eq!(fs::read_to_string(r.0.join("a.txt")).unwrap(), "v1\n");
        assert_eq!(fs::read_to_string(r.0.join("b.txt")).unwrap(), "b\n");
        assert!(!r.0.join("nuevo.txt").exists());
        assert_eq!(removed.borrow().len(), 1, "solo los archivos sin seguimiento pasan por la función de retirada");
        assert!(changes_sync(&r.s()).unwrap().unstaged.is_empty());
    }

    #[test]
    fn discard_does_not_touch_staged_changes_and_rejects_paths_outside_the_repo() {
        let r = Repo::new();
        r.write("a.txt", "v1\n");
        r.commit_all("base");
        r.write("a.txt", "preparado\n");
        stage_sync(&r.s(), vec![]).unwrap();
        r.write("a.txt", "sin preparar\n");
        discard_sync(&r.s(), vec![DiscardItem { path: "a.txt".into(), status: "M".into() }], &|_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(r.0.join("a.txt")).unwrap(), "preparado\n", "vuelve a lo preparado, no a HEAD");
        assert_eq!(changes_sync(&r.s()).unwrap().staged.len(), 1);
        for bad in ["../fuera.txt", "/etc/passwd", "C:/Windows/x", "sub/../../x", ""] {
            let err = discard_sync(&r.s(), vec![DiscardItem { path: bad.into(), status: "U".into() }], &|_| panic!("no debe borrar nada")).unwrap_err();
            assert!(err.contains("Ruta no válida"), "{bad}: {err}");
            assert!(diff_sources_sync(&r.s(), bad, None, false).is_err(), "diff_sources debe rechazar {bad}");
            assert!(diff_sources_sync(&r.s(), "a.txt", Some(bad), true).is_err(), "diff_sources orig debe rechazar {bad}");
        }
    }

    #[test]
    fn parse_changes_ignores_malformed_utf8_records_without_panic() {
        let c = parse_changes("ñ\0M  ok.txt\0");
        assert_eq!(c.staged.len(), 1);
        assert_eq!(c.staged[0].path, "ok.txt");
    }

    #[test]
    fn push_sets_upstream_then_pull_fast_forwards_another_clone() {
        let (a, bare) = with_remote();
        let bare_s = bare.s();
        push_sync(&a.s(), 30).unwrap();
        assert!(a.git(&["rev-parse", "--abbrev-ref", "@{u}"]).trim().starts_with("origin/"));
        let b = Repo::new();
        fs::remove_dir_all(&b.0).unwrap();
        run(&std::env::temp_dir().to_string_lossy(), &["clone", "-q", "-c", "core.autocrlf=false", &bare_s, &b.s()]).unwrap();
        b.git(&["config", "user.email", "t@e.c"]);
        b.git(&["config", "user.name", "T"]);
        assert_eq!(fs::read_to_string(b.0.join("a.txt")).unwrap(), "uno\n");
        a.write("nuevo.txt", "desde a\n");
        a.commit_all("segundo");
        let st = changes_sync(&a.s()).unwrap();
        assert_eq!((st.ahead, st.behind), (1, 0));
        push_sync(&a.s(), 30).unwrap();
        assert_eq!(changes_sync(&a.s()).unwrap().ahead, 0);
        pull_sync(&b.s(), 30).unwrap();
        assert_eq!(fs::read_to_string(b.0.join("nuevo.txt")).unwrap(), "desde a\n");
    }

    #[test]
    fn pull_refuses_divergent_history_with_a_helpful_message() {
        let (a, bare) = with_remote();
        let bare_s = bare.s();
        push_sync(&a.s(), 30).unwrap();
        let b = Repo::new();
        fs::remove_dir_all(&b.0).unwrap();
        run(&std::env::temp_dir().to_string_lossy(), &["clone", "-q", "-c", "core.autocrlf=false", &bare_s, &b.s()]).unwrap();
        b.git(&["config", "user.email", "t@e.c"]);
        b.git(&["config", "user.name", "T"]);
        a.write("x.txt", "a\n");
        a.commit_all("de a");
        push_sync(&a.s(), 30).unwrap();
        b.write("y.txt", "b\n");
        b.commit_all("de b");
        let err = pull_sync(&b.s(), 30).unwrap_err();
        assert!(err.contains("resuélvelo en la terminal"), "{err}");
        assert!(!b.0.join("x.txt").exists(), "no se mezcló nada");
    }

    #[test]
    fn push_and_pull_report_missing_remote_and_detached_head() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        r.commit_all("base");
        assert!(push_sync(&r.s(), 10).unwrap_err().contains("no tiene remoto"));
        assert!(pull_sync(&r.s(), 10).is_err());
        r.git(&["checkout", "-q", "--detach"]);
        assert!(push_sync(&r.s(), 10).unwrap_err().contains("HEAD desacoplado"));
    }

    #[test]
    fn network_operations_are_cancelled_when_they_hang() {
        let mut cmd = if cfg!(windows) {
            let mut c = background_command("ping");
            c.args(["-n", "20", "127.0.0.1"]);
            c
        } else {
            let mut c = background_command("sleep");
            c.arg("20");
            c
        };
        cmd.stdin(Stdio::null());
        let started = std::time::Instant::now();
        let err = run_timeout(cmd, 1).unwrap_err();
        assert!(err.contains("se canceló"), "{err}");
        assert!(started.elapsed().as_secs() < 8, "debe cortarse cerca del límite, no esperar a que termine");
    }

    #[test]
    fn many_paths_are_staged_in_chunks() {
        let r = Repo::new();
        let names: Vec<String> = (0..250).map(|i| format!("f{i}.txt")).collect();
        for n in &names { r.write(n, "x\n"); }
        stage_sync(&r.s(), names).unwrap();
        assert_eq!(changes_sync(&r.s()).unwrap().staged.len(), 250);
    }
    fn history_repo() -> Repo {
        let r = Repo::new();
        r.write("a.txt", "uno\ndos\n");
        r.commit_all("primero");
        r.write("a.txt", "uno\ndos\ntres\n");
        r.write("b.txt", "bee\n");
        r.commit_all("segundo: añade tres");
        r.git(&["mv", "a.txt", "renombrado.txt"]);
        r.commit_all("tercero: renombra");
        r
    }

    #[test]
    fn log_lists_commits_newest_first_with_author_and_refs() {
        let r = history_repo();
        let l = log_sync(&r.s(), None, 0, 10).unwrap();
        assert_eq!(l.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["tercero: renombra", "segundo: añade tres", "primero"]);
        assert_eq!(l[0].author, "Prueba");
        assert_eq!(l[0].short.len(), 7.max(l[0].short.len()));
        assert!(l[0].hash.len() == 40 && l[0].date.contains('T'));
        assert!(l[0].refs.iter().any(|x| x.starts_with("HEAD")), "{:?}", l[0].refs);
    }

    #[test]
    fn log_pages_with_skip_and_limit_and_handles_an_empty_repo() {
        let r = history_repo();
        let page = log_sync(&r.s(), None, 1, 1).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].subject, "segundo: añade tres");
        let empty = Repo::new();
        assert!(log_sync(&empty.s(), None, 0, 10).unwrap().is_empty());
    }

    #[test]
    fn file_history_follows_renames() {
        let r = history_repo();
        let l = log_sync(&r.s(), Some("renombrado.txt"), 0, 10).unwrap();
        assert_eq!(l.len(), 3, "{:?}", l.iter().map(|c| &c.subject).collect::<Vec<_>>());
        let only_b = log_sync(&r.s(), Some("b.txt"), 0, 10).unwrap();
        assert_eq!(only_b.len(), 1);
    }

    #[test]
    fn log_rejects_paths_that_escape_the_repository() {
        let r = history_repo();
        assert!(log_sync(&r.s(), Some("../fuera.txt"), 0, 10).is_err());
    }

    #[test]
    fn commit_files_report_status_and_renames() {
        let r = history_repo();
        let l = log_sync(&r.s(), None, 0, 10).unwrap();
        let rename = commit_files_sync(&r.s(), &l[0].hash).unwrap();
        assert_eq!(rename, vec![CommitFile { status: "R".into(), path: "renombrado.txt".into(), orig: Some("a.txt".into()) }]);
        let second = commit_files_sync(&r.s(), &l[1].hash).unwrap();
        assert_eq!(second.iter().map(|f| format!("{}{}", f.status, f.path)).collect::<Vec<_>>(), ["Ma.txt", "Ab.txt"]);
        assert!(commit_files_sync(&r.s(), "no-es-un-hash; rm -rf").is_err());
    }

    #[test]
    fn commit_sources_give_parent_and_commit_versions() {
        let r = history_repo();
        let l = log_sync(&r.s(), None, 0, 10).unwrap();
        let s = commit_sources_sync(&r.s(), &l[1].hash, "a.txt", None).unwrap();
        assert_eq!((s.original.as_str(), s.modified.as_str()), ("uno\ndos\n", "uno\ndos\ntres\n"));
        let added = commit_sources_sync(&r.s(), &l[1].hash, "b.txt", None).unwrap();
        assert_eq!((added.original.as_str(), added.modified.as_str()), ("", "bee\n"));
        let renamed = commit_sources_sync(&r.s(), &l[0].hash, "renombrado.txt", Some("a.txt")).unwrap();
        assert_eq!(renamed.original, renamed.modified);
        let first = commit_sources_sync(&r.s(), &l[2].hash, "a.txt", None).unwrap();
        assert_eq!(first.original, "", "el primer commit no tiene padre");
    }

    #[test]
    fn blame_attributes_each_line_and_marks_uncommitted_ones() {
        let r = history_repo();
        r.write("renombrado.txt", "uno\ndos\ntres\ncuatro sin commit\n");
        let b = blame_sync(&r.s(), "renombrado.txt").unwrap();
        assert_eq!(b.len(), 4);
        assert_eq!(b[0].summary, "primero");
        assert_eq!(b[2].summary, "segundo: añade tres");
        assert_eq!(b[0].author, "Prueba");
        assert!(b[0].hash.len() == 40 && b[0].time > 1_600_000_000);
        assert_eq!(b[3].hash, "", "la línea sin commit no tiene hash");
        assert_eq!(b.iter().map(|x| x.line).collect::<Vec<_>>(), [1, 2, 3, 4]);
    }

    #[test]
    fn parsers_tolerate_garbage() {
        assert!(parse_log("").is_empty());
        assert!(parse_log("\u{1e}solo-un-campo").is_empty());
        assert!(parse_name_status("").is_empty());
        assert!(parse_blame("basura\nsin formato").is_empty());
    }

    #[test]
    fn amend_rename_and_delete_branch_work() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        stage_sync(&r.s(), vec!["a.txt".into()]).unwrap();
        commit_sync(&r.s(), "mensaje inicial").unwrap();
        assert_eq!(last_commit_message_sync(&r.s()).unwrap(), "mensaje inicial");

        let amended = amend_sync(&r.s(), Some("mensaje corregido")).unwrap();
        assert_eq!(amended.summary, "mensaje corregido");
        assert_eq!(last_commit_message_sync(&r.s()).unwrap(), "mensaje corregido");

        switch_sync(&r.s(), "rama-temp", true).unwrap();
        rename_branch_sync(&r.s(), "rama-temp", "rama-renombrada").unwrap();
        let names: Vec<String> = branches_sync(&r.s()).unwrap().into_iter().map(|b| b.name).collect();
        assert!(names.contains(&"rama-renombrada".to_string()));
        assert!(!names.contains(&"rama-temp".to_string()));

        let main_branch = names.iter().find(|n| n.as_str() != "rama-renombrada").cloned().unwrap();
        switch_sync(&r.s(), &main_branch, false).unwrap();
        delete_branch_sync(&r.s(), "rama-renombrada", false).unwrap();
        let after: Vec<String> = branches_sync(&r.s()).unwrap().into_iter().map(|b| b.name).collect();
        assert!(!after.contains(&"rama-renombrada".to_string()));
    }
}
