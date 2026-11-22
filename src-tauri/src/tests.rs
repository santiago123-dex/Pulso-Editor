use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Directorio temporal único para cada prueba; se borra al terminar.
struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pulso-test-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn p(&self, name: &str) -> String {
        norm(&self.0.join(name))
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect()
}

// ---------- Guardado seguro ----------
#[test]
fn write_creates_file_and_reports_mtime() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    let m = write_file_sync(p.clone(), "hola".into(), None).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "hola");
    assert_eq!(m, file_mtime_sync(p).unwrap());
    assert!(leftovers(&t.0).is_empty(), "no debe quedar archivo temporal");
}

#[test]
fn write_overwrites_when_mtime_matches() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    let m = write_file_sync(p.clone(), "uno".into(), None).unwrap();
    write_file_sync(p.clone(), "dos".into(), Some(m)).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "dos");
}

#[test]
fn write_detects_external_change() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    let m = write_file_sync(p.clone(), "uno".into(), None).unwrap();
    // Otro programa modifica el archivo: su fecha ya no coincide con la que conoce el editor.
    fs::write(&p, "externo").unwrap();
    let f = fs::OpenOptions::new().write(true).open(&p).unwrap();
    f.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(m + 5_000)).unwrap();
    drop(f);
    let err = write_file_sync(p.clone(), "mio".into(), Some(m)).unwrap_err();
    assert_eq!(err, "CONFLICT");
    assert_eq!(fs::read_to_string(&p).unwrap(), "externo", "un conflicto no debe tocar el archivo");
    // Forzar (sin fecha esperada) sí sobrescribe.
    write_file_sync(p.clone(), "mio".into(), None).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "mio");
}

#[test]
fn write_recreates_file_deleted_externally() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    let m = write_file_sync(p.clone(), "uno".into(), None).unwrap();
    fs::remove_file(&p).unwrap();
    write_file_sync(p.clone(), "dos".into(), Some(m)).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "dos");
}

#[test]
fn write_keeps_utf8_and_crlf_exactly() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    let text = "línea 1\r\nñandú 😀\r\n";
    write_file_sync(p.clone(), text.into(), None).unwrap();
    assert_eq!(fs::read(&p).unwrap(), text.as_bytes());
}

#[test]
fn write_fails_cleanly_into_missing_directory() {
    let t = Tmp::new();
    let p = t.p("no-existe/a.txt");
    assert!(write_file_sync(p, "x".into(), None).is_err());
    assert!(leftovers(&t.0).is_empty());
}

// ---------- Copias de recuperación ----------
#[test]
fn backups_roundtrip_and_remove() {
    let t = Tmp::new();
    let dir = t.0.join("recovery");
    backup_write_in(&dir, "C:/proyecto/a.ts", "contenido a", 11).unwrap();
    backup_write_in(&dir, "C:/proyecto/b.ts", "contenido b", 22).unwrap();
    backup_write_in(&dir, "C:/proyecto/a.ts", "contenido a v2", 11).unwrap();
    let list = backup_list_in(&dir);
    assert_eq!(list.len(), 2, "una copia por archivo");
    let a = list.iter().find(|b| b.path == "C:/proyecto/a.ts").unwrap();
    assert_eq!(a.contents, "contenido a v2");
    assert_eq!(a.base_mtime, 11);
    backup_remove_in(&dir, "C:/proyecto/a.ts").unwrap();
    let list = backup_list_in(&dir);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "C:/proyecto/b.ts");
}

#[test]
fn backup_list_ignores_foreign_and_corrupt_files() {
    let t = Tmp::new();
    let dir = t.0.join("recovery");
    backup_write_in(&dir, "C:/x.ts", "ok", 1).unwrap();
    fs::write(dir.join("basura.json"), "{no es json").unwrap();
    fs::write(dir.join("notas.txt"), "hola").unwrap();
    let list = backup_list_in(&dir);
    assert_eq!(list.len(), 1);
}

