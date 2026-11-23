//! Catálogo de proveedores y modelos de [models.dev](https://models.dev) y las claves de cada proveedor.
//!
//! - El catálogo se descarga una vez (sin enviar nada de la persona), se guarda en disco y se renueva cada 24 horas.
//!   Sin conexión se usa la copia.
//! - De los más de 300 proveedores solo se ofrecen los que Pulso sabe usar (protocolo compatible con OpenAI o el de Anthropic)
//!   y de sus modelos solo los que admiten herramientas: sin ellas no hay agente.
//! - Las claves van al almacén de credenciales del sistema. **La ventana nunca recibe una clave**: solo sabe si hay una.
//!   Una clave solo se envía a la dirección del propio proveedor, por HTTPS.
use crate::i18n::tr;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, State};

const CATALOG_URL: &str = "https://models.dev/api.json";
const MAX_CATALOG_BYTES: usize = 24 * 1024 * 1024;
const REFRESH_AFTER_SECS: u64 = 24 * 60 * 60;
const SECRET_SERVICE: &str = "pulso-editor";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// `/chat/completions` con `tool_calls` (OpenAI y unos 280 proveedores más).
    OpenAi,
    /// `/messages` de Anthropic.
    Anthropic,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub context: u64,
    pub output: u64,
    pub reasoning: bool,
    pub images: bool,
    pub open_weights: bool,
    /// Dólares por millón de tokens.
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
    pub release: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    pub doc: String,
    pub env: Vec<String>,
    pub protocol: Protocol,
    pub base_url: String,
    pub models: Vec<ModelEntry>,
}

/// Direcciones de los proveedores que el catálogo no trae (usan su SDK propio, pero todos exponen `/chat/completions`).
const KNOWN_BASES: &[(&str, Protocol, &str)] = &[
    ("openai", Protocol::OpenAi, "https://api.openai.com/v1"),
    ("anthropic", Protocol::Anthropic, "https://api.anthropic.com/v1"),
    ("google", Protocol::OpenAi, "https://generativelanguage.googleapis.com/v1beta/openai"),
    ("groq", Protocol::OpenAi, "https://api.groq.com/openai/v1"),
    ("mistral", Protocol::OpenAi, "https://api.mistral.ai/v1"),
    ("xai", Protocol::OpenAi, "https://api.x.ai/v1"),
    ("togetherai", Protocol::OpenAi, "https://api.together.xyz/v1"),
    ("cerebras", Protocol::OpenAi, "https://api.cerebras.ai/v1"),
    ("deepinfra", Protocol::OpenAi, "https://api.deepinfra.com/v1/openai"),
    ("perplexity", Protocol::OpenAi, "https://api.perplexity.ai"),
    ("cohere", Protocol::OpenAi, "https://api.cohere.ai/compatibility/v1"),
];

/// Una dirección es segura para mandarle una clave: HTTPS (o `http` solo en esta misma máquina), sin credenciales dentro.
pub fn is_safe_base(url: &str) -> bool {
    if url.len() > 300 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else { return false };
    let host_part = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_part.is_empty() || host_part.contains('@') {
        return false;
    }
    let host = host_part.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host_part }).unwrap_or(host_part);
    match scheme {
        "https" => true,
        "http" => matches!(host.trim_matches(['[', ']']), "localhost" | "127.0.0.1" | "::1"),
        _ => false,
    }
}

fn endpoint_for(id: &str, npm: &str, api: Option<&str>) -> Option<(Protocol, String)> {
    let protocol = if npm.contains("anthropic") && !npm.contains("vertex") { Protocol::Anthropic } else { Protocol::OpenAi };
    if let Some(a) = api.map(str::trim).filter(|a| !a.is_empty()) {
        // Los que declaran dirección usan el protocolo de su SDK; Vertex, Bedrock y Azure no se pueden usar con una clave simple.
        let unsupported = ["bedrock", "vertex", "azure", "gitlab", "watsonx", "sap-ai"].iter().any(|n| npm.contains(n));
        return (!unsupported && is_safe_base(a)).then(|| (protocol, a.trim_end_matches('/').to_string()));
    }
    KNOWN_BASES.iter().find(|(k, _, _)| *k == id).map(|(_, p, b)| (*p, (*b).to_string()))
}

