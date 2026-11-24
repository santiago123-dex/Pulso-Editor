//! Localizar y ejecutar los programas externos (Claude Code, Codex, Antigravity): rutas, Node y capturas de salida.
use super::*;

pub(super) fn capture_status(program: &str, args: &[String], secs: u64) -> Result<(bool, String), String> {
    let mut child =
        background_command(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let mut err = child.stderr.take().ok_or(tr("sin salida de error"))?;
    let r_out = thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let r_err = thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break st,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(tr("tardó demasiado").into());
            }
            None => thread::sleep(Duration::from_millis(30)),
        }
    };
    let stdout = r_out.join().unwrap_or_default();
    let stderr = r_err.join().unwrap_or_default();
    let combined = if stdout.trim().is_empty() { stderr } else { stdout };
    Ok((status.success(), combined))
}

pub(super) fn capture(program: &str, args: &[&str], secs: u64) -> Result<String, String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    capture_vec(program, &owned, secs)
}

pub(super) fn capture_vec(program: &str, args: &[String], secs: u64) -> Result<String, String> {
    let mut child =
        background_command(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or(tr("sin salida"))?;
    let reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(tr("tardó demasiado").into());
            }
            None => thread::sleep(Duration::from_millis(30)),
        }
    }
    Ok(reader.join().unwrap_or_default())
}

pub(super) fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Busca el punto de entrada JS de un paquete npm global (`package.json` → `bin`) para ejecutarlo con `node` sin pasar por `.cmd`.
pub fn npm_bin_js(npm_dir: &Path, pkg: &str, bin_name: &str) -> Option<PathBuf> {
    let mut pkg_dir = npm_dir.join("node_modules");
    for part in pkg.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        pkg_dir = pkg_dir.join(part);
    }
    let raw = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let rel = match v.get("bin")? {
        serde_json::Value::String(s) => s.as_str(),
        serde_json::Value::Object(map) => map.get(bin_name).and_then(|x| x.as_str())?,
        _ => return None,
    };
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let candidate = pkg_dir.join(rel_path);
    let canon_pkg = std::fs::canonicalize(&pkg_dir).ok()?;
    let canon_cand = std::fs::canonicalize(&candidate).ok()?;
    (canon_cand.starts_with(&canon_pkg) && canon_cand.is_file()).then_some(canon_cand)
}

pub(super) fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("agy").join("bin"));
        dirs.push(local.join("Programs").join("OpenAI").join("Codex").join("bin"));
        dirs.push(local.join("Microsoft").join("WindowsApps"));
        dirs.push(local.join("pnpm"));
        dirs.push(local.join("Programs").join("nodejs"));
    }
    for var in ["PNPM_HOME", "NVM_SYMLINK", "BUN_INSTALL"] {
        if let Some(v) = std::env::var_os(var) {
            let p = PathBuf::from(v);
            dirs.push(if var == "BUN_INSTALL" { p.join("bin") } else { p });
        }
    }
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    }
    if let Some(home) = user_home() {
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    dirs
}

pub fn node_program(hint_dir: &Path) -> String {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let sibling = hint_dir.join(exe);
    if sibling.is_file() {
        return sibling.to_string_lossy().into_owned();
    }
    for dir in extra_bin_dirs() {
        let c = dir.join(exe);
        if c.is_file() {
            return c.to_string_lossy().into_owned();
        }
    }
    if cfg!(windows) {
        for fixed in [r"C:\nvm4w\nodejs\node.exe", r"C:\Program Files\nodejs\node.exe", r"C:\Program Files (x86)\nodejs\node.exe"] {
            if Path::new(fixed).is_file() {
                return fixed.to_string();
            }
        }
    }
    "node".to_string()
}

/// Resuelve una CLI global buscando ejecutables nativos y paquetes npm `.js`/`.cmd` fuera del `PATH` heredado de GUI.
pub fn resolve_cli(name: &str, env_var: &str, npm_pkg: Option<&str>) -> (String, Vec<String>) {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var(env_var) {
            if !p.trim().is_empty() {
                return (p, Vec::new());
            }
        }
    }
    let dirs = extra_bin_dirs();
    if cfg!(windows) {
        let exe = format!("{name}.exe");
        for dir in &dirs {
            let p = dir.join(&exe);
            if p.is_file() {
                return (p.to_string_lossy().into_owned(), Vec::new());
            }
        }
        if let Some(pkg) = npm_pkg {
            for dir in &dirs {
                if let Some(js) = npm_bin_js(dir, pkg, name) {
                    return (node_program(dir), vec![js.to_string_lossy().into_owned()]);
                }
            }
        }
        for ext in ["cmd", "bat"] {
            let shim = format!("{name}.{ext}");
            for dir in &dirs {
                let p = dir.join(&shim);
                if p.is_file() {
                    return (p.to_string_lossy().into_owned(), Vec::new());
                }
            }
        }
    } else {
        for dir in &dirs {
            let p = dir.join(name);
            if p.is_file() {
                return (p.to_string_lossy().into_owned(), Vec::new());
            }
        }
    }
    (name.to_string(), Vec::new())
}

pub(super) fn with_prefix(prefix: &[String], rest: &[&str]) -> Vec<String> {
    let mut all = prefix.to_vec();
    all.extend(rest.iter().map(|s| s.to_string()));
    all
}
