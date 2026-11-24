//! Detección y ejecución de pruebas (Vitest, Jest, Cargo test y Pytest) con resultados por archivo.
use crate::{background_command, fsguard, norm};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DetectedRunner {
    pub id: String,
    pub label: String,
    pub cwd: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct TestCaseResult {
    pub file: String,
    pub name: String,
    pub status: String, // "passed" | "failed" | "skipped"
    pub duration_ms: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct TestRunResult {
    pub runner: String,
    pub ok: bool,
    pub cases: Vec<TestCaseResult>,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub duration_ms: u64,
    pub output: String,
}

fn strip_ansi(input: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\x1B\[[0-9;]*[A-Za-z]").unwrap());
    re.replace_all(input, "").into_owned()
}

fn has_pkg_dep(root: &Path, dep: &str) -> bool {
    let Ok(raw) = fs::read_to_string(root.join("package.json")) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return false };
    for section in ["dependencies", "devDependencies", "scripts"] {
        if let Some(obj) = v.get(section).and_then(|s| s.as_object()) {
            if obj.contains_key(dep) {
                return true;
            }
            if section == "scripts" && obj.values().any(|val| val.as_str().is_some_and(|s| s.contains(dep))) {
                return true;
            }
        }
    }
    false
}

fn detect_runners_sync(root: &Path) -> Vec<DetectedRunner> {
    let mut out = Vec::new();
    let norm_root = norm(root);

    // Vitest
    if root.join("vitest.config.ts").is_file()
        || root.join("vitest.config.js").is_file()
        || root.join("vitest.config.mts").is_file()
        || has_pkg_dep(root, "vitest")
    {
        out.push(DetectedRunner { id: "vitest".into(), label: "Vitest".into(), cwd: norm_root.clone() });
    }

    // Jest
    if root.join("jest.config.ts").is_file() || root.join("jest.config.js").is_file() || root.join("jest.config.cjs").is_file() || has_pkg_dep(root, "jest") {
        out.push(DetectedRunner { id: "jest".into(), label: "Jest".into(), cwd: norm_root.clone() });
    }

    // Cargo test
    if root.join("Cargo.toml").is_file() {
        out.push(DetectedRunner { id: "cargo".into(), label: "Cargo test".into(), cwd: norm_root.clone() });
    } else if root.join("src-tauri").join("Cargo.toml").is_file() {
        out.push(DetectedRunner { id: "cargo".into(), label: "Cargo test (src-tauri)".into(), cwd: norm(&root.join("src-tauri")) });
    }

    // Pytest
    let has_pytest = root.join("pytest.ini").is_file()
        || root.join("conftest.py").is_file()
        || fs::read_to_string(root.join("pyproject.toml")).is_ok_and(|s| s.contains("pytest"));
    if has_pytest {
        out.push(DetectedRunner { id: "pytest".into(), label: "Pytest".into(), cwd: norm_root });
    }

    out
}

/// Parsea salida de Vitest (`--reporter=verbose`) o Jest (`--verbose --no-color`).
pub fn parse_js_test_output(output: &str, base: &Path) -> Vec<TestCaseResult> {
    static VITEST_LINE: OnceLock<Regex> = OnceLock::new();
    static JEST_FILE: OnceLock<Regex> = OnceLock::new();
    static JEST_CASE: OnceLock<Regex> = OnceLock::new();

    // Vitest verbose: ` ✓ src/foo.test.ts > suite > test name 4ms` o ` × src/foo.test.ts > test`
    let re_vitest = VITEST_LINE.get_or_init(|| Regex::new(r"^\s*([✓✔×✕↓○-])\s+([^\s>]+\.(?:test|spec)\.[jt]sx?)\s+>\s+(.+?)(?:\s+(\d+)\s*ms)?\s*$").unwrap());
    let re_jest_file = JEST_FILE.get_or_init(|| Regex::new(r"^\s*(?:PASS|FAIL)\s+([^\s]+\.(?:test|spec)\.[jt]sx?)").unwrap());
    let re_jest_case = JEST_CASE.get_or_init(|| Regex::new(r"^\s*([✓✔×✕○-])\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$").unwrap());

    let clean = strip_ansi(output);
    let mut out = Vec::new();
    let mut current_file = String::new();

    for line in clean.lines() {
        if let Some(c) = re_vitest.captures(line) {
            let status = match &c[1] {
                "✓" | "✔" => "passed",
                "×" | "✕" => "failed",
                _ => "skipped",
            };
            let file = norm(&base.join(c[2].trim()));
            out.push(TestCaseResult {
                file,
                name: c[3].trim().to_string(),
                status: status.into(),
                duration_ms: c.get(4).and_then(|m| m.as_str().parse().ok()),
            });
            continue;
        }
        if let Some(c) = re_jest_file.captures(line) {
            current_file = norm(&base.join(c[1].trim()));
            continue;
        }
        if !current_file.is_empty() {
            if let Some(c) = re_jest_case.captures(line) {
                let status = match &c[1] {
                    "✓" | "✔" => "passed",
                    "×" | "✕" => "failed",
                    _ => "skipped",
                };
                out.push(TestCaseResult {
                    file: current_file.clone(),
                    name: c[2].trim().to_string(),
                    status: status.into(),
                    duration_ms: c.get(3).and_then(|m| m.as_str().parse().ok()),
                });
            }
        }
    }
    out
}

/// Parsea salida estándar de `cargo test`:
/// `test module::tests::works ... ok` / `FAILED` / `ignored`
pub fn parse_cargo_test_output(output: &str, cargo_dir: &Path) -> Vec<TestCaseResult> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^test\s+([^\s]+)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$").unwrap());
    let clean = strip_ansi(output);
    let mut out = Vec::new();
    for line in clean.lines() {
        if let Some(c) = re.captures(line.trim()) {
            let full = c[1].to_string();
            let module = full.split("::").next().unwrap_or("lib");
            let candidate = cargo_dir.join("src").join(format!("{module}.rs"));
            let file = if candidate.is_file() { norm(&candidate) } else { norm(&cargo_dir.join("src").join("lib.rs")) };
            let status = match &c[2] {
                "ok" => "passed",
                "FAILED" => "failed",
                _ => "skipped",
            };
            out.push(TestCaseResult { file, name: full, status: status.into(), duration_ms: None });
        }
    }
    out
}

/// Parsea salida de `pytest -v`:
/// `tests/test_math.py::test_add PASSED`
pub fn parse_pytest_output(output: &str, base: &Path) -> Vec<TestCaseResult> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^([^\s:]+\.py)::(.+?)\s+(PASSED|FAILED|SKIPPED|ERROR)\b").unwrap());
    let clean = strip_ansi(output);
    let mut out = Vec::new();
    for line in clean.lines() {
        if let Some(c) = re.captures(line.trim()) {
            let status = match &c[3] {
                "PASSED" => "passed",
                "SKIPPED" => "skipped",
                _ => "failed",
            };
            out.push(TestCaseResult { file: norm(&base.join(c[1].trim())), name: c[2].trim().to_string(), status: status.into(), duration_ms: None });
        }
    }
    out
}

