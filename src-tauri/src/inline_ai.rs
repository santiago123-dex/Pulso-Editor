//! Autocompletado de IA en línea (texto fantasma) usando Ollama local (`/api/generate` con FIM).
use crate::localai;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_PREFIX_CHARS: usize = 3500;
const MAX_SUFFIX_CHARS: usize = 1200;

fn clip_tail(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().skip(count - max_chars).collect()
}

fn clip_head(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Elige el modelo más adecuado para autocompletado de código entre los instalados en Ollama.
pub fn pick_best_model(models: &[String]) -> Option<String> {
    const PREFERRED: [&str; 6] = [
        "qwen2.5-coder",
        "qwen3-coder",
        "deepseek-coder",
        "starcoder",
        "codellama",
        "coder",
    ];
    for pref in PREFERRED {
        if let Some(found) = models.iter().find(|m| m.to_lowercase().contains(pref)) {
            return Some(found.clone());
        }
    }
    models.first().cloned()
}

/// Limpia vallas Markdown accidentales y solapamiento al final con el sufijo inmediato.
pub fn sanitize_completion(raw: &str, suffix: &str) -> String {
    let mut text = raw.replace("\r\n", "\n");
    if let Some(rest) = text.strip_prefix("```") {
        if let Some(nl) = rest.find('\n') {
            text = rest[nl + 1..].to_string();
        }
    }
    if let Some(idx) = text.find("```") {
        text.truncate(idx);
    }
    let next_line = suffix.lines().next().unwrap_or("").trim();
    if !next_line.is_empty() && text.ends_with(next_line) {
        let new_len = text.len().saturating_sub(next_line.len());
        text.truncate(new_len);
    }
    if text.trim().is_empty() {
        return String::new();
    }
    text
}

async fn resolve_model(client: &reqwest::Client, base: &str, requested: &str) -> Result<String, String> {
    let req = requested.trim();
    if !req.is_empty() {
        return Ok(req.to_string());
    }
    let resp = client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|_| "Ollama no responde en este equipo".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama devolvió HTTP {}", resp.status()));
    }
    let val: Value = resp.json().await.map_err(|e| e.to_string())?;
    let names: Vec<String> = localai::parse_models(&val).into_iter().map(|m| m.id).collect();
    pick_best_model(&names).ok_or_else(|| "Ollama no tiene modelos descargados".to_string())
}

#[tauri::command]
pub async fn ai_inline_complete(
    prefix: String,
    suffix: String,
    language: String,
    model: String,
) -> Result<String, String> {
    let base = localai::base_url();
    let client = reqwest::Client::builder()
        .user_agent("Pulso-Editor")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let chosen = resolve_model(&client, &base, &model).await?;
    let clipped_prefix = clip_tail(&prefix, MAX_PREFIX_CHARS);
    let clipped_suffix = clip_head(&suffix, MAX_SUFFIX_CHARS);

    let body = json!({
        "model": chosen,
        "prompt": clipped_prefix,
        "suffix": clipped_suffix,
        "system": format!(
            "You are an inline code completion engine for {language}. Output ONLY the exact code continuation to insert at the cursor. Never include explanations or markdown fences."
        ),
        "stream": false,
        "options": {
            "temperature": 0.15,
            "num_predict": 80,
            "stop": ["\n\n\n", "```", "<|endoftext|>", "<|file_sep|>"]
        }
    });

    let resp = client
        .post(format!("{base}/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Error consultando Ollama: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama devolvió HTTP {}", resp.status()));
    }

    let val: Value = resp.json().await.map_err(|e| e.to_string())?;
    let raw = val["response"].as_str().unwrap_or("");
    Ok(sanitize_completion(raw, &clipped_suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_coder_model_first() {
        let list = vec!["llama3.2:3b".into(), "qwen2.5-coder:7b".into(), "mistral:latest".into()];
        assert_eq!(pick_best_model(&list).as_deref(), Some("qwen2.5-coder:7b"));
    }

    #[test]
    fn strips_markdown_fences_and_suffix_overlap() {
        let raw = "```ts\nreturn a + b;\n```";
        assert_eq!(sanitize_completion(raw, ""), "return a + b;\n");
        assert_eq!(sanitize_completion("foo(x)", ")"), "foo(x");
    }
}
