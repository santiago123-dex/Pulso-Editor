//! Temas de VS Code instalados.
use super::*;

#[derive(Serialize)]
pub(crate) struct ThemeRef {
    pub(crate) label: String,
    pub(crate) dir: String,
    pub(crate) rel: String,
    pub(crate) ui: String,
    pub(crate) ext: String,
}

/// Busca los temas de color de las extensiones instaladas en VS Code.
#[tauri::command]
pub(crate) async fn scan_vscode_themes() -> Vec<ThemeRef> {
    tauri::async_runtime::spawn_blocking(scan_vscode_themes_sync)
        .await
        .unwrap_or_default()
}

pub(crate) fn scan_vscode_themes_sync() -> Vec<ThemeRef> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(Path::new(&home).join(".vscode").join("extensions")) else { return out };
    for e in rd.flatten() {
        let Ok(text) = fs::read_to_string(e.path().join("package.json")) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(themes) = v["contributes"]["themes"].as_array() else { continue };
        let ext = v["displayName"].as_str().or(v["name"].as_str()).unwrap_or("").to_string();
        for t in themes {
            let Some(rel) = t["path"].as_str() else { continue };
            let Some(label) = t["label"].as_str().or(t["id"].as_str()) else { continue };
            out.push(ThemeRef {
                label: label.to_string(),
                dir: norm(&e.path()),
                rel: rel.to_string(),
                ui: t["uiTheme"].as_str().unwrap_or("vs-dark").to_string(),
                ext: ext.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out
}
