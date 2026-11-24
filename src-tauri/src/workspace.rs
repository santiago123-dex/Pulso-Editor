//! Carpeta de trabajo: elegirla, abrir ventanas nuevas y la línea de comandos `pulso`.
use super::*;

pub(crate) fn approved_store(app: &tauri::AppHandle) -> Result<fsguard::ApprovedStore, String> {
    Ok(fsguard::ApprovedStore(app.path().app_data_dir().map_err(|e| e.to_string())?.join("approved-folders.json")))
}

pub(crate) fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Aprueba una carpeta que la persona acaba de elegir (diálogo del sistema o línea de comandos): la recuerda en
/// esta sesión y en las siguientes. Rechaza las demasiado amplias (raíz de una unidad, carpeta personal…).
pub(crate) fn approve_folder(app: &tauri::AppHandle, guard: &fsguard::WorkspaceGuard, raw: &str) -> Result<PathBuf, String> {
    let canon = guard.approve_dir(raw)?;
    if let Some(why) = termui::broad_dir_reason(&canon, user_home_dir().as_deref()) {
        return Err(trf("No se puede usar como carpeta de trabajo: {why}.", &[("why", &why)]));
    }
    if let Ok(store) = approved_store(app) {
        let _ = store.add(&canon);
    }
    Ok(canon)
}

/// Fija la carpeta de trabajo de la ventana. La ventana no decide qué carpetas son válidas: solo se acepta una
/// que la persona aprobó con el diálogo del sistema o la línea de comandos. Una carpeta reciente de una sesión
/// anterior se reabre sin preguntar; cualquier otra pide una confirmación nativa que la ventana no puede saltarse.
#[tauri::command]
pub(crate) async fn set_workspace_root(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    guard: tauri::State<'_, fsguard::WorkspaceGuard>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(raw) = path.as_deref() {
        if !guard.is_dir_approved(raw) {
            let canon = std::fs::canonicalize(raw).map_err(|e| trf("No se pudo abrir la carpeta: {e}", &[("e", &e)]))?;
            if let Some(why) = termui::broad_dir_reason(&canon, user_home_dir().as_deref()) {
                return Err(trf("No se puede usar como carpeta de trabajo: {why}.", &[("why", &why)]));
            }
            let known = approved_store(&app).map(|s| s.contains(&canon)).unwrap_or(false);
            if !known {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                let msg = trf("Pulso quiere abrir esta carpeta, que no abriste antes con «Abrir carpeta»:\n\n{dir}\n\n¿La abres?", &[("dir", &norm(&canon))]);
                let (yes, no) = (tr("Abrir").to_string(), tr("Cancelar").to_string());
                let handle = app.clone();
                let ok = tauri::async_runtime::spawn_blocking(move || {
                    handle
                        .dialog()
                        .message(msg)
                        .title("Pulso Editor")
                        .kind(MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::OkCancelCustom(yes, no))
                        .blocking_show()
                })
                .await
                .map_err(|e| e.to_string())?;
                if !ok {
                    return Err(tr("Esta carpeta no está autorizada: ábrela con el diálogo «Abrir carpeta».").into());
                }
            }
            approve_folder(&app, &guard, &canon.to_string_lossy())?;
        }
    }
    let resolved = guard.set_root_approved(window.label(), path.as_deref())?;
    Ok(resolved.map(|p| norm(&p)))
}

/// Abre el diálogo del sistema para elegir una carpeta de trabajo. Se hace aquí y no en la ventana: la carpeta
/// elegida queda aprobada, y ninguna otra puede fijarse sin una confirmación.
#[tauri::command]
pub(crate) async fn pick_workspace_folder(app: tauri::AppHandle, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || handle.dialog().file().blocking_pick_folder()).await.map_err(|e| e.to_string())?;
    let Some(dir) = picked else { return Ok(None) };
    let path = dir.into_path().map_err(|e| e.to_string())?;
    let canon = approve_folder(&app, &guard, &path.to_string_lossy())?;
    Ok(Some(norm(&canon)))
}

pub(crate) fn encode_query_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) static WIN_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Abre una nueva ventana de Pulso Editor, opcionalmente apuntando directamente a una carpeta.
#[tauri::command]
pub(crate) async fn open_new_window(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let n = WIN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("win-{n}");
    let url = match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => format!("index.html?folder={}", encode_query_value(p)),
        None => "index.html".to_string(),
    };
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(PathBuf::from(url)))
        .title("Pulso Editor")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .decorations(false)
        .shadow(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn authorize_cli_targets(app: &tauri::AppHandle, guard: &fsguard::WorkspaceGuard, targets: &[cli::CliTarget]) {
    for t in targets {
        if t.kind == "file" {
            guard.allow_file(Path::new(&t.path));
        } else if t.kind == "dir" {
            // Una carpeta que la persona escribió en la terminal (`pulso carpeta`) cuenta como elegida por ella.
            let _ = approve_folder(app, guard, &t.path);
        }
    }
}

/// Argumentos con los que se lanzó este proceso (`pulso archivo`, `pulso -g archivo:línea`).
#[tauri::command]
pub(crate) fn cli_startup_targets(app: tauri::AppHandle, guard: tauri::State<'_, fsguard::WorkspaceGuard>) -> Vec<cli::CliTarget> {
    let targets = cli::startup_targets();
    authorize_cli_targets(&app, &guard, &targets);
    targets
}

/// Añade la carpeta del programa (donde está `pulso.exe`) al PATH del usuario, para escribir `pulso .` en cualquier terminal.
#[tauri::command]
pub(crate) async fn install_cli_command() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_cli_command_sync).await.map_err(|e| e.to_string())?
}

pub(crate) fn install_cli_command_sync() -> Result<String, String> {
    #[cfg(not(windows))]
    {
        return Ok(tr("En Linux y macOS el paquete ya instala el comando `pulso` en el PATH; no hace falta hacer nada más.").into());
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or(tr("No se encontró la carpeta del programa"))?.to_path_buf();
        if !dir.join("pulso.exe").exists() {
            return Err(tr("No se encontró pulso.exe junto a Pulso Editor (¿es una compilación de desarrollo?).").into());
        }
        let _ = std::fs::remove_file(dir.join("pulso.cmd"));
        let script = "$d = $args[0]; $p = [Environment]::GetEnvironmentVariable('Path','User'); $parts = @(); if ($p) { $parts = $p -split ';' | Where-Object { $_ }; }; if ($parts -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User'); 'added' } else { 'present' }";
        let out = background_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script, &dir.to_string_lossy()])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(trf("Listo: `pulso` quedó disponible en {dir}. Abre una terminal nueva para usarlo.", &[("dir", &dir.display())]))
    }
}