fn num(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).unwrap_or(0)
}

fn parse_model(id: &str, m: &Value) -> Option<ModelEntry> {
    if m["tool_call"].as_bool() != Some(true) {
        return None;
    }
    // Los modelos retirados ya no responden.
    if m["status"].as_str() == Some("deprecated") {
        return None;
    }
    let images = m["modalities"]["input"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some("image")));
    Some(ModelEntry {
        id: id.to_string(),
        name: m["name"].as_str().unwrap_or(id).to_string(),
        context: num(&m["limit"]["context"]),
        output: num(&m["limit"]["output"]),
        reasoning: m["reasoning"].as_bool().unwrap_or(false),
        images,
        open_weights: m["open_weights"].as_bool().unwrap_or(false),
        input_cost: m["cost"]["input"].as_f64(),
        output_cost: m["cost"]["output"].as_f64(),
        release: m["release_date"].as_str().unwrap_or("").to_string(),
    })
}

/// Interpreta `api.json`. Deja solo los proveedores utilizables y, en cada uno, los modelos con herramientas (los más nuevos primero).
pub fn parse_catalog(v: &Value) -> Vec<ProviderEntry> {
    let Some(map) = v.as_object() else { return Vec::new() };
    let mut out: Vec<ProviderEntry> = map
        .iter()
        .filter_map(|(key, p)| {
            let id = p["id"].as_str().unwrap_or(key);
            if !valid_id(id) {
                return None;
            }
            let (protocol, base_url) = endpoint_for(id, p["npm"].as_str().unwrap_or(""), p["api"].as_str())?;
            let mut models: Vec<ModelEntry> = p["models"].as_object()?.iter().filter_map(|(mid, m)| parse_model(m["id"].as_str().unwrap_or(mid), m)).collect();
            if models.is_empty() {
                return None;
            }
            models.sort_by(|a, b| b.release.cmp(&a.release).then(a.name.cmp(&b.name)));
            Some(ProviderEntry {
                id: id.to_string(),
                name: p["name"].as_str().unwrap_or(id).to_string(),
                doc: p["doc"].as_str().unwrap_or("").to_string(),
                env: p["env"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                protocol,
                base_url,
                models,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Identificador de proveedor válido: se usa en el nombre de la entrada del llavero y en archivos.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.'))
}

// ---------- Estado, copia en disco y descarga ----------

#[derive(Default)]
pub struct CatalogState {
    loaded: Mutex<Option<Arc<Vec<ProviderEntry>>>>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn cache_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("models-dev.json"))
}

fn index_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("providers.json"))
}

fn file_age_secs(p: &Path) -> Option<u64> {
    let modified = std::fs::metadata(p).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok().map(|d| d.as_secs())
}

/// Catálogo de la copia en disco, sin red. `None` si todavía no hay copia.
pub fn load_cached(app: &AppHandle) -> Option<Arc<Vec<ProviderEntry>>> {
    if let Some(c) = app.state::<CatalogState>().loaded.lock().ok().and_then(|g| g.clone()) {
        return Some(c);
    }
    let text = std::fs::read_to_string(cache_file(app).ok()?).ok()?;
    let parsed = Arc::new(parse_catalog(&serde_json::from_str::<Value>(&text).ok()?));
    if parsed.is_empty() {
        return None;
    }
    if let Ok(mut g) = app.state::<CatalogState>().loaded.lock() {
        *g = Some(parsed.clone());
    }
    Some(parsed)
}

async fn download() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(CATALOG_URL).send().await.map_err(|e| crate::i18n::trf("No se pudo descargar el catálogo de modelos: {e}", &[("e", &e)]))?;
    if !res.status().is_success() {
        return Err(crate::i18n::trf("models.dev respondió {status}", &[("status", &res.status().as_u16())]));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(tr("El catálogo de modelos es demasiado grande.").into());
    }
    Ok(bytes.to_vec())
}

/// Catálogo listo para usar: la copia si es reciente; si no, lo descarga (y si no hay red, la copia vieja).
pub async fn ensure(app: &AppHandle, force: bool) -> Result<(Arc<Vec<ProviderEntry>>, Option<String>), String> {
    let file = cache_file(app)?;
    let fresh = !force && file_age_secs(&file).is_some_and(|a| a < REFRESH_AFTER_SECS);
    if fresh {
        if let Some(c) = load_cached(app) {
            return Ok((c, None));
        }
    }
    match download().await {
        Ok(bytes) => {
            let parsed = serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?;
            let list = Arc::new(parse_catalog(&parsed));
            if list.is_empty() {
                return Err(tr("El catálogo de modelos no tiene proveedores utilizables.").into());
            }
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = crate::write_atomic(&file, &bytes);
            if let Ok(mut g) = app.state::<CatalogState>().loaded.lock() {
                *g = Some(list.clone());
            }
            Ok((list, None))
        }
        Err(e) => match load_cached(app) {
            Some(c) => Ok((c, Some(e))),
            None => Err(e),
        },
    }
}

// ---------- Claves ----------

fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, &format!("provider-key:{id}")).map_err(|e| e.to_string())
}

