//! Sincronización con el remoto (push y pull) con tiempo límite.
use super::*;

// ---------- Sincronización con el remoto ----------
pub(super) const NET_TIMEOUT_SECS: u64 = 120;

/// Ejecuta un comando con límite de tiempo: si queda esperando (por ejemplo, un inicio de sesión), se detiene.
pub(super) fn run_timeout(mut cmd: Command, secs: u64) -> Result<Output, String> {
    use std::{
        io::Read,
        thread,
        time::{Duration, Instant},
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::procguard::configure_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| trf("No se pudo ejecutar git: {e}", &[("e", &e)]))?;
    crate::procguard::attach_job(&child);
    let pid = child.id();
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let mut err = child.stderr.take().ok_or(tr("sin salida de error"))?;
    let t_out = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let t_err = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if Instant::now() >= deadline => {
                crate::procguard::kill_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                let _ = t_out.join();
                let _ = t_err.join();
                return Err(trf(
                    "La operación tardó más de {secs} s y se canceló. Si Git esperaba un inicio de sesión, inicia sesión desde una terminal y reinténtalo",
                    &[("secs", &secs)],
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    Ok(Output { status, stdout: t_out.join().unwrap_or_default(), stderr: t_err.join().unwrap_or_default() })
}

pub(super) fn run_net(top: &str, args: &[&str], secs: u64) -> Result<String, String> {
    let mut c = git_command(top);
    c.args(args);
    let o = run_timeout(c, secs)?;
    if o.status.success() {
        Ok(text(&o))
    } else {
        Err(text(&o))
    }
}

pub(super) fn current_branch(top: &str) -> Result<String, String> {
    let b = run(top, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if b == "HEAD" {
        return Err(tr("Estás en HEAD desacoplado: cambia a una rama antes de sincronizar").into());
    }
    Ok(b)
}

pub(super) fn push_sync(root: &str, secs: u64) -> Result<String, String> {
    let top = top_of(root)?;
    let branch = current_branch(&top)?;
    if succeeds(&top, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) {
        return run_net(&top, &["push"], secs);
    }
    if succeeds(&top, &["remote", "get-url", "origin"]) {
        return run_net(&top, &["push", "--set-upstream", "origin", &branch], secs);
    }
    Err(tr("Esta rama no tiene remoto. Añade uno con «git remote add origin <url>» en la terminal").into())
}

pub(super) fn pull_sync(root: &str, secs: u64) -> Result<String, String> {
    let top = top_of(root)?;
    current_branch(&top)?;
    match run_net(&top, &["pull", "--ff-only"], secs) {
        Ok(t) => Ok(t),
        Err(e) if e.contains("Not possible to fast-forward") || e.contains("divergent") => Err(trf(
            "{e}\n\nTu rama y la remota tienen cambios distintos. Pulso solo trae cambios que se pueden aplicar sin mezclar; resuélvelo en la terminal (git pull --rebase o git merge).",
            &[("e", &e)],
        )),
        Err(e) if e.contains("no tracking information") => {
            Err(tr("Esta rama no sigue a ninguna rama remota. Haz push primero para crearla en el remoto").into())
        }
        Err(e) => Err(e),
    }
}