fn find_local_bin(root: &Path, name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = [format!("{name}.cmd"), format!("{name}.exe")];
    #[cfg(not(windows))]
    let candidates = [name.to_string()];
    for c in candidates {
        let p = root.join("node_modules").join(".bin").join(c);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn run_tests_sync(root: &Path, runner: &str, file: Option<&str>) -> Result<TestRunResult, String> {
    let started = Instant::now();
    let (program, args, cwd): (String, Vec<String>, PathBuf) = match runner {
        "vitest" => {
            let mut a = vec!["run".into(), "--reporter=verbose".into(), "--no-color".into()];
            if let Some(f) = file {
                a.push(f.into());
            }
            if let Some(bin) = find_local_bin(root, "vitest") {
                (bin.to_string_lossy().into_owned(), a, root.to_path_buf())
            } else {
                #[cfg(windows)]
                let npx = "npx.cmd".to_string();
                #[cfg(not(windows))]
                let npx = "npx".to_string();
                let mut full = vec!["--no-install".into(), "vitest".into()];
                full.extend(a);
                (npx, full, root.to_path_buf())
            }
        }
        "jest" => {
            let mut a = vec!["--verbose".into(), "--no-color".into()];
            if let Some(f) = file {
                a.push(f.into());
            }
            if let Some(bin) = find_local_bin(root, "jest") {
                (bin.to_string_lossy().into_owned(), a, root.to_path_buf())
            } else {
                #[cfg(windows)]
                let npx = "npx.cmd".to_string();
                #[cfg(not(windows))]
                let npx = "npx".to_string();
                let mut full = vec!["--no-install".into(), "jest".into()];
                full.extend(a);
                (npx, full, root.to_path_buf())
            }
        }
        "cargo" => {
            let cdir = if root.join("Cargo.toml").is_file() { root.to_path_buf() } else { root.join("src-tauri") };
            let mut a = vec!["test".into()];
            if let Some(f) = file {
                if let Some(stem) = Path::new(f).file_stem().and_then(|s| s.to_str()) {
                    a.push(stem.into());
                }
            }
            ("cargo".into(), a, cdir)
        }
        "pytest" => {
            let mut a = vec!["-v".into(), "--tb=short".into(), "--color=no".into()];
            if let Some(f) = file {
                a.push(f.into());
            }
            ("pytest".into(), a, root.to_path_buf())
        }
        other => return Err(format!("Ejecutor de pruebas no soportado: {other}")),
    };

    let out = background_command(&program).args(&args).current_dir(&cwd).output().map_err(|e| format!("No se pudo ejecutar {program}: {e}"))?;

    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&err);
    }

    let cases = match runner {
        "vitest" | "jest" => parse_js_test_output(&combined, &cwd),
        "cargo" => parse_cargo_test_output(&combined, &cwd),
        "pytest" => parse_pytest_output(&combined, &cwd),
        _ => Vec::new(),
    };

    let passed = cases.iter().filter(|c| c.status == "passed").count();
    let failed = cases.iter().filter(|c| c.status == "failed").count();
    let skipped = cases.iter().filter(|c| c.status == "skipped").count();

    let clean_out = strip_ansi(&combined);
    let clipped = if clean_out.len() > 40_000 { format!("{}\n…(salida recortada)", &clean_out[..40_000]) } else { clean_out };

    Ok(TestRunResult {
        runner: runner.into(),
        ok: out.status.success(),
        cases,
        passed,
        failed,
        skipped,
        duration_ms: started.elapsed().as_millis() as u64,
        output: clipped,
    })
}

