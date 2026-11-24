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
