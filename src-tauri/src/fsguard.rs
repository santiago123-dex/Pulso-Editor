//! Control de fronteras del sistema de archivos: restringe las operaciones del WebView
//! a la carpeta de trabajo autorizada, archivos abiertos explícitamente por CLI/diálogo
//! y directorios de solo lectura estrictamente permitidos (como extensiones de temas de VS Code).
use crate::i18n::{tr, trf};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
struct GuardInner {
    roots: HashMap<String, PathBuf>,
    extra_files: HashSet<PathBuf>,
    readonly_roots: Vec<PathBuf>,
    /// Carpetas de archivos de tema que la persona eligió con el diálogo del sistema (para resolver su `include`).
    theme_dirs: Vec<PathBuf>,
}

pub struct WorkspaceGuard {
    inner: Mutex<GuardInner>,
}

impl Default for WorkspaceGuard {
    fn default() -> Self {
        let mut readonly_roots = Vec::new();
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let ext = PathBuf::from(home).join(".vscode").join("extensions");
            if let Ok(c) = fs::canonicalize(&ext) {
                readonly_roots.push(c);
            } else {
                readonly_roots.push(ext);
            }
        }
        Self {
            inner: Mutex::new(GuardInner {
                roots: HashMap::new(),
                extra_files: HashSet::new(),
                readonly_roots,
                theme_dirs: Vec::new(),
            }),
        }
    }
}

/// Resuelve `path` a una ruta canónica incluso si el archivo o directorio final aún no existe,
/// canonizando el ancestro existente más profundo y anexando los segmentos restantes sin permitir `..`.
pub fn resolve_safe(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err(tr("La ruta está vacía").into());
    }
    if let Ok(canon) = fs::canonicalize(path) {
        return Ok(canon);
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    loop {
        if let Ok(canon) = fs::canonicalize(cur) {
            let mut full = canon;
            for seg in missing.into_iter().rev() {
                full.push(seg);
            }
            return Ok(full);
        }
        let Some(name) = cur.file_name() else {
            return Err(tr("No se pudo resolver la ruta de forma segura").into());
        };
        // Rechazar cualquier intento de traversal en segmentos no resueltos.
        if name == ".." {
            return Err(tr("Ruta no permitida").into());
        }
        missing.push(name.to_os_string());
        cur = cur.parent().ok_or_else(|| tr("No se pudo resolver la ruta de forma segura").to_string())?;
    }
}