#[tauri::command]
pub async fn test_detect(root: String, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<Vec<DetectedRunner>, String> {
    let safe = guard.ensure_read(&root)?;
    tauri::async_runtime::spawn_blocking(move || detect_runners_sync(&safe)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_run(root: String, runner: String, file: Option<String>, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<TestRunResult, String> {
    let safe = guard.ensure_read(&root)?;
    let safe_file = match file {
        Some(f) if !f.trim().is_empty() => Some(norm(&guard.ensure_read(&f)?)),
        _ => None,
    };
    tauri::async_runtime::spawn_blocking(move || run_tests_sync(&safe, &runner, safe_file.as_deref())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vitest_verbose_lines() {
        let out = "\
 ✓ src/math.test.ts > sum > adds two numbers 3ms
 × src/math.test.ts > sum > handles negative 7ms
 ↓ src/math.test.ts > sum > pending case
";
        let cases = parse_js_test_output(out, Path::new("/repo"));
        assert_eq!(cases.len(), 3);
        assert_eq!(cases[0].status, "passed");
        assert_eq!(cases[0].duration_ms, Some(3));
        assert_eq!(cases[1].status, "failed");
        assert_eq!(cases[2].status, "skipped");
    }

    #[test]
    fn parses_cargo_test_lines() {
        let out = "\
running 3 tests
test project_check::tests::parses_tsc_diagnostics ... ok
test git_hunks::tests::fails_case ... FAILED
test slow::tests::skip_me ... ignored
";
        let cases = parse_cargo_test_output(out, Path::new("/repo/src-tauri"));
        assert_eq!(cases.len(), 3);
        assert_eq!(cases[0].status, "passed");
        assert_eq!(cases[1].status, "failed");
        assert_eq!(cases[2].status, "skipped");
    }

    #[test]
    fn parses_pytest_verbose_lines() {
        let out = "\
tests/test_api.py::test_login PASSED [ 50%]
tests/test_api.py::test_logout FAILED [100%]
";
        let cases = parse_pytest_output(out, Path::new("/py"));
        assert_eq!(cases.len(), 2);
        assert_eq!(cases[0].file, "/py/tests/test_api.py");
        assert_eq!(cases[0].status, "passed");
        assert_eq!(cases[1].status, "failed");
    }
}
