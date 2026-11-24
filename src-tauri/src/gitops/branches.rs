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
