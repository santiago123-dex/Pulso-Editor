//! Qué herramientas de IA hay instaladas y con qué sesión, modelos y límites de uso.
use super::*;

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AiModelInfo {
    pub id: String,
    pub label: String,
    pub note: String,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AiTool {
    pub installed: bool,
    pub version: String,
    pub logged_in: bool,
    /// «claude.ai» (suscripción) o «console» (clave de API), según informa la herramienta.
    pub auth_method: String,
    /// Tipo de suscripción: pro, max…; vacío si no hay o no se sabe.
    pub plan: String,
    pub error: String,
    pub models: Vec<AiModelInfo>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct WindowQuota {
    pub used_percent: f64,
    pub resets_at: i64,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct CodexQuota {
    pub plan: String,
    pub five_hour: Option<WindowQuota>,
    pub seven_day: Option<WindowQuota>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AntigravityBucket {
    pub id: String,
    pub name: String,
    pub window: String,
    pub remaining_fraction: f64,
    pub reset_time: String,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AntigravityQuotaGroup {
    pub name: String,
    pub description: String,
    pub buckets: Vec<AntigravityBucket>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AntigravityUsage {
    pub groups: Vec<AntigravityQuotaGroup>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct ExtraUsage {
    pub codex: Option<CodexQuota>,
    pub antigravity: Option<AntigravityUsage>,
}

#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct AllAiTools {
    pub claude: AiTool,
    pub codex: AiTool,
    pub antigravity: AiTool,
    pub local: AiTool,
    /// Modelos de la nube con la clave de cada proveedor (catálogo de models.dev).
    pub cloud: AiTool,
}

/// Lee la salida JSON de `claude auth status`. No se devuelve el correo ni la organización: Pulso no los necesita.
pub fn parse_auth_status(text: &str) -> Option<(bool, String, String)> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let logged = v.get("loggedIn")?.as_bool()?;
    let method = v.get("authMethod").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let plan = v.get("subscriptionType").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some((logged, method, plan))
}

/// Interpreta `codex login status` sin exponer claves ni tokens.
pub fn parse_codex_login_status(ok: bool, text: &str) -> (bool, String, String) {
    let low = text.to_lowercase();
    if !ok || low.contains("not logged in") {
        return (false, String::new(), String::new());
    }
    if low.contains("api key") {
        return (true, "api_key".into(), "API".into());
    }
    if low.contains("chatgpt") {
        return (true, "chatgpt".into(), "ChatGPT".into());
    }
    (true, "codex".into(), "ChatGPT".into())
}

/// Comprueba si Gemini CLI tiene sesión OAuth local o clave configurada sin devolver credenciales.
pub fn gemini_auth_from(home: Option<&Path>, has_api_key: bool, has_vertex: bool) -> (bool, String, String) {
    if has_api_key {
        return (true, "api_key".into(), "API".into());
    }
    if has_vertex {
        return (true, "vertex".into(), "Vertex".into());
    }
    if let Some(dir) = home.map(|h| h.join(".gemini")) {
        let mut accounts_logged_out = false;
        let accounts = dir.join("google_accounts.json");
        if let Ok(raw) = std::fs::read_to_string(&accounts) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                match v.get("active").and_then(|x| x.as_str()).map(|s| s.trim().is_empty()) {
                    Some(false) => return (true, "google".into(), "Google".into()),
                    _ => accounts_logged_out = true,
                }
            }
        }
        let oauth = dir.join("oauth_creds.json");
        if std::fs::read_to_string(&oauth).ok().is_some_and(|s| {
            let t = s.trim();
            t.len() > 2 && t != "{}"
        }) {
            return (true, "google".into(), "Google".into());
        }
        if !accounts_logged_out {
            let settings = dir.join("settings.json");
            if let Ok(raw) = std::fs::read_to_string(&settings) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let kind = v.get("security")
                        .and_then(|s| s.get("auth"))
                        .and_then(|a| a.get("selectedType"))
                        .or_else(|| v.get("selectedAuthType"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    match kind {
                        "oauth-personal" | "login-with-google" => return (true, "google".into(), "Google".into()),
                        "gemini-api-key" => return (true, "api_key".into(), "API".into()),
                        "vertex-ai" => return (true, "vertex".into(), "Vertex".into()),
                        _ => {}
                    }
                }
            }
        }
    }
    (false, String::new(), String::new())
}

/// Modelos estándar (alias oficiales) de Claude Code para selección rápida en CLI.
pub fn claude_default_models() -> Vec<AiModelInfo> {
    vec![
        AiModelInfo {
            id: "sonnet".into(),
            label: "Claude Sonnet".into(),
            note: tr("Equilibrado y rápido para uso diario").into(),
        },
        AiModelInfo {
            id: "opus".into(),
            label: "Claude Opus".into(),
            note: tr("Máxima capacidad para tareas complejas").into(),
        },
        AiModelInfo {
            id: "haiku".into(),
            label: "Claude Haiku".into(),
            note: tr("Ultrarrápido y ligero").into(),
        },
        AiModelInfo {
            id: "fable".into(),
            label: "Claude Fable".into(),
            note: tr("Alias más reciente del plan").into(),
        },
    ]
}

pub fn detect_claude() -> AiTool {
    let program = claude_program();
    let version = match capture(&program, &["--version"], 15) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return AiTool { error: tr("No se encontró Claude Code en este equipo.").into(), ..Default::default() },
    };
    let mut tool = AiTool { installed: true, version, models: claude_default_models(), ..Default::default() };
    // Un fallo puntual (la herramienta renovando la sesión, otro proceso ocupado) no significa «sin sesión»: se reintenta una vez.
    let status = (0..2).find_map(|attempt| {
        if attempt > 0 { thread::sleep(Duration::from_millis(1500)); }
        capture(&program, &["auth", "status"], 20).ok().and_then(|t| parse_auth_status(&t))
    });
    match status {
        Some((logged, method, plan)) => { tool.logged_in = logged; tool.auth_method = method; tool.plan = plan; }
        None => tool.error = tr("No se pudo comprobar si hay una sesión iniciada.").into(),
    }
    tool
}

/// Detecta una herramienta CLI concreta (`claude`, `codex`, `antigravity`) sin depender de Tauri.
pub fn detect_cli_provider(provider: &str) -> AiTool {
    match provider {
        "codex" => detect_codex(),
        "antigravity" | "gemini" => detect_antigravity(),
        _ => detect_claude(),
    }
}

/// Lista modelos disponibles para un proveedor CLI (`claude`, `codex`, `antigravity`).
pub fn list_cli_models(provider: &str) -> Vec<AiModelInfo> {
    match provider {
        "claude" => claude_default_models(),
        "codex" => {
            let cached = read_codex_models_from(user_home().as_deref());
            if !cached.is_empty() {
                return cached;
            }
            detect_codex().models
        }
        "antigravity" | "gemini" => detect_antigravity().models,
        _ => Vec::new(),
    }
}

/// Modelos de la nube: «conectado» si algún proveedor del catálogo tiene clave. Solo lee la copia local del catálogo, sin red.
pub(super) fn detect_cloud(app: &AppHandle) -> AiTool {
    let providers = crate::catalog::configured_providers(app);
    let mut tool = AiTool { installed: true, version: "models.dev".into(), ..Default::default() };
    if providers.is_empty() {
        return tool;
    }
    tool.logged_in = true;
    tool.auth_method = "api_key".into();
    tool.models = providers
        .iter()
        .flat_map(|p| {
            p.models.iter().take(40).map(move |m| {
                let ctx = if m.context >= 1000 { format!("{}k", m.context / 1000) } else { m.context.to_string() };
                let price = match (m.input_cost, m.output_cost) {
                    (Some(i), Some(o)) => format!(" · ${i}/${o}"),
                    _ => String::new(),
                };
                AiModelInfo { id: format!("{}/{}", p.id, m.id), label: format!("{} · {}", p.name, m.name), note: format!("{ctx}{price}") }
            })
        })
        .collect();
    tool
}

/// Extrae el texto de `claude -p /usage --output-format json` (campo `result`).
pub fn parse_usage_result(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    if v.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) { return None; }
    v.get("result")?.as_str().map(|s| s.to_string())
}
