//! Imágenes adjuntas al chat: guardado, lectura y validación.
use super::*;

#[derive(Serialize, Debug, Clone)]
pub struct SavedImage {
    pub path: String,
    pub name: String,
}

pub(super) const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub(super) static IMG_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

pub(super) fn ext_for_image_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

pub(super) fn mime_for_image_ext(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

pub(super) fn validate_images(images: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in images.unwrap_or_default().into_iter().take(5) {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        let meta = std::fs::metadata(p).map_err(|_| tr("No se encontró la imagen adjunta.").to_string())?;
        if !meta.is_file() {
            return Err(tr("No se encontró la imagen adjunta.").into());
        }
        if meta.len() as usize > MAX_IMAGE_BYTES {
            return Err(tr("La imagen supera el límite de 10 MB.").into());
        }
        out.push(p.to_string());
    }
    Ok(out)
}
