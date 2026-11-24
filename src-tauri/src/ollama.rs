//! Ollama, el modelo local: dirección, detección y cómo se convierte uno de sus modelos en un `CloudModel` del agente.
//!
//! La conversación en sí la lleva el motor común (`agent.rs`) con el protocolo nativo de Ollama (`llm.rs`, `/api/chat`): así un modelo
//! local tiene las mismas herramientas, permisos, subagentes, skills, memoria, ganchos y MCP que uno de la nube.
use crate::aichat::{AiModelInfo, AiTool};
use crate::i18n::{tr, trf};
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_BASE: &str = "http://127.0.0.1:11434";

/// Dirección de Ollama: la habitual o, solo hacia este equipo, la de `PULSO_OLLAMA_URL` u `OLLAMA_HOST`.
pub fn base_url() -> String {
    for var in ["PULSO_OLLAMA_URL", "OLLAMA_HOST"] {
        if let Ok(raw) = std::env::var(var) {
            let raw = raw.trim().trim_end_matches('/');
            let url = if raw.starts_with("http://") { raw.to_string() } else { format!("http://{raw}") };
            if url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") {
                return url;
            }
        }
    }
    DEFAULT_BASE.to_string()
}

fn client(timeout: Option<Duration>) -> reqwest::Client {
    let mut b = reqwest::Client::builder().user_agent("Pulso-Editor");
    if let Some(t) = timeout {
        b = b.timeout(t);
    }
    b.build().unwrap_or_else(|_| reqwest::Client::new())
}

// ---------- Detección ----------

/// Ollama «instalado» = su servidor responde; «con sesión» = además tiene al menos un modelo descargado.
pub async fn detect_with(base: &str) -> AiTool {
    let c = client(Some(Duration::from_secs(3)));
    let version = match c.get(format!("{base}/api/version")).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().and_then(|v| v["version"].as_str().map(str::to_string)).unwrap_or_default(),
        _ => {
            return AiTool { error: tr("Ollama no está en marcha en este equipo (http://127.0.0.1:11434).").into(), ..Default::default() };
        }
    };
    let models = match c.get(format!("{base}/api/tags")).send().await {
        Ok(r) => r.json::<Value>().await.ok().map(|v| parse_models(&v)).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    AiTool {
        installed: true,
        version: format!("Ollama {version}").trim().to_string(),
        logged_in: !models.is_empty(),
        auth_method: "local".into(),
        plan: String::new(),
        error: if models.is_empty() {
            tr("Ollama no tiene ningún modelo descargado. Descarga uno con «ollama pull qwen2.5-coder:7b».").into()
        } else {
            String::new()
        },
        models,
    }
}

pub fn detect() -> AiTool {
    tauri::async_runtime::block_on(detect_with(&base_url()))
}

pub fn parse_models(v: &Value) -> Vec<AiModelInfo> {
    v["models"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m["name"].as_str().or_else(|| m["model"].as_str())?.to_string();
                    let size = m["details"]["parameter_size"].as_str().unwrap_or("").to_string();
                    let family = m["details"]["family"].as_str().unwrap_or("").to_string();
                    let note = [family, size].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
                    Some(AiModelInfo { label: id.clone(), id, note })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------- El modelo como modelo del agente ----------

/// Tope de la ventana de contexto que se pide por defecto: cada token de contexto cuesta memoria, y esto alcanza para las herramientas
/// del agente y para trabajar. Se puede cambiar con `PULSO_OLLAMA_NUM_CTX`.
const CONTEXT_CAP: u64 = 16_384;
/// Si Ollama no dice la ventana del modelo.
const CONTEXT_FALLBACK: u64 = 8_192;
const CONTEXT_MIN: u64 = 2_048;
const CONTEXT_MAX: u64 = 262_144;

/// Ventana de contexto que se usa: la que pida la persona, o la del modelo con un tope. Pura, para poder probarla sin tocar el entorno.
pub fn context_for(model_max: Option<u64>, requested: Option<u64>) -> u64 {
    match (requested, model_max) {
        (Some(n), _) => n.clamp(CONTEXT_MIN, CONTEXT_MAX),
        (None, Some(m)) => m.clamp(CONTEXT_MIN, CONTEXT_CAP),
        (None, None) => CONTEXT_FALLBACK,
    }
}

/// Lo que Ollama cuenta de un modelo (`/api/show`). `None` = no lo dice (versiones antiguas), y entonces no se presume nada.
#[derive(Debug, Default, PartialEq)]
pub struct ModelFacts {
    pub context: Option<u64>,
    pub tools: Option<bool>,
    pub vision: Option<bool>,
}

pub fn parse_show(v: &Value) -> ModelFacts {
    let context = v["model_info"].as_object().and_then(|m| m.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, v)| v.as_u64()));
    let caps: Option<Vec<&str>> = v["capabilities"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect());
    ModelFacts { context, tools: caps.as_ref().map(|c| c.contains(&"tools")), vision: caps.as_ref().map(|c| c.contains(&"vision")) }
}