#[test]
fn backup_list_of_missing_dir_is_empty() {
    let t = Tmp::new();
    assert!(backup_list_in(&t.0.join("nada")).is_empty());
}

// ---------- Archivos y carpetas ----------
#[test]
fn create_file_makes_parent_dirs_and_refuses_duplicates() {
    let t = Tmp::new();
    let p = t.p("a/b/c.txt");
    create_file_sync(Path::new(&p)).unwrap();
    assert!(Path::new(&p).is_file());
    assert!(create_file_sync(Path::new(&p)).is_err());
}

#[test]
fn create_dir_refuses_existing() {
    let t = Tmp::new();
    let p = t.p("carpeta");
    create_dir_sync(Path::new(&p)).unwrap();
    assert!(create_dir_sync(Path::new(&p)).is_err());
}

#[test]
fn rename_moves_and_refuses_overwrite() {
    let t = Tmp::new();
    fs::write(t.0.join("a.txt"), "a").unwrap();
    fs::write(t.0.join("b.txt"), "b").unwrap();
    assert!(rename_path_sync(Path::new(&t.p("a.txt")), Path::new(&t.p("b.txt"))).is_err(), "no debe pisar un archivo existente");
    assert_eq!(fs::read_to_string(t.0.join("b.txt")).unwrap(), "b");
    rename_path_sync(Path::new(&t.p("a.txt")), Path::new(&t.p("c.txt"))).unwrap();
    assert!(!t.0.join("a.txt").exists());
    assert_eq!(fs::read_to_string(t.0.join("c.txt")).unwrap(), "a");
}

#[test]
fn rename_refuses_moving_folder_into_itself() {
    let t = Tmp::new();
    fs::create_dir_all(t.0.join("d/sub")).unwrap();
    assert!(rename_path_sync(Path::new(&t.p("d")), Path::new(&t.p("d/sub/d"))).is_err());
    assert!(t.0.join("d/sub").exists());
}

#[test]
fn list_dir_sorts_folders_first_and_hides_noise() {
    let t = Tmp::new();
    fs::create_dir_all(t.0.join("zeta")).unwrap();
    fs::create_dir_all(t.0.join("node_modules")).unwrap();
    fs::create_dir_all(t.0.join(".git")).unwrap();
    fs::write(t.0.join("Beta.txt"), "").unwrap();
    fs::write(t.0.join("alfa.txt"), "").unwrap();
    let names: Vec<String> = list_dir_sync(norm(&t.0)).unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["zeta", "alfa.txt", "Beta.txt"]);
}

// ---------- Reemplazo ----------
#[test]
fn replace_literal_counts_and_writes() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "hola hola mundo").unwrap();
    let n = replace_in_file_sync(p.clone(), "hola".into(), "adiós".into(), true, false, false, None).unwrap();
    assert_eq!(n, 2);
    assert_eq!(fs::read_to_string(&p).unwrap(), "adiós adiós mundo");
}

#[test]
fn replace_literal_does_not_expand_dollar_signs() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "precio").unwrap();
    replace_in_file_sync(p.clone(), "precio".into(), "$1 y $&".into(), true, false, false, None).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "$1 y $&");
}

#[test]
fn replace_regex_uses_capture_groups() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "v1 v22").unwrap();
    replace_in_file_sync(p.clone(), r"v(\d+)".into(), "ver-$1".into(), true, true, false, None).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "ver-1 ver-22");
}

#[test]
fn replace_whole_word_and_case() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "gato Gato gatos").unwrap();
    let n = replace_in_file_sync(p.clone(), "gato".into(), "perro".into(), false, false, true, None).unwrap();
    assert_eq!(n, 2, "ignora mayúsculas y respeta palabra completa");
    assert_eq!(fs::read_to_string(&p).unwrap(), "perro perro gatos");
}

