//! Ramas: listar, cambiar, crear, renombrar y borrar.
use super::*;

pub(super) fn delete_branch_sync(root: &str, name: &str, force: bool) -> Result<(), String> {
    valid_branch_name(name)?;
    let top = top_of(root)?;
    run(&top, &["branch", if force { "-D" } else { "-d" }, name]).map(|_| ())
}

pub(super) fn rename_branch_sync(root: &str, old_name: &str, new_name: &str) -> Result<(), String> {
    valid_branch_name(old_name)?;
    valid_branch_name(new_name)?;
    let top = top_of(root)?;
    if !succeeds(&top, &["check-ref-format", "--branch", new_name]) {
        return Err(trf("«{name}» no es un nombre de rama válido", &[("name", &new_name)]));
    }
    run(&top, &["branch", "-m", old_name, new_name]).map(|_| ())
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

pub(super) fn branches_sync(root: &str) -> Result<Vec<Branch>, String> {
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

pub(super) fn valid_branch_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() { return Err(tr("Escribe un nombre para la rama").into()); }
    if name.starts_with('-') { return Err(tr("El nombre de la rama no puede empezar por «-»").into()); }
    Ok(())
}

/// Cambia a una rama existente (creando la local si solo existe en el remoto) o crea una nueva.
pub(super) fn switch_sync(root: &str, name: &str, create: bool) -> Result<(), String> {
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

// ---------- Merge, rebase y estado de operación en curso ----------
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct MergeRebaseResult {
    /// `"ok"` si terminó sin conflictos, `"conflicts"` si quedaron conflictos por resolver.
    pub status: String,
    pub message: String,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct OperationState {
    /// `"merge"`, `"rebase"` o `None` si no hay operación en curso.
    pub kind: Option<String>,
}

fn git_dir_of(top: &str) -> Result<std::path::PathBuf, String> {
    let raw = run(top, &["rev-parse", "--git-dir"])?;
    let trimmed = raw.trim();
    let p = std::path::PathBuf::from(trimmed);
    if p.is_absolute() { Ok(p) } else { Ok(std::path::PathBuf::from(top).join(p)) }
}

pub(super) fn operation_state_sync(root: &str) -> Result<OperationState, String> {
    let top = top_of(root)?;
    let gd = git_dir_of(&top)?;
    if gd.join("MERGE_HEAD").exists() {
        return Ok(OperationState { kind: Some("merge".into()) });
    }
    if gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists() {
        return Ok(OperationState { kind: Some("rebase".into()) });
    }
    Ok(OperationState { kind: None })
}

fn run_with_no_editor(dir: &str, args: &[&str]) -> Result<String, String> {
    let o = git_command(dir)
        .env("GIT_EDITOR", "true")
        .args(args)
        .output()
        .map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        Err(text(&o))
    }
}

pub(super) fn merge_sync(root: &str, branch: &str) -> Result<MergeRebaseResult, String> {
    valid_branch_name(branch)?;
    let top = top_of(root)?;
    match run_with_no_editor(&top, &["merge", "--no-edit", branch]) {
        Ok(msg) => Ok(MergeRebaseResult { status: "ok".into(), message: msg }),
        Err(err) => {
            if operation_state_sync(&top).map(|s| s.kind.as_deref() == Some("merge")).unwrap_or(false)
                || err.contains("CONFLICT")
            {
                Ok(MergeRebaseResult {
                    status: "conflicts".into(),
                    message: tr("Fusión detenida por conflictos. Resuélvelos y continúa o aborta.").into(),
                })
            } else {
                Err(err)
            }
        }
    }
}

pub(super) fn rebase_sync(root: &str, branch: &str) -> Result<MergeRebaseResult, String> {
    valid_branch_name(branch)?;
    let top = top_of(root)?;
    match run_with_no_editor(&top, &["rebase", branch]) {
        Ok(msg) => Ok(MergeRebaseResult { status: "ok".into(), message: msg }),
        Err(err) => {
            if operation_state_sync(&top).map(|s| s.kind.as_deref() == Some("rebase")).unwrap_or(false)
                || err.contains("CONFLICT")
            {
                Ok(MergeRebaseResult {
                    status: "conflicts".into(),
                    message: tr("Rebase detenido por conflictos. Resuélvelos, prepáralos y continúa o aborta.").into(),
                })
            } else {
                Err(err)
            }
        }
    }
}

pub(super) fn operation_action_sync(root: &str, action: &str) -> Result<MergeRebaseResult, String> {
    if action != "abort" && action != "continue" {
        return Err(tr("Acción de Git no válida").into());
    }
    let top = top_of(root)?;
    let state = operation_state_sync(&top)?;
    let Some(kind) = state.kind else {
        return Err(tr("No hay ninguna fusión ni rebase en curso").into());
    };
    let flag = if action == "abort" { "--abort" } else { "--continue" };
    match run_with_no_editor(&top, &[&kind, flag]) {
        Ok(msg) => Ok(MergeRebaseResult { status: "ok".into(), message: msg }),
        Err(err) => {
            if action == "continue"
                && (operation_state_sync(&top).map(|s| s.kind.is_some()).unwrap_or(false) || err.contains("CONFLICT"))
            {
                Ok(MergeRebaseResult {
                    status: "conflicts".into(),
                    message: err,
                })
            } else {
                Err(err)
            }
        }
    }
}
