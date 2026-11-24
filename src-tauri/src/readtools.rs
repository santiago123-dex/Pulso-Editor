//! Herramientas de lectura que comparten el agente y sus subagentes: listar carpetas, leer archivos y buscar texto, siempre
//! dentro de la carpeta abierta (rechazan rutas absolutas, `..` que salgan y enlaces que apunten fuera).
use crate::i18n::{tr, trf};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

const MAX_TOOL_OUTPUT: usize = 24_000;
const MAX_READ_BYTES: u64 = 512 * 1024;
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__"];

pub(crate) fn safe_rel_edit_path(raw: &str) -> Result<String, String> {
    let clean = raw.trim().replace('\\', "/").trim_start_matches("./").to_string();
    let p = Path::new(&clean);
    // Una letra de unidad (`C:/x`) se rechaza en todos los sistemas: en Windows saldría del proyecto y en Linux sería una carpeta rara.
    let drive_like = clean.len() >= 2 && clean.as_bytes()[0].is_ascii_alphabetic() && clean.as_bytes()[1] == b':';
    if clean.is_empty()
        || drive_like
        || p.is_absolute()
        || p.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir | Component::ParentDir))
    {
        return Err(tr("Solo se pueden proponer cambios en rutas relativas dentro del proyecto.").into());
    }
    Ok(clean)
}

pub(crate) fn lang_for_path(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "ts" | "mts" | "cts" => "ts",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "js",
        "jsx" => "jsx",
        "rs" => "rust",
        "py" => "python",
        "json" => "json",
        "css" => "css",
        "html" => "html",
        "md" => "markdown",
        _ => "text",
    }
}

pub(crate) fn fence_for_content(content: &str) -> String {
    let mut longest = 0usize;
    let mut cur = 0usize;
    for ch in content.chars() {
        if ch == '`' {
            cur += 1;
            longest = longest.max(cur);
        } else {
            cur = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

/// Ruta dentro de la carpeta del proyecto, o error. Rechaza rutas absolutas, `..` que salgan y enlaces que apunten fuera.
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    let rel = if rel.is_empty() { ".".to_string() } else { rel };
    let p = Path::new(&rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err(tr("Solo se pueden leer rutas dentro de la carpeta del proyecto.").into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(root.join(p)).map_err(|_| trf("No existe: {path}", &[("path", &rel)]))?;
    if !full.starts_with(&root) {
        return Err(tr("Solo se pueden leer rutas dentro de la carpeta del proyecto.").into());
    }
    Ok(full)
}

fn cut(mut s: String) -> String {
    if s.len() > MAX_TOOL_OUTPUT {
        let mut end = MAX_TOOL_OUTPUT;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n…");
    }
    s
}

pub fn list_files(root: &Path, rel: &str) -> Result<String, String> {
    let dir = resolve_in(root, rel)?;
    let mut entries: Vec<(bool, String)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (!(is_dir && SKIP_DIRS.contains(&name.as_str()))).then_some((is_dir, name))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let total = entries.len();
    let mut out: Vec<String> = entries.into_iter().take(500).map(|(d, n)| if d { format!("{n}/") } else { n }).collect();
    if total > 500 {
        out.push(format!("… (+{})", total - 500));
    }
    Ok(if out.is_empty() { "(empty)".into() } else { out.join("\n") })
}

pub fn read_file(root: &Path, rel: &str, start: Option<u64>, max: Option<u64>) -> Result<String, String> {
    let file = resolve_in(root, rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return list_files(root, rel);
    }
    // Un archivo grande solo se lee por rangos (y nunca uno enorme), para no llenar el contexto del modelo.
    if meta.len() > 16 * MAX_READ_BYTES || (meta.len() > MAX_READ_BYTES && start.is_none()) {
        return Err(trf(
            "El archivo es demasiado grande para leerlo entero ({size} KB). Lee un rango con start_line y max_lines.",
            &[("size", &(meta.len() / 1024))],
        ));
    }
    read_range(&file, start, max)
}

fn read_range(file: &Path, start: Option<u64>, max: Option<u64>) -> Result<String, String> {
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(tr("Es un archivo binario: no se puede leer como texto.").into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let start = start.unwrap_or(1).max(1) as usize;
    let max = max.unwrap_or(400).clamp(1, 2000) as usize;
    let lines: Vec<&str> = text.lines().collect();
    let shown: Vec<String> = lines.iter().enumerate().skip(start - 1).take(max).map(|(i, l)| format!("{:>5}  {l}", i + 1)).collect();
    let mut out = shown.join("\n");
    if start - 1 + max < lines.len() {
        out.push_str(&format!("\n… ({} lines total)", lines.len()));
    }
    Ok(cut(out))
}

pub fn search_code(root: &Path, query: &str, rel: Option<&str>) -> Result<String, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err(tr("La búsqueda está vacía").into());
    }
    let base = resolve_in(root, rel.unwrap_or("."))?;
    let root_c = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    let walker = ignore::WalkBuilder::new(&base)
        .hidden(false)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
        .build();
    'files: for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if std::fs::metadata(path).map(|m| m.len() > MAX_READ_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        if bytes.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let shown = path.strip_prefix(&root_c).unwrap_or(path).to_string_lossy().replace('\\', "/");
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                let l: String = line.trim().chars().take(200).collect();
                hits.push(format!("{shown}:{}: {l}", i + 1));
                if hits.len() >= 100 {
                    hits.push("… (100+)".into());
                    break 'files;
                }
            }
        }
    }
    Ok(if hits.is_empty() { "(no matches)".into() } else { cut(hits.join("\n")) })
}

