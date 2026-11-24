//! Búsqueda y reemplazo en el proyecto.
use super::*;

pub(crate) fn build_regex(query: &str, case_sensitive: bool, use_regex: bool, whole_word: bool) -> Result<Regex, String> {
    if query.is_empty() {
        return Err(tr("La búsqueda está vacía").into());
    }
    let mut pat = if use_regex { query.to_string() } else { regex::escape(query) };
    if whole_word {
        pat = format!(r"\b(?:{})\b", pat);
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| trf("Expresión regular no válida: {e}", &[("e", &e)]))
}

#[derive(Serialize)]
pub(crate) struct Match {
    pub(crate) path: String,
    pub(crate) line: u32,
    pub(crate) col: u32,
    pub(crate) len: u32,
    pub(crate) text: String,
}

pub(crate) fn prepare_include(include: &[String]) -> Option<Vec<String>> {
    if include.is_empty() {
        return None;
    }
    Some(
        include
            .iter()
            .map(|p| p.trim().to_lowercase().replace('\\', "/"))
            .filter(|p| !p.is_empty())
            .collect(),
    )
}

pub(crate) fn included_prepared(path: &str, patterns: &Option<Vec<String>>) -> bool {
    let Some(patterns) = patterns else {
        return true;
    };
    let lower = path.to_lowercase();
    patterns.iter().any(|pat| match pat.strip_prefix('*') {
        Some(rest) => lower.ends_with(rest),
        None => lower.contains(pat),
    })
}

#[cfg(test)]
pub(crate) fn included(path: &str, include: &[String]) -> bool {
    included_prepared(path, &prepare_include(include))
}

/// Lee un archivo de texto; devuelve None si es binario, muy grande o no UTF-8.
pub(crate) fn read_text(path: &Path) -> Option<String> {
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
pub(crate) async fn search_files(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    root: String, query: String, case_sensitive: bool, use_regex: bool, whole_word: bool, include: Vec<String>,
    unsaved: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<Match>, String> {
    let safe_root = guard.ensure_read(&root)?;
    let unsaved = unsaved.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        search_files_sync(safe_root.to_string_lossy().into_owned(), query, case_sensitive, use_regex, whole_word, include, &unsaved)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn search_files_sync(
    root: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    include: Vec<String>,
    unsaved: &std::collections::HashMap<String, String>,
) -> Result<Vec<Match>, String> {
    use std::sync::{atomic::AtomicUsize, Mutex};
    const MAX: usize = 5000;
    let re = build_regex(&query, case_sensitive, use_regex, whole_word)?;
    let patterns = prepare_include(&include);
    let out = Mutex::new(Vec::<Match>::new());
    let total = AtomicUsize::new(0);

    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy();
                if SKIP_DIRS.contains(&name.as_ref()) {
                    return false;
                }
            }
            true
        });

    builder.build_parallel().run(|| {
        Box::new(|entry_res| {
            if total.load(Ordering::Relaxed) >= MAX {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry_res else { return ignore::WalkState::Continue };
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let p = entry.path();
            let path = norm(p);
            if !included_prepared(&path, &patterns) {
                return ignore::WalkState::Continue;
            }
            // Un documento abierto con cambios sin guardar se busca con su contenido en pantalla, no con el del disco.
            let owned;
            let text: &str = match unsaved.get(&path) {
                Some(t) => t.as_str(),
                None => match read_text(p) {
                    Some(t) => { owned = t; owned.as_str() }
                    None => return ignore::WalkState::Continue,
                },
            };
            let mut local: Vec<Match> = Vec::new();
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    if m.start() == m.end() {
                        continue;
                    }
                    local.push(Match {
                        path: path.clone(),
                        line: (i + 1) as u32,
                        col: line[..m.start()].encode_utf16().count() as u32 + 1,
                        len: line[m.start()..m.end()].encode_utf16().count() as u32,
                        text: line.chars().take(300).collect(),
                    });
                    if local.len() >= MAX {
                        break;
                    }
                }
                if local.len() >= MAX {
                    break;
                }
            }
            if !local.is_empty() {
                if let Ok(mut guard) = out.lock() {
                    let rem = MAX.saturating_sub(guard.len());
                    if rem == 0 {
                        total.store(MAX, Ordering::Relaxed);
                        return ignore::WalkState::Quit;
                    }
                    let take = local.len().min(rem);
                    guard.extend(local.into_iter().take(take));
                    total.store(guard.len(), Ordering::Relaxed);
                    if guard.len() >= MAX {
                        return ignore::WalkState::Quit;
                    }
                }
            }
            ignore::WalkState::Continue
        })
    });

    let mut results = out.into_inner().unwrap_or_default();
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)).then(a.col.cmp(&b.col)));
    Ok(results)
}

/// Reemplaza las coincidencias de un archivo con las mismas reglas que la búsqueda (línea a línea,
/// conservando los finales de línea) y lo guarda con escritura atómica y detección de cambios.
/// Si `expected` no coincide con lo que hay ahora en disco, no escribe nada.
#[tauri::command]
pub(crate) async fn replace_in_file(
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: String, query: String, replacement: String, case_sensitive: bool, use_regex: bool, whole_word: bool,
    expected: Option<u32>,
) -> Result<u32, String> {
    let safe = guard.ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        replace_in_file_sync(safe.to_string_lossy().into_owned(), query, replacement, case_sensitive, use_regex, whole_word, expected)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn replace_in_file_sync(
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
    let text = read_text(p).ok_or_else(|| tr("El archivo es binario, demasiado grande o no es UTF-8; no se modifica").to_string())?;
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
            return Err(trf("El archivo cambió desde la búsqueda ({expected} coincidencias previstas, {now} ahora)", &[("expected", &e), ("now", &count)]));
        }
    }
    write_checked(p, out.as_bytes(), mtime)?;
    Ok(count)
}