/// Pregunta a Ollama por un modelo. Si no responde, devuelve «no se sabe nada»: el error de verdad saldrá al conversar.
pub async fn show(base: &str, model: &str) -> ModelFacts {
    let res = client(Some(Duration::from_secs(5))).post(format!("{base}/api/show")).json(&json!({ "model": model })).send().await;
    match res {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.map(|v| parse_show(&v)).unwrap_or_default(),
        _ => ModelFacts::default(),
    }
}

/// Un modelo de Ollama como modelo del agente. Falla si Ollama dice que no admite herramientas: sin ellas el agente no puede trabajar.
pub async fn cloud_model(base: &str, model: &str) -> Result<crate::agent::CloudModel, String> {
    let facts = show(base, model).await;
    if facts.tools == Some(false) {
        return Err(trf("El modelo «{model}» de Ollama no admite herramientas y el agente las necesita. Prueba con uno que sí las admita (por ejemplo qwen2.5-coder o llama3.1).", &[("model", &model)]));
    }
    let requested = std::env::var("PULSO_OLLAMA_NUM_CTX").ok().and_then(|v| v.trim().parse::<u64>().ok());
    Ok(crate::agent::CloudModel {
        provider_name: "Ollama".into(),
        protocol: crate::catalog::Protocol::Ollama,
        base_url: base.to_string(),
        key: String::new(),
        model: model.to_string(),
        images: facts.vision.unwrap_or(true),
        context: context_for(facts.context, requested),
        max_output: 0,
        input_cost: None,
        output_cost: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn lee_los_modelos_de_ollama() {
        let models = parse_models(&json!({ "models": [{ "name": "qwen2.5-coder:7b", "details": { "family": "qwen2", "parameter_size": "7.6B" } }] }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5-coder:7b");
        assert_eq!(models[0].note, "qwen2 · 7.6B");
    }

    #[test]
    fn lee_la_ventana_y_las_capacidades_de_un_modelo() {
        let v = json!({ "model_info": { "general.architecture": "qwen2", "qwen2.context_length": 32768 }, "capabilities": ["completion", "tools"] });
        assert_eq!(parse_show(&v), ModelFacts { context: Some(32768), tools: Some(true), vision: Some(false) });
        // Una versión antigua no dice nada: no se presume nada.
        assert_eq!(parse_show(&json!({})), ModelFacts::default());
        assert_eq!(parse_show(&json!({ "capabilities": ["completion", "vision"] })).tools, Some(false));
    }

    #[test]
    fn la_ventana_de_contexto_tiene_tope_pero_se_puede_pedir_otra() {
        assert_eq!(context_for(Some(131_072), None), CONTEXT_CAP);
        assert_eq!(context_for(Some(4_096), None), 4_096);
        assert_eq!(context_for(Some(100), None), CONTEXT_MIN);
        assert_eq!(context_for(None, None), CONTEXT_FALLBACK);
        assert_eq!(context_for(Some(4_096), Some(32_768)), 32_768);
        assert_eq!(context_for(None, Some(10)), CONTEXT_MIN);
        assert_eq!(context_for(None, Some(u64::MAX)), CONTEXT_MAX);
    }

    /// Ollama simulado: contesta a `/api/show` con este JSON (o con 404 si `body` es `None`).
    fn fake_show(body: Option<&'static str>) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = s.read(&mut buf).unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req).into_owned();
                if let Some(pos) = text.find("\r\n\r\n") {
                    let len = text[..pos]
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if req.len() >= pos + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let (status, payload) = match body {
                Some(b) => ("200 OK", b),
                None => ("404 Not Found", "{\"error\":\"model not found\"}"),
            };
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
            String::from_utf8_lossy(&req).into_owned()
        });
        (base, h)
    }

    #[test]
    fn convierte_un_modelo_de_ollama_en_un_modelo_del_agente() {
        let (base, server) = fake_show(Some(r#"{"model_info":{"llama.context_length":131072},"capabilities":["completion","tools","vision"]}"#));
        let m = tauri::async_runtime::block_on(cloud_model(&base, "llama3.2-vision")).unwrap();
        assert_eq!(
            (m.protocol, m.base_url.as_str(), m.model.as_str(), m.key.as_str()),
            (crate::catalog::Protocol::Ollama, base.as_str(), "llama3.2-vision", "")
        );
        assert_eq!((m.context, m.images, m.max_output, m.input_cost), (CONTEXT_CAP, true, 0, None));
        assert!(server.join().unwrap().starts_with("POST /api/show"));
    }

    #[test]
    fn rechaza_con_un_mensaje_claro_un_modelo_sin_herramientas() {
        let (base, _s) = fake_show(Some(r#"{"capabilities":["completion"]}"#));
        let e = tauri::async_runtime::block_on(cloud_model(&base, "gemma:2b")).err().expect("debe rechazarlo");
        assert!(e.contains("gemma:2b") && e.contains("herramientas"), "{e}");
    }

    #[test]
    fn si_ollama_no_responde_a_show_no_se_presume_nada_y_se_intenta() {
        let (base, _s) = fake_show(None);
        let m = tauri::async_runtime::block_on(cloud_model(&base, "viejo:1b")).unwrap();
        assert_eq!((m.context, m.images), (CONTEXT_FALLBACK, true));
    }
}