#[test]
fn replace_without_matches_leaves_file_untouched() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "nada").unwrap();
    let before = file_mtime_sync(p.clone()).unwrap();
    assert_eq!(replace_in_file_sync(p.clone(), "zzz".into(), "x".into(), true, false, false, None).unwrap(), 0);
    assert_eq!(file_mtime_sync(p).unwrap(), before);
}

#[test]
fn replace_rejects_invalid_regex_and_empty_query() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "x").unwrap();
    assert!(replace_in_file_sync(p.clone(), "(".into(), "".into(), true, true, false, None).is_err());
    assert!(replace_in_file_sync(p, "".into(), "".into(), true, false, false, None).is_err());
}

// ---------- Búsqueda ----------
#[test]
fn search_finds_matches_with_utf16_columns() {
    let t = Tmp::new();
    fs::write(t.0.join("a.txt"), "😀 hola\nnada\nhola otra vez hola").unwrap();
    let r = search_files_sync(norm(&t.0), "hola".into(), true, false, false, vec![], &Default::default()).unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!((r[0].line, r[0].col, r[0].len), (1, 4, 4), "el emoji ocupa 2 unidades UTF-16");
    assert_eq!((r[1].line, r[1].col), (3, 1));
    assert_eq!((r[2].line, r[2].col), (3, 15), "\"hola otra vez \" son 14 caracteres");
}

#[test]
fn search_skips_binary_and_ignored_dirs_and_honors_include() {
    let t = Tmp::new();
    fs::write(t.0.join("a.ts"), "needle").unwrap();
    fs::write(t.0.join("b.md"), "needle").unwrap();
    fs::write(t.0.join("bin.dat"), b"needle\0\0\0").unwrap();
    fs::create_dir_all(t.0.join("node_modules")).unwrap();
    fs::write(t.0.join("node_modules/x.ts"), "needle").unwrap();
    let all = search_files_sync(norm(&t.0), "needle".into(), true, false, false, vec![], &Default::default()).unwrap();
    let names: Vec<String> = all.iter().map(|m| m.path.rsplit('/').next().unwrap().to_string()).collect();
    assert_eq!(all.len(), 2, "solo a.ts y b.md: {:?}", names);
    let only_ts = search_files_sync(norm(&t.0), "needle".into(), true, false, false, vec!["*.ts".into()], &Default::default()).unwrap();
    assert_eq!(only_ts.len(), 1);
    assert!(only_ts[0].path.ends_with("a.ts"));
}

#[test]
fn search_supports_regex_whole_word_and_case() {
    let t = Tmp::new();
    fs::write(t.0.join("a.txt"), "Foo foo foobar").unwrap();
    assert_eq!(search_files_sync(norm(&t.0), "foo".into(), true, false, false, vec![], &Default::default()).unwrap().len(), 2);
    assert_eq!(search_files_sync(norm(&t.0), "foo".into(), false, false, true, vec![], &Default::default()).unwrap().len(), 2);
    assert_eq!(search_files_sync(norm(&t.0), r"fo+\b".into(), true, true, false, vec![], &Default::default()).unwrap().len(), 1);
    assert!(search_files_sync(norm(&t.0), "[".into(), true, true, false, vec![], &Default::default()).is_err());
}

#[test]
fn list_files_skips_ignored_dirs() {
    let t = Tmp::new();
    fs::create_dir_all(t.0.join("src")).unwrap();
    fs::create_dir_all(t.0.join("target")).unwrap();
    fs::write(t.0.join("src/a.rs"), "").unwrap();
    fs::write(t.0.join("target/b.rs"), "").unwrap();
    let files = list_files_sync(norm(&t.0)).unwrap();
    assert_eq!(files.len(), 1);
    assert!(files[0].ends_with("src/a.rs"));
}