fn has_parent_traversal(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

fn is_within(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

impl WorkspaceGuard {
    /// Fija la carpeta de trabajo activa de la ventana principal (o la limpia si `path` es `None`).
    pub fn set_root(&self, path: Option<&str>) -> Result<Option<PathBuf>, String> {
        self.set_root_for("main", path)
    }

    /// Fija la carpeta de trabajo activa de una ventana concreta (permite varias ventanas en paralelo).
    pub fn set_root_for(&self, label: &str, path: Option<&str>) -> Result<Option<PathBuf>, String> {
        let mut g = self.inner.lock().map_err(|e| e.to_string())?;
        match path {
            None => {
                g.roots.remove(label);
                Ok(None)
            }
            Some(raw) => {
                let p = Path::new(raw);
                if has_parent_traversal(p) {
                    return Err(tr("La ruta del espacio de trabajo no es válida").into());
                }
                let canon = fs::canonicalize(p).map_err(|e| trf("No se pudo abrir la carpeta: {e}", &[("e", &e)]))?;
                if !canon.is_dir() {
                    return Err(tr("La ruta indicada no es una carpeta").into());
                }
                g.roots.insert(label.to_string(), canon.clone());
                Ok(Some(canon))
            }
        }
    }

    /// Libera la carpeta autorizada al cerrarse una ventana.
    pub fn remove_window(&self, label: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.roots.remove(label);
        }
    }

    /// Autoriza un archivo individual abierto explícitamente por CLI o diálogo nativo.
    pub fn allow_file(&self, path: &Path) {
        if has_parent_traversal(path) {
            return;
        }
        if let Ok(canon) = resolve_safe(path) {
            if let Ok(mut g) = self.inner.lock() {
                g.extra_files.insert(canon);
            }
        }
    }

    pub fn current_root(&self) -> Option<PathBuf> {
        self.inner.lock().ok().and_then(|g| g.roots.get("main").cloned().or_else(|| g.roots.values().next().cloned()))
    }

    /// Verifica que `path` esté autorizado para lectura.
    pub fn ensure_read(&self, raw: &str) -> Result<PathBuf, String> {
        let p = Path::new(raw);
        if has_parent_traversal(p) {
            return Err(tr("Acceso denegado: ruta fuera del espacio de trabajo").into());
        }
        let resolved = resolve_safe(p)?;
        let g = self.inner.lock().map_err(|e| e.to_string())?;
        if g.roots.values().any(|root| is_within(&resolved, root)) {
            return Ok(resolved);
        }
        if g.extra_files.contains(&resolved) {
            return Ok(resolved);
        }
        if g.readonly_roots.iter().any(|r| is_within(&resolved, r)) {
            return Ok(resolved);
        }
        Err(tr("Acceso denegado: la ruta está fuera del espacio de trabajo abierto").into())
    }

    /// Recuerda la carpeta del tema que la persona acaba de elegir, para que se pueda leer él y lo que incluya.
    pub fn allow_theme_dir(&self, dir: &Path) {
        if let (Ok(canon), Ok(mut g)) = (resolve_safe(dir), self.inner.lock()) {
            if !g.theme_dirs.contains(&canon) {
                g.theme_dirs.push(canon);
            }
        }
    }

    /// Lectura de un archivo de tema: el espacio de trabajo, los temas de VS Code instalados o una carpeta elegida con el diálogo.
    pub fn ensure_theme_read(&self, raw: &str) -> Result<PathBuf, String> {
        if let Ok(p) = self.ensure_read(raw) {
            return Ok(p);
        }
        let p = Path::new(raw);
        if has_parent_traversal(p) {
            return Err(tr("Acceso denegado: ruta fuera del espacio de trabajo").into());
        }
        let resolved = resolve_safe(p)?;
        let g = self.inner.lock().map_err(|e| e.to_string())?;
        if g.theme_dirs.iter().any(|d| is_within(&resolved, d)) {
            return Ok(resolved);
        }
        Err(tr("Acceso denegado: la ruta está fuera del espacio de trabajo abierto").into())
    }

    /// Verifica que `path` esté autorizado para escritura o mutación.
    /// Si es un enlace simbólico, también verifica que el destino canonizado siga dentro del límite.
    pub fn ensure_write(&self, raw: &str) -> Result<PathBuf, String> {
        let p = Path::new(raw);
        if has_parent_traversal(p) {
            return Err(tr("Escritura denegada: ruta no permitida").into());
        }
        let resolved = resolve_safe(p)?;
        let g = self.inner.lock().map_err(|e| e.to_string())?;
        if g.roots.values().any(|root| is_within(&resolved, root)) {
            return Ok(resolved);
        }
        if g.extra_files.contains(&resolved) {
            return Ok(resolved);
        }
        Err(tr("Escritura denegada: la ruta está fuera del espacio de trabajo abierto").into())
    }

    /// Verifica que `raw` sea el propio workspace o un subdirectorio dentro de él.
    pub fn ensure_dir(&self, raw: &str) -> Result<PathBuf, String> {
        let resolved = self.ensure_write(raw)?;
        if !resolved.is_dir() {
            return Err(tr("La ruta no es una carpeta válida").into());
        }
        Ok(resolved)
    }

    /// Para pruebas unitarias: permite inyectar una raíz de solo lectura adicional.
    #[cfg(test)]
    pub fn with_readonly(self, dir: PathBuf) -> Self {
        if let Ok(mut g) = self.inner.lock() {
            g.readonly_roots.push(dir);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "pulso-fsguard-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn bloquea_lectura_y_escritura_fuera_del_workspace() {
        let ws = tmp_dir("ws");
        let outside = tmp_dir("out");
        let inside_file = ws.join("a.txt");
        let outside_file = outside.join("secret.txt");
        fs::write(&inside_file, "ok").unwrap();
        fs::write(&outside_file, "nope").unwrap();

        let guard = WorkspaceGuard::default();
        assert!(guard.ensure_read(&inside_file.to_string_lossy()).is_err());

        guard.set_root(Some(&ws.to_string_lossy())).unwrap();
        assert!(guard.ensure_read(&inside_file.to_string_lossy()).is_ok());
        assert!(guard.ensure_write(&ws.join("sub/nuevo.ts").to_string_lossy()).is_ok());
        assert!(guard.ensure_read(&outside_file.to_string_lossy()).is_err());
        assert!(guard.ensure_write(&outside_file.to_string_lossy()).is_err());
        assert!(guard.ensure_read(&format!("{}/../out/secret.txt", ws.display())).is_err());

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn permite_solo_lectura_en_readonly_roots_y_archivo_extra() {
        let ws = tmp_dir("ws2");
        let ro = tmp_dir("ro");
        let extra = tmp_dir("extra");
        let ro_file = ro.join("theme.json");
        let extra_file = extra.join("cli.ts");
        fs::write(&ro_file, "{}").unwrap();
        fs::write(&extra_file, "1").unwrap();

        let guard = WorkspaceGuard::default().with_readonly(fs::canonicalize(&ro).unwrap());
        guard.set_root(Some(&ws.to_string_lossy())).unwrap();
        guard.allow_file(&extra_file);

        assert!(guard.ensure_read(&ro_file.to_string_lossy()).is_ok());
        assert!(guard.ensure_write(&ro_file.to_string_lossy()).is_err());
        assert!(guard.ensure_read(&extra_file.to_string_lossy()).is_ok());
        assert!(guard.ensure_write(&extra_file.to_string_lossy()).is_ok());

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&ro);
        let _ = fs::remove_dir_all(&extra);
    }

    #[cfg(unix)]
    #[test]
    fn rechaza_symlink_que_escapa_del_workspace() {
        let ws = tmp_dir("ws-sym");
        let outside = tmp_dir("out-sym");
        let target = outside.join("passwd");
        fs::write(&target, "root").unwrap();
        let link = ws.join("escape.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let guard = WorkspaceGuard::default();
        guard.set_root(Some(&ws.to_string_lossy())).unwrap();
        assert!(guard.ensure_read(&link.to_string_lossy()).is_err());
        assert!(guard.ensure_write(&link.to_string_lossy()).is_err());

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }
}
