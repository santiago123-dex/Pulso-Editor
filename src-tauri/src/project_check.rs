//! Análisis de problemas de todo el proyecto (TypeScript, Rust y Python).
//!
//! Complementa los diagnósticos en vivo del servidor de lenguaje (archivos abiertos)
//! ejecutando compiladores o linters locales del proyecto bajo `WorkspaceGuard`.
use crate::{background_command, fsguard, norm};
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ProjectDiagnostic {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub severity: String,
    pub message: String,
    pub source: String,
    pub code: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ProjectCheckResult {
    pub tools: Vec<String>,
    pub items: Vec<ProjectDiagnostic>,
    pub duration_ms: u64,
    pub note: Option<String>,
}

fn resolve_path(base: &Path, raw: &str) -> String {
    let p = Path::new(raw.trim());
    let full = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    norm(&full)
}

/// Parsea líneas de `tsc --noEmit --pretty false`:
/// `src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`
pub fn parse_tsc_output(output: &str, base: &Path) -> Vec<ProjectDiagnostic> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$").unwrap());
    let mut out = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_end();
        if let Some(c) = re.captures(trimmed) {
            let file = resolve_path(base, &c[1]);
            let l: u32 = c[2].parse().unwrap_or(1);
            let col: u32 = c[3].parse().unwrap_or(1);
            out.push(ProjectDiagnostic {
                path: file,
                line: l,
                col,
                end_line: l,
                end_col: col,
                severity: c[4].to_string(),
                code: Some(c[5].to_string()),
                message: c[6].trim().to_string(),
                source: "tsc".into(),
            });
        }
    }
    out
}

/// Parsea líneas de `cargo check --message-format=short`:
/// `src/main.rs:14:9: error[E0308]: mismatched types`
pub fn parse_cargo_output(output: &str, base: &Path) -> Vec<ProjectDiagnostic> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)\])?:\s*(.+)$").unwrap());
    let mut out = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_end();
        if let Some(c) = re.captures(trimmed) {
            let file = resolve_path(base, &c[1]);
            let l: u32 = c[2].parse().unwrap_or(1);
            let col: u32 = c[3].parse().unwrap_or(1);
            out.push(ProjectDiagnostic {
                path: file,
                line: l,
                col,
                end_line: l,
                end_col: col,
                severity: c[4].to_string(),
                code: c.get(5).map(|m| m.as_str().to_string()),
                message: c[6].trim().to_string(),
                source: "cargo".into(),
            });
        }
    }
    out
}

/// Parsea líneas de `ruff check --output-format=concise`:
/// `app/main.py:8:1: F401 `os` imported but unused`
pub fn parse_ruff_output(output: &str, base: &Path) -> Vec<ProjectDiagnostic> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.+)$").unwrap());
    let mut out = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_end();
        if let Some(c) = re.captures(trimmed) {
            let file = resolve_path(base, &c[1]);
            let l: u32 = c[2].parse().unwrap_or(1);
            let col: u32 = c[3].parse().unwrap_or(1);
            let code = c[4].to_string();
            let sev = if code.starts_with('E') || code.starts_with('F') { "error" } else { "warning" };
            out.push(ProjectDiagnostic {
                path: file,
                line: l,
                col,
                end_line: l,
                end_col: col,
                severity: sev.into(),
                code: Some(code),
                message: c[5].trim().to_string(),
                source: "ruff".into(),
            });
        }
    }
    out
}

fn find_local_tsc(root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let names = ["tsc.cmd", "tsc.exe"];
    #[cfg(not(windows))]
    let names = ["tsc"];
    for n in names {
        let p = root.join("node_modules").join(".bin").join(n);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn run_capture(program: &str, args: &[&str], cwd: &Path) -> Option<String> {
    let out = background_command(program).args(args).current_dir(cwd).output().ok()?;
    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&err);
    }
    Some(combined)
}

