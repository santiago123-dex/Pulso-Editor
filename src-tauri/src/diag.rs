//! Registro local con rotación y recopilación de información de diagnóstico (sin datos personales).
use super::background_command;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_LOG_BYTES: u64 = 512 * 1024;
const MAX_TAIL_LINES: usize = 30;
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_path_in(dir: &Path) -> PathBuf {
    dir.join("logs").join("pulso.log")
}

/// Escribe una línea en el archivo de registro rotando cuando supera `max_bytes`.
pub fn append_log_in(dir: &Path, level: &str, msg: &str, max_bytes: u64) -> std::io::Result<()> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path_in(dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() >= max_bytes {
            let prev = path.with_extension("log.1");
            let _ = fs::remove_file(&prev);
            let _ = fs::rename(&path, &prev);
        }
    }
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let clean: String = msg.replace(['\r', '\n'], " ").chars().take(600).collect();
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(f, "[{secs}] [{level}] {clean}")?;
    Ok(())
}

fn read_tail(dir: &Path, limit: usize) -> Vec<String> {
    let Ok(text) = fs::read_to_string(log_path_in(dir)) else {
        return Vec::new();
    };
    let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let start = lines.len().saturating_sub(limit);
    lines[start..].to_vec()
}

fn detect_git_version() -> String {
    background_command("git")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "not found".to_string())
}

#[tauri::command]
pub fn diag_log(app: AppHandle, level: String, message: String) {
    if let Ok(dir) = app.path().app_data_dir() {
        let lvl = match level.as_str() {
            "error" | "warn" | "info" => level.as_str(),
            _ => "info",
        };
        let _ = append_log_in(&dir, lvl, &message, MAX_LOG_BYTES);
    }
}

#[tauri::command]
pub async fn diag_collect(app: AppHandle, lsp_status: String, lang: String) -> Result<String, String> {
    let version = app.package_info().version.to_string();
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let data_dir = app.path().app_data_dir().ok();
    let git_ver = tauri::async_runtime::spawn_blocking(detect_git_version)
        .await
        .unwrap_or_else(|_| "unknown".to_string());
    let mut out = format!(
        "Pulso Editor: {version}\nOS: {os} ({arch})\nLanguage: {lang}\nGit: {git_ver}\nLSP: {lsp_status}\n"
    );
    if let Some(dir) = data_dir {
        let tail = read_tail(&dir, MAX_TAIL_LINES);
        if !tail.is_empty() {
            out.push_str("\nRecent log:\n");
            for line in tail {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn rota_el_registro_cuando_supera_el_limite() {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("pulso-diag-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&dir);
        append_log_in(&dir, "info", &"a".repeat(80), 64).unwrap();
        append_log_in(&dir, "warn", "segundo", 64).unwrap();
        assert!(log_path_in(&dir).with_extension("log.1").is_file());
        let tail = read_tail(&dir, 10);
        assert_eq!(tail.len(), 1);
        assert!(tail[0].contains("[warn] segundo"));
        let _ = fs::remove_dir_all(&dir);
    }
}