// ---------- Git ----------
#[test]
fn git_parser_reads_branch_and_status_letters() {
    let text = "## main...origin/main [ahead 2, behind 1]\0 M src/a.ts\0?? nuevo.txt\0A  b.ts\0 D gone.ts\0!! dist/\0UU conflicto.ts\0";
    let g = parse_git_status(text, "C:/repo");
    assert_eq!((g.branch.as_str(), g.ahead, g.behind, g.dirty), ("main", 2, 1, true));
    let by = |p: &str| g.files.iter().find(|f| f.path == format!("C:/repo/{}", p)).unwrap();
    assert_eq!(by("src/a.ts").status, "M");
    assert_eq!(by("nuevo.txt").status, "U");
    assert_eq!(by("b.ts").status, "A");
    assert_eq!(by("gone.ts").status, "D");
    assert_eq!(by("conflicto.ts").status, "!");
    let dist = by("dist");
    assert_eq!(dist.status, "I");
    assert!(dist.dir);
}

#[test]
fn git_parser_handles_renames_and_clean_repo() {
    let g = parse_git_status("## dev\0R  nuevo.ts\0viejo.ts\0 M otro.ts\0", "/r");
    assert_eq!(g.files.len(), 2, "el nombre viejo de un renombrado no es otro archivo");
    assert_eq!(g.files[0].status, "R");
    let clean = parse_git_status("## main...origin/main\0", "/r");
    assert!(!clean.dirty);
    assert!(clean.files.is_empty());
}

#[test]
fn git_parser_ignored_only_is_not_dirty_and_new_repo_branch() {
    let g = parse_git_status("## No commits yet on trunk\0!! target/\0", "/r");
    assert_eq!(g.branch, "trunk");
    assert!(!g.dirty);
}

// ---------- Utilidades ----------
#[test]
fn include_filter_patterns() {
    assert!(included("C:/p/src/a.ts", &[]));
    assert!(included("C:/p/src/a.ts", &["*.ts".into()]));
    assert!(!included("C:/p/src/a.md", &["*.ts".into()]));
    assert!(included("C:/p/src/components/a.md", &["src/components".into()]));
    assert!(included("C:/P/SRC/A.TS", &["*.ts".into()]), "sin distinguir mayúsculas");
    assert!(!included("C:/p/a.ts", &["  ".into()]));
}

#[test]
fn norm_uses_forward_slashes() {
    assert_eq!(norm(Path::new("C:\\a\\b\\c.txt")), "C:/a/b/c.txt");
}

#[test]
fn fnv_is_stable_and_distinct() {
    assert_eq!(fnv("a"), fnv("a"));
    assert_ne!(fnv("a"), fnv("b"));
    assert_eq!(fnv("").len(), 16);
}

// ---------- Reemplazo y búsqueda seguros ----------
#[test]
fn replace_preserves_crlf_and_missing_final_newline() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "uno\r\ndos uno\r\ntres uno").unwrap();
    let n = replace_in_file_sync(p.clone(), "uno".into(), "X".into(), true, false, false, None).unwrap();
    assert_eq!(n, 3);
    assert_eq!(fs::read(&p).unwrap(), b"X\r\ndos X\r\ntres X");
}

#[test]
fn replace_matches_search_semantics_per_line() {
    // `\s+` no debe unir líneas: la búsqueda es por línea y el reemplazo debe coincidir con ella.
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "a\nb\n").unwrap();
    let found = search_files_sync(norm(&t.0), r"a\s*$".into(), true, true, false, vec![], &Default::default()).unwrap().len() as u32;
    let n = replace_in_file_sync(p.clone(), r"a\s*$".into(), "X".into(), true, true, false, Some(found)).unwrap();
    assert_eq!(n, found);
    assert_eq!(fs::read_to_string(&p).unwrap(), "X\nb\n");
}

#[test]
fn replace_refuses_when_file_changed_since_search() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "foo foo foo").unwrap();
    let err = replace_in_file_sync(p.clone(), "foo".into(), "bar".into(), true, false, false, Some(1)).unwrap_err();
    assert!(err.contains("cambió desde la búsqueda"), "{err}");
    assert_eq!(fs::read_to_string(&p).unwrap(), "foo foo foo", "no debe escribir nada");
}

