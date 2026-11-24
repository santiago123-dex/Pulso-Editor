//! Sistema declarativo de extensiones: validación estricta de `manifest.json`,
//! carga/activación/desactivación y permisos explícitos desde la carpeta del usuario.
use crate::i18n::{tr, trf};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const ALLOWED_PERMISSIONS: [&str; 3] = ["files", "network", "terminal"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContrib {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnippetContrib {
    pub language: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandContrib {
    pub id: String,
    pub title: String,
    pub script: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LspContrib {
    pub language: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionContributes {
    #[serde(default)]
    pub themes: Vec<ThemeContrib>,
    #[serde(default)]
    pub snippets: Vec<SnippetContrib>,
    #[serde(default)]
    pub commands: Vec<CommandContrib>,
    #[serde(default)]
    pub language_servers: Vec<LspContrib>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: ExtensionContributes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    pub manifest: ExtensionManifest,
    pub enabled: bool,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInstallPreview {
    pub token: String,
    pub manifest: ExtensionManifest,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ExtensionsStateFile {
    enabled: HashMap<String, bool>,
}

/// Almacena rutas elegidas por diálogo nativo pendientes de confirmar por el usuario.
#[derive(Default)]
pub struct ExtensionState {
    pending_installs: Mutex<HashMap<String, PathBuf>>,
}

pub fn is_valid_ext_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_'))
}

fn is_valid_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn is_safe_relative_path(raw: &str) -> bool {
    if raw.trim().is_empty() {
        return false;
    }
    let p = Path::new(raw);
    if p.is_absolute() {
        return false;
    }
    !p.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

/// Valida estrictamente el contenido de un `manifest.json` de extensión declarativa.
pub fn validate_manifest(raw: &str) -> Result<ExtensionManifest, String> {
    let mut manifest: ExtensionManifest = serde_json::from_str(raw).map_err(|e| trf("Manifiesto de extensión no válido: {e}", &[("e", &e)]))?;

    if !is_valid_ext_id(&manifest.id) {
        return Err(tr("El identificador de la extensión debe tener entre 2 y 64 caracteres (minúsculas, números, ., - o _).").into());
    }
    if manifest.name.trim().is_empty() {
        return Err(tr("El manifiesto debe incluir un nombre de extensión.").into());
    }
    if !is_valid_semver(&manifest.version) {
        return Err(tr("La versión de la extensión debe usar el formato semántico X.Y.Z.").into());
    }

    let mut seen_perms = HashSet::new();
    let mut normalized_perms = Vec::new();
    for p in &manifest.permissions {
        let lower = p.trim().to_ascii_lowercase();
        if !ALLOWED_PERMISSIONS.contains(&lower.as_str()) {
            return Err(trf("Permiso de extensión no reconocido: «{perm}».", &[("perm", &lower)]));
        }
        if seen_perms.insert(lower.clone()) {
            normalized_perms.push(lower);
        }
    }
    manifest.permissions = normalized_perms;

    for theme in &manifest.contributes.themes {
        if theme.id.trim().is_empty() || theme.label.trim().is_empty() || !is_safe_relative_path(&theme.path) {
            return Err(tr("Un tema declarado en la extensión tiene datos o ruta no válidos.").into());
        }
    }
    for snip in &manifest.contributes.snippets {
        if snip.language.trim().is_empty() || !is_safe_relative_path(&snip.path) {
            return Err(tr("Un fragmento declarado en la extensión tiene datos o ruta no válidos.").into());
        }
    }
    if (!manifest.contributes.commands.is_empty() || !manifest.contributes.language_servers.is_empty()) && !seen_perms.contains("terminal") {
        return Err(tr("Las extensiones con comandos o servidores de lenguaje deben declarar el permiso «terminal».").into());
    }
    for cmd in &manifest.contributes.commands {
        if cmd.id.trim().is_empty() || cmd.title.trim().is_empty() || cmd.script.trim().is_empty() {
            return Err(tr("Un comando declarado en la extensión está incompleto.").into());
        }
    }
    for lsp in &manifest.contributes.language_servers {
        if lsp.language.trim().is_empty() || lsp.command.trim().is_empty() {
            return Err(tr("Un servidor de lenguaje declarado en la extensión está incompleto.").into());
        }
    }

    Ok(manifest)
}

fn extensions_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|h| PathBuf::from(h).join(".config")))
        .ok_or_else(|| tr("No se pudo localizar la carpeta de extensiones del usuario.").to_string())?;
    Ok(base.join("dev.pulso.editor").join("extensions"))
}

fn load_state_in(root: &Path) -> ExtensionsStateFile {
    let file = root.join("extensions-state.json");
    fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_state_in(root: &Path, st: &ExtensionsStateFile) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    fs::write(root.join("extensions-state.json"), json).map_err(|e| e.to_string())
}

pub fn list_extensions_in(root: &Path) -> Vec<InstalledExtension> {
    let state = load_state_in(root);
    let Ok(rd) = fs::read_dir(root) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("manifest.json");
        let Ok(raw) = fs::read_to_string(&manifest_path) else { continue };
        let Ok(manifest) = validate_manifest(&raw) else { continue };
        let enabled = state.enabled.get(&manifest.id).copied().unwrap_or(true);
        out.push(InstalledExtension { manifest, enabled, dir: crate::norm(&dir) });
    }
    out.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
    out
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn install_extension_into(root: &Path, src_dir: &Path) -> Result<InstalledExtension, String> {
    let raw = fs::read_to_string(src_dir.join("manifest.json")).map_err(|_| tr("La carpeta elegida no contiene un archivo manifest.json.").to_string())?;
    let manifest = validate_manifest(&raw)?;
    let dest = root.join(&manifest.id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(src_dir, &dest)?;
    let mut st = load_state_in(root);
    st.enabled.insert(manifest.id.clone(), true);
    save_state_in(root, &st)?;
    Ok(InstalledExtension { manifest, enabled: true, dir: crate::norm(&dest) })
}

pub fn set_enabled_in(root: &Path, id: &str, enabled: bool) -> Result<(), String> {
    if !is_valid_ext_id(id) {
        return Err(tr("Identificador de extensión no válido.").into());
    }
    let mut st = load_state_in(root);
    st.enabled.insert(id.to_string(), enabled);
    save_state_in(root, &st)
}

pub fn uninstall_extension_in(root: &Path, id: &str) -> Result<(), String> {
    if !is_valid_ext_id(id) {
        return Err(tr("Identificador de extensión no válido.").into());
    }
    let dir = root.join(id);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut st = load_state_in(root);
    st.enabled.remove(id);
    save_state_in(root, &st)
}

#[tauri::command]
pub fn ext_list() -> Result<Vec<InstalledExtension>, String> {
    let root = extensions_root()?;
    Ok(list_extensions_in(&root))
}

#[tauri::command]
pub fn ext_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    let root = extensions_root()?;
    set_enabled_in(&root, &id, enabled)
}

#[tauri::command]
pub fn ext_uninstall(id: String) -> Result<(), String> {
    let root = extensions_root()?;
    uninstall_extension_in(&root, &id)
}

#[tauri::command]
pub async fn ext_pick_for_install(app: tauri::AppHandle, state: State<'_, ExtensionState>) -> Result<Option<ExtensionInstallPreview>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder()).await.map_err(|e| e.to_string())?;
    let Some(folder) = picked else { return Ok(None) };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    let raw = fs::read_to_string(path.join("manifest.json")).map_err(|_| tr("La carpeta elegida no contiene un archivo manifest.json.").to_string())?;
    let manifest = validate_manifest(&raw)?;
    let token = format!("ext-{}-{}", manifest.id, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    state.pending_installs.lock().map_err(|e| e.to_string())?.insert(token.clone(), path);
    Ok(Some(ExtensionInstallPreview { token, manifest }))
}

#[tauri::command]
pub fn ext_confirm_install(state: State<'_, ExtensionState>, token: String) -> Result<InstalledExtension, String> {
    let src = state
        .pending_installs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&token)
        .ok_or_else(|| tr("La solicitud de instalación caducó; vuelve a seleccionar la carpeta.").to_string())?;
    let root = extensions_root()?;
    install_extension_into(&root, &src)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_strict_manifest_and_rejects_bad_permissions_or_paths() {
        let ok = r#"{
            "id": "pulso.aurora",
            "name": "Aurora",
            "version": "1.2.3",
            "permissions": ["files", "terminal"],
            "contributes": {
                "themes": [{"id": "a", "label": "A", "path": "themes/a.json"}],
                "commands": [{"id": "run", "title": "Run", "script": "echo ok"}]
            }
        }"#;
        let m = validate_manifest(ok).expect("manifiesto válido");
        assert_eq!(m.id, "pulso.aurora");
        assert_eq!(m.permissions, vec!["files", "terminal"]);

        // Ruta con traversal rechazada.
        let bad_path = r#"{"id":"pulso.bad","name":"Bad","version":"1.0.0","contributes":{"themes":[{"id":"a","label":"A","path":"../secret.json"}]}}"#;
        assert!(validate_manifest(bad_path).is_err());

        // Permiso desconocido rechazado.
        let bad_perm = r#"{"id":"pulso.bad","name":"Bad","version":"1.0.0","permissions":["root"]}"#;
        assert!(validate_manifest(bad_perm).is_err());

        // Comando sin permiso terminal rechazado.
        let missing_term =
            r#"{"id":"pulso.cmd","name":"Cmd","version":"1.0.0","permissions":["files"],"contributes":{"commands":[{"id":"c","title":"C","script":"ls"}]}}"#;
        assert!(validate_manifest(missing_term).is_err());
    }

    #[test]
    fn install_toggle_list_and_uninstall_roundtrip() {
        let base = std::env::temp_dir().join(format!("pulso-ext-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src_ext");
        let root = base.join("installed");
        fs::create_dir_all(src.join("themes")).unwrap();
        fs::write(
            src.join("manifest.json"),
            r#"{"id":"pulso.demo","name":"Demo Ext","version":"0.1.0","permissions":["files"],"contributes":{"themes":[{"id":"d","label":"Demo","path":"themes/d.json"}]}}"#,
        )
        .unwrap();
        fs::write(src.join("themes").join("d.json"), "{}").unwrap();

        let inst = install_extension_into(&root, &src).unwrap();
        assert!(inst.enabled);
        assert_eq!(list_extensions_in(&root).len(), 1);

        set_enabled_in(&root, "pulso.demo", false).unwrap();
        assert!(!list_extensions_in(&root)[0].enabled);

        uninstall_extension_in(&root, "pulso.demo").unwrap();
        assert!(list_extensions_in(&root).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn installs_bundled_example_extension_end_to_end() {
        let example_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/extension-ejemplo");
        assert!(example_dir.join("manifest.json").is_file(), "falta examples/extension-ejemplo/manifest.json");

        let root = std::env::temp_dir().join(format!("pulso-ext-e2e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let installed = install_extension_into(&root, &example_dir).expect("debe instalar la extensión de ejemplo");
        assert_eq!(installed.manifest.id, "pulso.ejemplo-aurora");
        assert!(installed.enabled);
        assert!(root.join("pulso.ejemplo-aurora/themes/aurora.json").is_file());
        assert!(root.join("pulso.ejemplo-aurora/snippets/typescript.json").is_file());

        set_enabled_in(&root, "pulso.ejemplo-aurora", false).unwrap();
        assert!(!list_extensions_in(&root)[0].enabled);

        uninstall_extension_in(&root, "pulso.ejemplo-aurora").unwrap();
        assert!(list_extensions_in(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
