//! Actualizaciones automáticas: busca `latest.json` en las releases de GitHub (ver `plugins.updater`
//! en tauri.conf.json), comprueba la firma con la clave pública y, si la persona acepta, instala y reinicia.
//! Solo en la versión instalada: las compilaciones de desarrollo no se actualizan.
use crate::i18n::{tr, trf};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

fn ensure_installed() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(tr("Las actualizaciones solo funcionan en la versión instalada de Pulso.").into());
    }
    Ok(())
}

async fn find(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app.updater().map_err(|e| trf("No se pudo preparar el actualizador: {e}", &[("e", &e)]))?;
    updater
        .check()
        .await
        .map_err(|e| trf("No se pudo comprobar si hay una versión nueva: {e}", &[("e", &e)]))
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    ensure_installed()?;
    Ok(find(&app).await?.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Descarga, verifica e instala la versión nueva y reinicia Pulso. En Windows el instalador
/// cierra la aplicación por su cuenta, así que antes se detienen terminales, LSP y procesos de IA.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    ensure_installed()?;
    let update = find(&app)
        .await?
        .ok_or_else(|| tr("Ya no hay ninguna versión nueva pendiente.").to_string())?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| trf("No se pudo descargar la actualización: {e}", &[("e", &e)]))?;
    app.state::<crate::term::TermState>().kill_all();
    app.state::<crate::lsp::LspState>().stop();
    app.state::<crate::aichat::AiState>().stop_all();
    update
        .install(bytes)
        .map_err(|e| trf("No se pudo instalar la actualización: {e}", &[("e", &e)]))?;
    app.restart();
}
