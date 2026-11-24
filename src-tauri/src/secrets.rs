//! Almacén seguro de credenciales del sistema.
use super::*;

// ---------- Almacén seguro de credenciales del sistema ----------
pub(crate) const SECRET_SERVICE: &str = "pulso-editor";

pub(crate) fn ensure_allowed_secret_key(name: &str) -> Result<(), String> {
    if name == "github-token" {
        Ok(())
    } else {
        Err(tr("Clave de credencial no permitida").into())
    }
}

#[tauri::command]
pub(crate) async fn secret_get(name: String) -> Result<Option<String>, String> {
    ensure_allowed_secret_key(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SECRET_SERVICE, &name).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn secret_set(name: String, value: String) -> Result<(), String> {
    ensure_allowed_secret_key(&name)?;
    tauri::async_runtime::spawn_blocking(move || keyring::Entry::new(SECRET_SERVICE, &name).and_then(|e| e.set_password(&value)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn secret_delete(name: String) -> Result<(), String> {
    ensure_allowed_secret_key(&name)?;
    tauri::async_runtime::spawn_blocking(move || match keyring::Entry::new(SECRET_SERVICE, &name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}