#[test]
fn replace_refuses_binary_and_non_utf8_files() {
    let t = Tmp::new();
    let p = t.p("a.bin");
    fs::write(&p, b"foo\0foo").unwrap();
    assert!(replace_in_file_sync(p.clone(), "foo".into(), "bar".into(), true, false, false, None).is_err());
    assert_eq!(fs::read(&p).unwrap(), b"foo\0foo");
    let q = t.p("b.txt");
    fs::write(&q, [0x66, 0x6f, 0x6f, 0xff]).unwrap();
    assert!(replace_in_file_sync(q.clone(), "foo".into(), "bar".into(), true, false, false, None).is_err());
    assert_eq!(fs::read(&q).unwrap(), [0x66, 0x6f, 0x6f, 0xff]);
}

#[test]
fn replace_leaves_no_temp_files() {
    let t = Tmp::new();
    let p = t.p("a.txt");
    fs::write(&p, "foo").unwrap();
    replace_in_file_sync(p, "foo".into(), "bar".into(), true, false, false, None).unwrap();
    let names: Vec<String> = fs::read_dir(&t.0).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["a.txt"]);
}

#[test]
fn search_uses_unsaved_content_of_open_documents() {
    let t = Tmp::new();
    fs::write(t.0.join("a.txt"), "solo en disco").unwrap();
    fs::write(t.0.join("b.txt"), "nada").unwrap();
    let mut unsaved = std::collections::HashMap::new();
    unsaved.insert(norm(&t.0.join("a.txt")), "solo en pantalla".to_string());
    unsaved.insert(norm(&t.0.join("b.txt")), "pantalla\npantalla".to_string());
    let r = search_files_sync(norm(&t.0), "pantalla".into(), true, false, false, vec![], &unsaved).unwrap();
    assert_eq!(r.len(), 3);
    let disk = search_files_sync(norm(&t.0), "disco".into(), true, false, false, vec![], &unsaved).unwrap();
    assert!(disk.is_empty(), "el contenido antiguo del disco ya no debe aparecer");
}

#[test]
fn el_historial_de_ia_se_guarda_en_un_archivo_y_rechaza_lo_que_no_es_una_lista() {
    let dir = std::env::temp_dir().join(format!("pulso-ai-hist-{}", std::process::id()));
    let file = dir.join("ai-chats.json");
    assert_eq!(ai_history_read_in(&file), "");
    ai_history_write_in(&file, r#"[{"id":"a"}]"#).unwrap();
    assert_eq!(ai_history_read_in(&file), r#"[{"id":"a"}]"#);
    assert!(ai_history_write_in(&file, "{}").is_err());
    assert!(ai_history_write_in(&file, "no es json").is_err());
    assert_eq!(ai_history_read_in(&file), r#"[{"id":"a"}]"#, "un intento inválido no pisa lo guardado");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn search_respects_gitignore() {
    let t = Tmp::new();
    fs::write(t.0.join(".gitignore"), "ignorado/\n*.log\n").unwrap();
    fs::create_dir_all(t.0.join("ignorado")).unwrap();
    fs::write(t.0.join("ignorado/secreto.txt"), "aguja\n").unwrap();
    fs::write(t.0.join("debug.log"), "aguja\n").unwrap();
    fs::write(t.0.join("visible.ts"), "aguja\n").unwrap();
    let matches = search_files_sync(norm(&t.0), "aguja".into(), false, false, false, vec![], &Default::default()).unwrap();
    assert_eq!(matches.len(), 1);
    assert!(matches[0].path.ends_with("visible.ts"));
}

#[test]
fn secret_key_allowlist_blocks_arbitrary_keys() {
    assert!(ensure_allowed_secret_key("github-token").is_ok());
    assert!(ensure_allowed_secret_key("aws-secret").is_err());
    assert!(ensure_allowed_secret_key("").is_err());
}
