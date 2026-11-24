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
pub async fn git_merge(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, branch: String) -> Result<MergeRebaseResult, String> {
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || merge_sync(&root, &branch)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rebase(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, branch: String) -> Result<MergeRebaseResult, String> {
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || rebase_sync(&root, &branch)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_operation_state(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String) -> Result<OperationState, String> {
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || operation_state_sync(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_operation_action(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, action: String) -> Result<MergeRebaseResult, String> {
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || operation_action_sync(&root, &action)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_sources(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, path: String, orig: Option<String>, staged: bool) -> Result<DiffSources, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || diff_sources_sync(&root, &path, orig.as_deref(), staged)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_log(guard: tauri::State<'_, crate::fsguard::WorkspaceGuard>, root: String, path: Option<String>, skip: u32, limit: u32, query: Option<String>, all: Option<bool>) -> Result<Vec<Commit>, String> {
    // Solo carpetas de trabajo abiertas en Pulso: la ventana no puede apuntar git a cualquier ruta.
    guard.ensure_dir(&root)?;
    tauri::async_runtime::spawn_blocking(move || log_sync(&root, path.as_deref(), skip, limit, query.as_deref(), all.unwrap_or(false))).await.map_err(|e| e.to_string())?
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
mod tests;

mod branches;
mod changes;
mod history;
mod remote;

pub use branches::*;
pub use changes::*;
pub use history::*;
use remote::*;