/// Ejecuta una herramienta. Devuelve (nombre para el panel, entrada para el panel, resultado, ¿error?).
pub fn run_tool(root: &Path, name: &str, args: &Value) -> (&'static str, Value, String, bool) {
    let s = |k: &str| args[k].as_str().map(str::to_string).or_else(|| args[k].as_i64().map(|n| n.to_string()));
    let n = |k: &str| args[k].as_u64().or_else(|| args[k].as_str().and_then(|v| v.parse().ok()));
    let (ui_name, ui_input, result) = match name {
        "list_files" => {
            let path = s("path").unwrap_or_else(|| ".".into());
            ("Glob", json!({ "path": path }), list_files(root, &path))
        }
        "read_file" => {
            let path = s("path").unwrap_or_default();
            ("Read", json!({ "file_path": path }), read_file(root, &path, n("start_line"), n("max_lines")))
        }
        "search_code" => {
            let query = s("query").unwrap_or_default();
            let path = s("path");
            ("Grep", json!({ "pattern": query }), search_code(root, &query, path.as_deref()))
        }
        "propose_edit" => {
            let path = s("path").unwrap_or_default();
            let content = s("content").unwrap_or_default();
            let res = safe_rel_edit_path(&path)
                .map(|clean| trf("Propuesta preparada para {path}. La persona podrá revisarla y aplicarla en el visor de diferencias.", &[("path", &clean)]));
            ("Edit", json!({ "file_path": path, "bytes": content.len() }), res)
        }
        other => ("Tool", json!({ "name": other }), Err(trf("Herramienta desconocida: {name}", &[("name", &other)]))),
    };
    match result {
        Ok(text) => (ui_name, ui_input, text, false),
        Err(e) => (ui_name, ui_input, e, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    /// Carpeta propia para cada prueba (corren en paralelo).
    fn tmp() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("pulso-readtools-{}-{n}", std::process::id()));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::write(d.join("src/main.ts"), "const saludo = 'hola';\nexport function sumar(a: number, b: number) { return a + b; }\n").unwrap();
        std::fs::write(d.join("README.md"), "# Proyecto\nUsa sumar.\n").unwrap();
        std::fs::write(d.join("node_modules/x/index.js"), "sumar").unwrap();
        d
    }

    #[test]
    fn las_herramientas_no_salen_de_la_carpeta() {
        let root = tmp();
        assert!(resolve_in(&root, "../").is_err());
        assert!(resolve_in(&root, "src/../../").is_err());
        assert!(resolve_in(&root, if cfg!(windows) { "C:\\Windows\\win.ini" } else { "/etc/passwd" }).is_err());
        assert!(resolve_in(&root, "src/main.ts").is_ok());
        let (_, _, msg, err) = run_tool(&root, "read_file", &json!({ "path": "../secreto.txt" }));
        assert!(err, "{msg}");
        let (_, _, pmsg, perr) = run_tool(&root, "propose_edit", &json!({ "path": "../secreto.txt", "content": "x" }));
        assert!(perr, "{pmsg}");
        let (ename, _, emsg, eerr) = run_tool(&root, "propose_edit", &json!({ "path": "src/main.ts", "content": "export const x = 1;\n" }));
        assert!(!eerr, "{emsg}");
        assert_eq!(ename, "Edit");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lista_lee_y_busca() {
        let root = tmp();
        let list = list_files(&root, ".").unwrap();
        assert!(list.starts_with("src/"), "{list}");
        assert!(!list.contains("node_modules"), "se omiten carpetas pesadas: {list}");
        let read = read_file(&root, "src/main.ts", Some(2), Some(1)).unwrap();
        assert!(read.contains("    2  export function sumar") && !read.contains("saludo"), "{read}");
        let found = search_code(&root, "SUMAR", None).unwrap();
        assert!(found.contains("src/main.ts:2:") && found.contains("README.md:2:"), "{found}");
        assert!(!found.contains("node_modules"), "{found}");
        let (name, input, _, err) = run_tool(&root, "read_file", &json!({ "path": "README.md" }));
        assert_eq!((name, input["file_path"].as_str(), err), ("Read", Some("README.md"), false));
        std::fs::remove_dir_all(root).unwrap();
    }
}