fn env_key(env: &[String]) -> Option<String> {
    env.iter().find_map(|name| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
}

/// Clave de un proveedor: la guardada en el almacén de credenciales o, si no hay, la variable de entorno que declara el catálogo.
pub fn get_key(provider: &ProviderEntry) -> Option<String> {
    if let Ok(entry) = key_entry(&provider.id) {
        if let Ok(k) = entry.get_password() {
            if !k.trim().is_empty() {
                return Some(k);
            }
        }
    }
    env_key(&provider.env)
}

fn read_index(app: &AppHandle) -> BTreeSet<String> {
    index_file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .map(|v| v.into_iter().filter(|id| valid_id(id)).collect())
        .unwrap_or_default()
}

fn write_index(app: &AppHandle, ids: &BTreeSet<String>) -> Result<(), String> {
    let file = index_file(app)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let list: Vec<&String> = ids.iter().collect();
    crate::write_atomic(&file, serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())
}

/// ¿Tiene clave este proveedor (guardada por Pulso o en una variable de entorno)?
pub fn has_key(app: &AppHandle, provider: &ProviderEntry) -> bool {
    (read_index(app).contains(&provider.id) && key_entry(&provider.id).ok().and_then(|e| e.get_password().ok()).is_some_and(|k| !k.trim().is_empty()))
        || env_key(&provider.env).is_some()
}

// ---------- Comandos ----------

#[derive(Serialize)]
pub struct ProviderBrief {
    pub id: String,
    pub name: String,
    pub doc: String,
    pub env: Vec<String>,
    pub models: usize,
    pub configured: bool,
    /// La clave sale de una variable de entorno, no del almacén de Pulso (no se puede borrar desde aquí).
    pub from_env: bool,
}

#[derive(Serialize)]
pub struct CatalogView {
    pub providers: Vec<ProviderBrief>,
    /// Aviso si no se pudo renovar y se usa la copia anterior.
    pub warning: Option<String>,
}

fn brief(app: &AppHandle, p: &ProviderEntry) -> ProviderBrief {
    let stored = read_index(app).contains(&p.id) && key_entry(&p.id).ok().and_then(|e| e.get_password().ok()).is_some_and(|k| !k.trim().is_empty());
    let from_env = !stored && env_key(&p.env).is_some();
    ProviderBrief { id: p.id.clone(), name: p.name.clone(), doc: p.doc.clone(), env: p.env.clone(), models: p.models.len(), configured: stored || from_env, from_env }
}

/// Proveedores utilizables, con si ya tienen clave. `refresh` fuerza la descarga.
#[tauri::command]
pub async fn catalog_get(app: AppHandle, refresh: Option<bool>) -> Result<CatalogView, String> {
    let (list, warning) = ensure(&app, refresh.unwrap_or(false)).await?;
    let app2 = app.clone();
    let providers = tauri::async_runtime::spawn_blocking(move || list.iter().map(|p| brief(&app2, p)).collect::<Vec<_>>()).await.map_err(|e| e.to_string())?;
    Ok(CatalogView { providers, warning })
}

fn find(list: &[ProviderEntry], id: &str) -> Result<ProviderEntry, String> {
    list.iter().find(|p| p.id == id).cloned().ok_or_else(|| tr("Proveedor desconocido.").to_string())
}

/// Guarda la clave de un proveedor en el almacén de credenciales. La ventana la manda una vez y no vuelve a verla.
#[tauri::command]
pub async fn provider_key_set(app: AppHandle, state: State<'_, CatalogState>, id: String, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() || key.len() > 1024 || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(tr("La clave no es válida.").into());
    }
    let list = state.loaded.lock().map_err(|e| e.to_string())?.clone().ok_or_else(|| tr("Carga primero el catálogo de modelos.").to_string())?;
    let provider = find(&list, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        key_entry(&provider.id)?.set_password(&key).map_err(|e| e.to_string())?;
        let mut ids = read_index(&app);
        ids.insert(provider.id);
        write_index(&app, &ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Borra la clave guardada de un proveedor.
#[tauri::command]
pub async fn provider_key_delete(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(tr("Proveedor desconocido.").into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        match key_entry(&id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
        let mut ids = read_index(&app);
        ids.remove(&id);
        write_index(&app, &ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Proveedores con clave, con sus modelos (para la lista de modelos del asistente). No descarga nada: usa la copia en disco.
pub fn configured_providers(app: &AppHandle) -> Vec<ProviderEntry> {
    let Some(list) = load_cached(app) else { return Vec::new() };
    list.iter().filter(|p| has_key(app, p)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "openai": { "id": "openai", "name": "OpenAI", "npm": "@ai-sdk/openai", "env": ["OPENAI_API_KEY"], "doc": "https://x", "models": {
                "gpt-viejo": { "id": "gpt-viejo", "name": "GPT viejo", "tool_call": true, "release_date": "2024-01-01", "limit": { "context": 8000, "output": 2000 } },
                "gpt-nuevo": { "id": "gpt-nuevo", "name": "GPT nuevo", "tool_call": true, "reasoning": true, "release_date": "2026-05-01",
                    "modalities": { "input": ["text", "image"] }, "limit": { "context": 400000, "output": 128000 }, "cost": { "input": 1.25, "output": 10 } },
                "sin-herramientas": { "id": "sin-herramientas", "name": "Sin", "tool_call": false, "release_date": "2026-06-01" },
                "retirado": { "id": "retirado", "name": "R", "tool_call": true, "status": "deprecated", "release_date": "2023-01-01" } } },
            "deepseek": { "id": "deepseek", "name": "DeepSeek", "npm": "@ai-sdk/openai-compatible", "api": "https://api.deepseek.com", "env": ["DEEPSEEK_API_KEY"],
                "models": { "chat": { "id": "chat", "name": "Chat", "tool_call": true, "release_date": "2025-12-01" } } },
            "anthropic": { "id": "anthropic", "name": "Anthropic", "npm": "@ai-sdk/anthropic", "env": ["ANTHROPIC_API_KEY"],
                "models": { "c": { "id": "c", "name": "C", "tool_call": true, "release_date": "2026-01-01" } } },
            "amazon-bedrock": { "id": "amazon-bedrock", "name": "Bedrock", "npm": "@ai-sdk/amazon-bedrock", "env": ["AWS_ACCESS_KEY_ID"],
                "models": { "m": { "id": "m", "name": "M", "tool_call": true } } },
            "sin-nada": { "id": "sin-nada", "name": "Sin modelos", "npm": "@ai-sdk/openai-compatible", "api": "https://ok.test", "models": { "x": { "id": "x", "tool_call": false } } },
            "peligroso": { "id": "peligroso", "name": "Peligroso", "npm": "@ai-sdk/openai-compatible", "api": "http://evil.test/v1", "models": { "x": { "id": "x", "tool_call": true } } }
        })
    }

    #[test]
    fn deja_solo_proveedores_y_modelos_utilizables() {
        let list = parse_catalog(&sample());
        let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
        // Sin Bedrock (firma propia), sin el que no tiene modelos con herramientas, sin el de dirección insegura.
        assert_eq!(ids, ["anthropic", "deepseek", "openai"]);
        let openai = list.iter().find(|p| p.id == "openai").unwrap();
        assert_eq!((openai.protocol, openai.base_url.as_str()), (Protocol::OpenAi, "https://api.openai.com/v1"));
        // Más nuevo primero; sin retirados ni modelos sin herramientas.
        assert_eq!(openai.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["gpt-nuevo", "gpt-viejo"]);
        let m = &openai.models[0];
        assert!(m.reasoning && m.images);
        assert_eq!((m.context, m.output, m.input_cost, m.output_cost), (400000, 128000, Some(1.25), Some(10.0)));
        let anthropic = list.iter().find(|p| p.id == "anthropic").unwrap();
        assert_eq!((anthropic.protocol, anthropic.base_url.as_str()), (Protocol::Anthropic, "https://api.anthropic.com/v1"));
        assert_eq!(list.iter().find(|p| p.id == "deepseek").unwrap().base_url, "https://api.deepseek.com");
    }

    #[test]
    fn solo_se_manda_una_clave_a_direcciones_seguras() {
        assert!(is_safe_base("https://api.openai.com/v1"));
        assert!(is_safe_base("http://localhost:11434/v1"));
        assert!(is_safe_base("http://127.0.0.1:1234/v1"));
        assert!(is_safe_base("http://[::1]:8080/v1"));
        assert!(!is_safe_base("http://api.openai.com/v1"));
        assert!(!is_safe_base("http://localhost.evil.test/v1"));
        assert!(!is_safe_base("https://user:pass@api.openai.com/v1"));
        assert!(!is_safe_base("https://"));
        assert!(!is_safe_base("ftp://x.test"));
        assert!(!is_safe_base("https://a b.test"));
        assert!(!is_safe_base("javascript:alert(1)"));
    }

    #[test]
    fn los_identificadores_son_seguros_para_el_llavero() {
        assert!(valid_id("openai") && valid_id("ollama-cloud") && valid_id("a_b.c"));
        assert!(!valid_id("") && !valid_id("../x") && !valid_id("A") && !valid_id("a b") && !valid_id(&"a".repeat(65)));
    }

    #[test]
    fn un_catalogo_roto_no_hace_dano() {
        assert!(parse_catalog(&json!([])).is_empty());
        assert!(parse_catalog(&json!({ "x": { "models": 5 } })).is_empty());
        assert!(parse_catalog(&json!(null)).is_empty());
    }

    /// Con el catálogo real: `PULSO_TEST_MODELSDEV=ruta/api.json cargo test catalogo_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn catalogo_real() {
        let path = std::env::var("PULSO_TEST_MODELSDEV").expect("falta PULSO_TEST_MODELSDEV");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let list = parse_catalog(&v);
        let models: usize = list.iter().map(|p| p.models.len()).sum();
        println!("proveedores utilizables: {} de {}; modelos con herramientas: {models}", list.len(), v.as_object().unwrap().len());
        for id in ["openai", "anthropic", "google", "openrouter", "groq", "deepseek", "mistral", "xai"] {
            let p = list.iter().find(|p| p.id == id);
            println!("{id:12} {:?}", p.map(|p| (p.protocol, p.base_url.as_str(), p.models.len(), p.models.first().map(|m| m.id.as_str()))));
        }
        assert!(list.len() > 100 && models > 2000);
        assert!(list.iter().all(|p| is_safe_base(&p.base_url) && valid_id(&p.id)));
    }
}