fn check_project_sync(root: &Path) -> ProjectCheckResult {
    let started = Instant::now();
    let mut tools = Vec::new();
    let mut items = Vec::new();

    // 1. TypeScript (tsconfig.json)
    if root.join("tsconfig.json").is_file() {
        let output = if let Some(local) = find_local_tsc(root) {
            run_capture(local.to_string_lossy().as_ref(), &["--noEmit", "--pretty", "false"], root)
        } else {
            #[cfg(windows)]
            let cmd = "npx.cmd";
            #[cfg(not(windows))]
            let cmd = "npx";
            run_capture(cmd, &["--no-install", "tsc", "--noEmit", "--pretty", "false"], root)
        };
        if let Some(text) = output {
            tools.push("tsc".into());
            items.extend(parse_tsc_output(&text, root));
        }
    }

    // 2. Rust (Cargo.toml en raíz o src-tauri/Cargo.toml)
    let cargo_dir = if root.join("Cargo.toml").is_file() {
        Some(root.to_path_buf())
    } else if root.join("src-tauri").join("Cargo.toml").is_file() {
        Some(root.join("src-tauri"))
    } else {
        None
    };
    if let Some(cdir) = cargo_dir {
        if let Some(text) = run_capture("cargo", &["check", "--message-format=short"], &cdir) {
            tools.push("cargo".into());
            items.extend(parse_cargo_output(&text, &cdir));
        }
    }

    // 3. Python (ruff)
    let is_python = root.join("pyproject.toml").is_file() || root.join("requirements.txt").is_file() || root.join("setup.py").is_file();
    if is_python {
        if let Some(text) = run_capture("ruff", &["check", "--output-format=concise", "."], root) {
            tools.push("ruff".into());
            items.extend(parse_ruff_output(&text, root));
        }
    }

    let note = if tools.is_empty() { Some("No se detectó tsconfig.json, Cargo.toml ni ruff en esta carpeta.".into()) } else { None };

    // Límite razonable para mantener fluida la interfaz
    items.truncate(2000);

    ProjectCheckResult { tools, items, duration_ms: started.elapsed().as_millis() as u64, note }
}

#[tauri::command]
pub async fn project_check(root: String, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<ProjectCheckResult, String> {
    let safe = guard.ensure_read(&root)?;
    tauri::async_runtime::spawn_blocking(move || check_project_sync(&safe)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tsc_diagnostics() {
        let out = "\
src/app.ts(10,4): error TS2322: Type 'string' is not assignable to type 'number'.
src/util.ts(3,1): warning TS6133: 'x' is declared but its value is never read.
Found 2 errors.
";
        let list = parse_tsc_output(out, Path::new("/proj"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "/proj/src/app.ts");
        assert_eq!(list[0].line, 10);
        assert_eq!(list[0].col, 4);
        assert_eq!(list[0].severity, "error");
        assert_eq!(list[0].code.as_deref(), Some("TS2322"));
        assert_eq!(list[1].severity, "warning");
    }

    #[test]
    fn parses_cargo_short_diagnostics() {
        let out = "\
src/lib.rs:42:12: error[E0308]: mismatched types
src/main.rs:5:5: warning: unused variable: `a`
";
        let list = parse_cargo_output(out, Path::new("/proj/src-tauri"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "/proj/src-tauri/src/lib.rs");
        assert_eq!(list[0].code.as_deref(), Some("E0308"));
        assert_eq!(list[1].severity, "warning");
        assert_eq!(list[1].code, None);
    }

    #[test]
    fn parses_ruff_concise_diagnostics() {
        let out = "app/main.py:8:1: F401 `os` imported but unused\napp/main.py:12:5: W291 trailing whitespace\n";
        let list = parse_ruff_output(out, Path::new("/py"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].severity, "error");
        assert_eq!(list[0].code.as_deref(), Some("F401"));
        assert_eq!(list[1].severity, "warning");
    }
}
