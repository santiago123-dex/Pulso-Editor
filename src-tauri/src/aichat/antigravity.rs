//! Antigravity: modelos y uso.
use super::*;

/// Interpreta las líneas `<id>\t<etiqueta>` de `agy models`.
pub fn parse_agy_models(text: &str) -> Vec<AiModelInfo> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || !line.contains('\t') { continue; }
        let Some((id, label)) = line.split_once('\t') else { continue };
        let id = id.trim();
        let label = label.trim();
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) { continue; }
        let note = label.rsplit_once('(').and_then(|(_, r)| r.strip_suffix(')')).map(str::trim).unwrap_or("").to_string();
        if !out.iter().any(|x: &AiModelInfo| x.id == id) {
            out.push(AiModelInfo { id: id.to_string(), label: if label.is_empty() { id.to_string() } else { label.to_string() }, note });
        }
    }
    out
}

/// Extrae los grupos y cubos de cuota de `agy -p "/usage" --output-format json --mode plan`.
pub fn parse_agy_usage_json(text: &str) -> Option<AntigravityUsage> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()
        .or_else(|| text.lines().rev().find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok()))?;
    if v.get("status").and_then(|s| s.as_str()) != Some("SUCCESS") { return None; }
    let arr = v.get("command").and_then(|c| c.get("data")).and_then(|d| d.get("groups")).and_then(|g| g.as_array())?;
    let mut groups = Vec::new();
    for g in arr {
        let name = g.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() { continue; }
        let description = g.get("description").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let mut buckets = Vec::new();
        if let Some(bs) = g.get("buckets").and_then(|x| x.as_array()) {
            for b in bs {
                let id = b.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let bname = b.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let window = b.get("window").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let rem = b.get("remaining_fraction").and_then(|x| x.as_f64()).unwrap_or(1.0).clamp(0.0, 1.0);
                let reset_time = b.get("reset_time").and_then(|x| x.as_str()).unwrap_or("").to_string();
                buckets.push(AntigravityBucket { id, name: bname, window, remaining_fraction: rem, reset_time });
            }
        }
        groups.push(AntigravityQuotaGroup { name, description, buckets });
    }
    (!groups.is_empty()).then_some(AntigravityUsage { groups })
}

pub(super) fn detect_antigravity() -> AiTool {
    let (program, prefix) = resolve_cli("agy", "PULSO_AGY_BIN", None);
    let version = match capture_vec(&program, &with_prefix(&prefix, &["--version"]), 12) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: tr("No se encontró Antigravity CLI (`agy`) en este equipo.").into(), ..Default::default() },
    };
    let mut tool = AiTool { installed: true, version, ..Default::default() };
    match capture_status(&program, &with_prefix(&prefix, &["models"]), 20) {
        Ok((ok, text)) => {
            let models = parse_agy_models(&text);
            if !models.is_empty() {
                tool.logged_in = true;
                tool.auth_method = "google".into();
                tool.plan = "Antigravity".into();
                tool.models = models;
                return tool;
            }
            let low = text.to_lowercase();
            if !ok && (low.contains("login") || low.contains("auth") || low.contains("unauthorized") || low.contains("credential")) {
                return tool;
            }
        }
        Err(_) => {}
    }
    // Respaldo rápido si `agy models` falló por red temporal pero la cuenta sigue conectada localmente.
    let (logged, method, plan) = gemini_auth_from(user_home().as_deref(), false, false);
    tool.logged_in = logged;
    tool.auth_method = method;
    if logged { tool.plan = if plan == "Google" { "Antigravity".into() } else { plan }; }
    tool
}

pub(super) fn read_antigravity_usage() -> Option<AntigravityUsage> {
    let (program, prefix) = resolve_cli("agy", "PULSO_AGY_BIN", None);
    let args = with_prefix(&prefix, &["-p", "/usage", "--output-format", "json", "--mode", "plan"]);
    let out = capture_vec(&program, &args, 20).ok()?;
    parse_agy_usage_json(&out)
}
