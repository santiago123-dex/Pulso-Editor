//! Preparar o quitar cambios por fragmentos (stage/unstage hunk) usando `git diff` y `git apply --cached`.
use crate::{background_command, fsguard};
use regex::Regex;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub index: usize,
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub added: usize,
    pub removed: usize,
    pub patch: String,
}

/// Divide una salida de `git diff` de un solo archivo en fragmentos aplicables individualmente.
pub fn split_unified_hunks(diff: &str) -> Vec<DiffHunk> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$").unwrap());

    let lines: Vec<&str> = diff.lines().collect();
    let mut file_header: Vec<&str> = Vec::new();
    let mut hunk_starts: Vec<usize> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("@@ ") && re.is_match(line) {
            hunk_starts.push(i);
        } else if hunk_starts.is_empty() {
            file_header.push(line);
        }
    }

    if hunk_starts.is_empty() || file_header.is_empty() {
        return Vec::new();
    }

    let header_block = file_header.join("\n");
    let mut out = Vec::with_capacity(hunk_starts.len());

    for (idx, &start) in hunk_starts.iter().enumerate() {
        let end = hunk_starts.get(idx + 1).copied().unwrap_or(lines.len());
        let slice = &lines[start..end];
        let Some(c) = re.captures(slice[0]) else { continue };
        let old_start: u32 = c[1].parse().unwrap_or(1);
        let old_count: u32 = c.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
        let new_start: u32 = c[3].parse().unwrap_or(1);
        let new_count: u32 = c.get(4).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);

        let mut added = 0usize;
        let mut removed = 0usize;
        for l in &slice[1..] {
            if l.starts_with('+') && !l.starts_with("+++") {
                added += 1;
            } else if l.starts_with('-') && !l.starts_with("---") {
                removed += 1;
            }
        }

        let mut patch = String::with_capacity(header_block.len() + 256);
        patch.push_str(&header_block);
        patch.push('\n');
        patch.push_str(&slice.join("\n"));
        patch.push('\n');

        out.push(DiffHunk { index: idx, header: slice[0].to_string(), old_start, old_count, new_start, new_count, added, removed, patch });
    }

    out
}

fn file_hunks_sync(root: &Path, rel_path: &str, staged: bool) -> Result<Vec<DiffHunk>, String> {
    let mut args = vec!["diff", "--no-color", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(rel_path);

    let out = background_command("git").args(&args).current_dir(root).output().map_err(|e| format!("No se pudo ejecutar git diff: {e}"))?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(split_unified_hunks(&text))
}

fn apply_hunk_sync(root: &Path, patch: &str, reverse: bool) -> Result<(), String> {
    let mut args = vec!["apply", "--cached", "--unidiff-zero"];
    if reverse {
        args.push("--reverse");
    }
    args.push("-");

    let mut child = background_command("git")
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo iniciar git apply: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).map_err(|e| format!("Error enviando el fragmento a git apply: {e}"))?;
    }

    let out = child.wait_with_output().map_err(|e| format!("Error esperando git apply: {e}"))?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "git apply rechazó el fragmento".into() } else { msg });
    }
    Ok(())
}

#[tauri::command]
pub async fn git_file_hunks(root: String, path: String, staged: bool, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<Vec<DiffHunk>, String> {
    let safe = guard.ensure_read(&root)?;
    tauri::async_runtime::spawn_blocking(move || file_hunks_sync(&safe, &path, staged)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_apply_hunk(root: String, patch: String, reverse: bool, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<(), String> {
    let safe = guard.ensure_write(&root)?;
    tauri::async_runtime::spawn_blocking(move || apply_hunk_sync(&safe, &patch, reverse)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_two_hunks_with_valid_patches() {
        let diff = "\
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
@@ -20,3 +21,2 @@ export function demo() {
-const oldVal = true;
 return 42;
";
        let hunks = split_unified_hunks(diff);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].new_start, 1);
        assert_eq!(hunks[0].added, 1);
        assert_eq!(hunks[0].removed, 0);
        assert!(hunks[0].patch.starts_with("diff --git a/src/a.ts b/src/a.ts\n"));
        assert!(hunks[0].patch.contains("+const b = 2;\n"));
        assert!(!hunks[0].patch.contains("-const oldVal = true;"));

        assert_eq!(hunks[1].new_start, 21);
        assert_eq!(hunks[1].added, 0);
        assert_eq!(hunks[1].removed, 1);
        assert!(hunks[1].patch.contains("-const oldVal = true;\n"));
    }
}
