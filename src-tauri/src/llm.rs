//! Conversación con un modelo por HTTP, con streaming y herramientas, en los protocolos que cubren casi todos los proveedores:
//! el compatible con OpenAI (`/chat/completions`), el de Anthropic (`/messages`) y el nativo de Ollama (`/api/chat`).
//!
//! Los tres producen lo mismo: el texto que va llegando, las herramientas que el modelo pidió y los tokens usados. Las funciones que
//! arman las solicitudes y las que interpretan el streaming son puras y se prueban sin red; la prueba de extremo a extremo usa
//! un servidor simulado en esta misma máquina.
use crate::catalog::Protocol;
use crate::i18n::{tr, trf};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Msg {
    /// `images`: direcciones `data:image/...;base64,...`.
    User { text: String, images: Vec<String> },
    Assistant { text: String, calls: Vec<Call> },
    Tool { id: String, name: String, content: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Round {
    pub text: String,
    pub calls: Vec<Call>,
    pub usage: Usage,
}

// ---------- Solicitudes ----------

fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    Some((meta.strip_suffix(";base64")?, data))
}

pub fn openai_body(model: &str, system: &str, msgs: &[Msg], tools: &[Spec], max_tokens: Option<u64>) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    for m in msgs {
        messages.push(match m {
            Msg::User { text, images } if images.is_empty() => json!({ "role": "user", "content": text }),
            Msg::User { text, images } => {
                let mut parts = vec![json!({ "type": "text", "text": text })];
                parts.extend(images.iter().map(|u| json!({ "type": "image_url", "image_url": { "url": u } })));
                json!({ "role": "user", "content": parts })
            }
            Msg::Assistant { text, calls } => {
                let mut v = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
                if !calls.is_empty() {
                    v["tool_calls"] = Value::Array(
                        calls.iter().map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.args.to_string() } })).collect(),
                    );
                }
                v
            }
            Msg::Tool { id, content, .. } => json!({ "role": "tool", "tool_call_id": id, "content": content }),
        });
    }
    let mut body = json!({ "model": model, "messages": messages, "stream": true, "stream_options": { "include_usage": true } });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } })).collect());
    }
    if let Some(n) = max_tokens {
        body["max_tokens"] = json!(n);
    }
    body
}

pub fn anthropic_body(model: &str, system: &str, msgs: &[Msg], tools: &[Spec], max_tokens: u64) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for m in msgs {
        match m {
            Msg::User { text, images } => {
                let mut blocks: Vec<Value> = images
                    .iter()
                    .filter_map(|u| parse_data_url(u))
                    .map(|(mime, data)| json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": data } }))
                    .collect();
                blocks.push(json!({ "type": "text", "text": text }));
                messages.push(json!({ "role": "user", "content": blocks }));
            }
            Msg::Assistant { text, calls } => {
                let mut blocks = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                blocks.extend(calls.iter().map(|c| json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.args })));
                messages.push(json!({ "role": "assistant", "content": blocks }));
            }
            Msg::Tool { id, content, .. } => {
                let block = json!({ "type": "tool_result", "tool_use_id": id, "content": content });
                // Los resultados de varias herramientas de una misma vuelta van juntos en un solo mensaje de la persona.
                match messages.last_mut() {
                    Some(last) if last["role"] == "user" && last["content"].as_array().is_some_and(|a| a.iter().all(|b| b["type"] == "tool_result")) => {
                        last["content"].as_array_mut().expect("comprobado arriba").push(block);
                    }
                    _ => messages.push(json!({ "role": "user", "content": [block] })),
                }
            }
        }
    }
    let mut body = json!({ "model": model, "max_tokens": max_tokens, "system": system, "messages": messages, "stream": true });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters })).collect());
    }
    body
}

/// Cuerpo de `/api/chat` de Ollama. `num_ctx` es la ventana de contexto que se le pide (0 = la que tenga por defecto): sin ella Ollama
/// usa unos 4 000 tokens y recortaría por el principio, justo donde van las instrucciones y las herramientas.
pub fn ollama_body(model: &str, system: &str, msgs: &[Msg], tools: &[Spec], num_ctx: u64, max_tokens: Option<u64>) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    for m in msgs {
        messages.push(match m {
            Msg::User { text, images } => {
                let mut v = json!({ "role": "user", "content": text });
                let data: Vec<&str> = images.iter().filter_map(|u| parse_data_url(u)).map(|(_, d)| d).collect();
                if !data.is_empty() {
                    v["images"] = json!(data);
                }
                v
            }
            Msg::Assistant { text, calls } => {
                let mut v = json!({ "role": "assistant", "content": text });
                if !calls.is_empty() {
                    v["tool_calls"] = Value::Array(calls.iter().map(|c| json!({ "function": { "name": c.name, "arguments": c.args } })).collect());
                }
                v
            }
            Msg::Tool { name, content, .. } => json!({ "role": "tool", "tool_name": name, "content": content }),
        });
    }
    let mut options = serde_json::Map::new();
    if num_ctx > 0 {
        options.insert("num_ctx".into(), json!(num_ctx));
    }
    if let Some(n) = max_tokens {
        options.insert("num_predict".into(), json!(n));
    }
    let mut body = json!({ "model": model, "messages": messages, "stream": true, "options": options });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } })).collect());
    }
    body
}

// ---------- Streaming (SSE) ----------

/// Parte el flujo de bytes en eventos SSE (`event:` opcional y `data:`), sin perder los que llegan cortados entre dos trozos.
#[derive(Default)]
pub struct SseBuf {
    pending: Vec<u8>,
}

impl SseBuf {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<(Option<String>, String)> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let text_end = find_event_end(&self.pending);
            let Some((end, skip)) = text_end else { break };
            let raw: Vec<u8> = self.pending.drain(..end + skip).take(end).collect();
            let raw = String::from_utf8_lossy(&raw).into_owned();
            let (mut event, mut data) = (None, Vec::new());
            for line in raw.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = Some(v.trim().to_string());
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
                }
            }
            if !data.is_empty() {
                out.push((event, data.join("\n")));
            }
        }
        out
    }
}

/// Posición del fin de un evento (línea en blanco) y cuántos bytes ocupa el separador.
fn find_event_end(b: &[u8]) -> Option<(usize, usize)> {
    for i in 0..b.len() {
        if b[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
        if b[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
    }
    None
}

fn api_error(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(e["message"].as_str().or_else(|| e.as_str()).unwrap_or("error").to_string())
}

fn parse_args(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

/// Acumula el streaming del protocolo compatible con OpenAI.
#[derive(Default)]
pub struct OpenAiAcc {
    text: String,
    calls: BTreeMap<u64, (String, String, String)>,
    usage: Usage,
    done: bool,
}

impl OpenAiAcc {
    pub fn feed(&mut self, data: &str, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(()) };
        if let Some(e) = api_error(&v) {
            return Err(e);
        }
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            self.usage = Usage { input: u["prompt_tokens"].as_u64().unwrap_or(0), output: u["completion_tokens"].as_u64().unwrap_or(0) };
        }
        let Some(delta) = v["choices"].get(0).map(|c| &c["delta"]) else { return Ok(()) };
        if let Some(piece) = delta["content"].as_str().filter(|s| !s.is_empty()) {
            self.text.push_str(piece);
            on_text(piece);
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let idx = call["index"].as_u64().unwrap_or(0);
            let slot = self.calls.entry(idx).or_default();
            if let Some(id) = call["id"].as_str().filter(|s| !s.is_empty()) {
                slot.0 = id.to_string();
            }
            if let Some(name) = call["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                slot.1.push_str(name);
            }
            if let Some(args) = call["function"]["arguments"].as_str() {
                slot.2.push_str(args);
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Round {
        let calls = self
            .calls
            .into_iter()
            .filter(|(_, (_, name, _))| !name.is_empty())
            .map(|(i, (id, name, args))| Call { id: if id.is_empty() { format!("call_{i}") } else { id }, name, args: parse_args(&args) })
            .collect();
        Round { text: self.text, calls, usage: self.usage }
    }
}

/// Acumula el streaming del protocolo de Anthropic.
#[derive(Default)]
pub struct AnthropicAcc {
    text: String,
    blocks: BTreeMap<u64, (String, String, String)>,
    usage: Usage,
}

impl AnthropicAcc {
    pub fn feed(&mut self, data: &str, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(()) };
        match v["type"].as_str().unwrap_or("") {
            "error" => return Err(api_error(&v).unwrap_or_else(|| "error".into())),
            "message_start" => {
                self.usage.input = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0)
                    + v["message"]["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0)
                    + v["message"]["usage"]["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                self.usage.output = v["message"]["usage"]["output_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let b = &v["content_block"];
                if b["type"] == "tool_use" {
                    self.blocks.insert(v["index"].as_u64().unwrap_or(0), (b["id"].as_str().unwrap_or("").into(), b["name"].as_str().unwrap_or("").into(), String::new()));
                }
            }
            "content_block_delta" => {
                let d = &v["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if let Some(piece) = d["text"].as_str().filter(|s| !s.is_empty()) {
                            self.text.push_str(piece);
                            on_text(piece);
                        }
                    }
                    "input_json_delta" => {
                        if let Some(slot) = self.blocks.get_mut(&v["index"].as_u64().unwrap_or(0)) {
                            slot.2.push_str(d["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(n) = v["usage"]["output_tokens"].as_u64() {
                    self.usage.output = n;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn finish(self) -> Round {
        let calls = self.blocks.into_values().filter(|(_, name, _)| !name.is_empty()).map(|(id, name, args)| Call { id, name, args: parse_args(&args) }).collect();
        Round { text: self.text, calls, usage: self.usage }
    }
}

/// Parte el flujo de bytes de Ollama en líneas (un objeto JSON por línea), sin perder las que llegan cortadas entre dos trozos.
#[derive(Default)]
pub struct NdjsonBuf {
    pending: Vec<u8>,
}

impl NdjsonBuf {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line).trim().to_string();
            if !text.is_empty() {
                out.push(text);
            }
        }
        out
    }

    /// Lo que quedó sin terminar en línea al acabar el flujo (el último objeto, si el servidor no cerró con salto de línea).
    pub fn rest(&mut self) -> Option<String> {
        let text = String::from_utf8_lossy(&std::mem::take(&mut self.pending)).trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

/// Acumula el streaming del `/api/chat` de Ollama.
#[derive(Default)]
pub struct OllamaAcc {
    text: String,
    calls: Vec<Call>,
    usage: Usage,
}

impl OllamaAcc {
    pub fn feed(&mut self, line: &str, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Ok(()) };
        if let Some(e) = api_error(&v) {
            return Err(e);
        }
        if let Some(piece) = v["message"]["content"].as_str().filter(|s| !s.is_empty()) {
            self.text.push_str(piece);
            on_text(piece);
        }
        for call in v["message"]["tool_calls"].as_array().into_iter().flatten() {
            let name = call["function"]["name"].as_str().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            // Ollama manda los argumentos como objeto; algunos modelos los dejan como texto JSON.
            let args = match &call["function"]["arguments"] {
                Value::String(s) => parse_args(s),
                Value::Null => json!({}),
                other => other.clone(),
            };
            // Ollama no da identificadores de llamada: se inventan (solo valen dentro de esta vuelta).
            let id = call["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("call_{}", self.calls.len()));
            self.calls.push(Call { id, name, args });
        }
        if v["done"].as_bool() == Some(true) {
            self.usage = Usage { input: v["prompt_eval_count"].as_u64().unwrap_or(0), output: v["eval_count"].as_u64().unwrap_or(0) };
        }
        Ok(())
    }

    pub fn finish(self) -> Round {
        Round { text: self.text, calls: self.calls, usage: self.usage }
    }
}

/// Algunos modelos pequeños (qwen2.5-coder, por ejemplo) escriben la llamada a la herramienta como texto JSON en vez de usar el formato
/// de herramientas. Si **todo** el texto es una llamada válida a una herramienta que se ofreció, se trata como tal; si hay prosa
/// mezclada o la herramienta no existe, no se toca (así una respuesta normal nunca se confunde con una llamada).
pub fn rescue_text_call(text: &str, tools: &[Spec]) -> Option<Call> {
    let mut t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        t = rest.trim_start_matches(|c: char| c.is_alphanumeric()).trim();
        t = t.strip_suffix("```").unwrap_or(t).trim();
    }
    if let Some(rest) = t.strip_prefix("<tool_call>") {
        t = rest.trim();
        t = t.strip_suffix("</tool_call>").unwrap_or(t).trim();
    }
    let v: Value = serde_json::from_str(t).ok()?;
    let name = v["name"].as_str()?;
    if !tools.iter().any(|s| s.name == name) {
        return None;
    }
    let args = match v.get("arguments").or_else(|| v.get("parameters")).cloned().unwrap_or_else(|| json!({})) {
        Value::String(s) => parse_args(&s),
        other => other,
    };
    args.is_object().then(|| Call { id: "call_0".into(), name: name.to_string(), args })
}

// ---------- Red ----------

/// Mensaje legible para un error HTTP: lo que dice el proveedor, o una pista según el código.
fn http_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| api_error(&v)).unwrap_or_else(|| body.chars().take(300).collect());
    let hint = match status {
        401 | 403 => tr("La clave fue rechazada. Revísala en Configuración de proveedores."),
        404 => tr("No se encontró el modelo o la dirección del proveedor."),
        429 => tr("Demasiadas solicitudes o sin crédito en el proveedor."),
        _ => "",
    };
    if hint.is_empty() { trf("El proveedor respondió {status}: {detail}", &[("status", &status), ("detail", &detail)]) } else { format!("{hint} ({detail})") }
}

/// El error de red con su causa («error sending request: connection refused…»), sin la dirección (que puede llevar datos).
fn describe(e: reqwest::Error) -> String {
    let e = e.without_url();
    let mut out = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

pub struct Endpoint<'a> {
    pub protocol: Protocol,
    pub base: &'a str,
    pub key: &'a str,
    /// Ventana de contexto que se pide al modelo (solo la usa Ollama; 0 = la de por defecto).
    pub context: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(180))
        // Sin redirecciones: la clave solo debe llegar a la dirección del proveedor, nunca a otra a la que lo desvíen.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// Una vuelta con el modelo: manda la conversación y va entregando el texto; devuelve lo que pidió y los tokens.
pub async fn stream_round(
    ep: &Endpoint<'_>,
    model: &str,
    system: &str,
    msgs: &[Msg],
    tools: &[Spec],
    max_tokens: Option<u64>,
    cancel: &AtomicBool,
    mut on_text: impl FnMut(&str),
) -> Result<Round, String> {
    if !crate::catalog::is_safe_base(ep.base) {
        return Err(tr("La dirección del proveedor no es segura.").into());
    }
    let c = client()?;
    let req = match ep.protocol {
        Protocol::OpenAi => {
            let url = format!("{}/chat/completions", ep.base.trim_end_matches('/'));
            c.post(&url).bearer_auth(ep.key).json(&openai_body(model, system, msgs, tools, max_tokens))
        }
        Protocol::Anthropic => {
            let url = format!("{}/messages", ep.base.trim_end_matches('/'));
            c.post(&url)
                .header("x-api-key", ep.key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&anthropic_body(model, system, msgs, tools, max_tokens.unwrap_or(8192)))
        }
        Protocol::Ollama => {
            let url = format!("{}/api/chat", ep.base.trim_end_matches('/'));
            c.post(&url).json(&ollama_body(model, system, msgs, tools, ep.context, max_tokens))
        }
    };
    let mut res = req.send().await.map_err(|e| {
        if ep.protocol == Protocol::Ollama {
            trf("No se pudo contactar con Ollama: {e}", &[("e", &describe(e))])
        } else {
            trf("No se pudo contactar con el proveedor: {e}", &[("e", &describe(e))])
        }
    })?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(http_error(status, &body));
    }
    let mut sse = SseBuf::default();
    let mut nd = NdjsonBuf::default();
    let (mut oa, mut an, mut ol) = (OpenAiAcc::default(), AnthropicAcc::default(), OllamaAcc::default());
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(tr("La conversación se detuvo.").into());
        }
        let Some(chunk) = res.chunk().await.map_err(|e| trf("El proveedor cortó la respuesta: {e}", &[("e", &describe(e))]))? else { break };
        if ep.protocol == Protocol::Ollama {
            for line in nd.push(&chunk) {
                ol.feed(&line, &mut on_text)?;
            }
            continue;
        }
        for (_, data) in sse.push(&chunk) {
            match ep.protocol {
                Protocol::OpenAi => oa.feed(&data, &mut on_text)?,
                Protocol::Anthropic => an.feed(&data, &mut on_text)?,
                Protocol::Ollama => {}
            }
        }
    }
    if let Some(line) = nd.rest() {
        ol.feed(&line, &mut on_text)?;
    }
    Ok(match ep.protocol {
        Protocol::OpenAi => oa.finish(),
        Protocol::Anthropic => an.finish(),
        Protocol::Ollama => {
            let mut r = ol.finish();
            if r.calls.is_empty() {
                if let Some(call) = rescue_text_call(&r.text, tools) {
                    r.calls.push(call);
                    r.text.clear();
                }
            }
            r
        }
    })
}

/// Convierte el esquema de herramientas en formato OpenAI (`{type:"function",function:{…}}`) a `Spec`.
pub fn specs_from_openai(list: &Value) -> Vec<Spec> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let f = &t["function"];
            Some(Spec { name: f["name"].as_str()?.to_string(), description: f["description"].as_str().unwrap_or("").to_string(), parameters: f["parameters"].clone() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn spec() -> Spec {
        Spec { name: "read_file".into(), description: "Lee".into(), parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } } }) }
    }

    fn conversation() -> Vec<Msg> {
        vec![
            Msg::User { text: "mira a.ts".into(), images: vec![] },
            Msg::Assistant { text: "Voy.".into(), calls: vec![Call { id: "c1".into(), name: "read_file".into(), args: json!({ "path": "a.ts" }) }, Call { id: "c2".into(), name: "read_file".into(), args: json!({ "path": "b.ts" }) }] },
            Msg::Tool { id: "c1".into(), name: "read_file".into(), content: "uno".into() },
            Msg::Tool { id: "c2".into(), name: "read_file".into(), content: "dos".into() },
        ]
    }

    #[test]
    fn solicitud_openai() {
        let b = openai_body("gpt-x", "sé breve", &conversation(), &[spec()], Some(1000));
        assert_eq!(b["model"], "gpt-x");
        assert_eq!(b["stream"], true);
        assert_eq!(b["max_tokens"], 1000);
        assert_eq!(b["messages"][0], json!({ "role": "system", "content": "sé breve" }));
        assert_eq!(b["messages"][2]["tool_calls"][1]["function"]["arguments"], "{\"path\":\"b.ts\"}");
        assert_eq!(b["messages"][3], json!({ "role": "tool", "tool_call_id": "c1", "content": "uno" }));
        assert_eq!(b["tools"][0]["function"]["name"], "read_file");
        // Con imágenes, el contenido pasa a partes.
        let con_imagen = openai_body("m", "s", &[Msg::User { text: "hola".into(), images: vec!["data:image/png;base64,AAA".into()] }], &[], None);
        assert_eq!(con_imagen["messages"][1]["content"][1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert!(con_imagen.get("tools").is_none() && con_imagen.get("max_tokens").is_none());
    }

    #[test]
    fn solicitud_anthropic_junta_los_resultados_de_herramientas() {
        let b = anthropic_body("claude-x", "sé breve", &conversation(), &[spec()], 4096);
        assert_eq!(b["system"], "sé breve");
        assert_eq!(b["max_tokens"], 4096);
        let msgs = b["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(msgs[2]["content"][1], json!({ "type": "tool_result", "tool_use_id": "c2", "content": "dos" }));
        assert_eq!(b["tools"][0]["input_schema"]["type"], "object");
        let con_imagen = anthropic_body("m", "s", &[Msg::User { text: "hola".into(), images: vec!["data:image/jpeg;base64,BBB".into()] }], &[], 100);
        assert_eq!(con_imagen["messages"][0]["content"][0]["source"], json!({ "type": "base64", "media_type": "image/jpeg", "data": "BBB" }));
    }

    #[test]
    fn el_sse_une_los_trozos_cortados() {
        let mut s = SseBuf::default();
        assert!(s.push(b"data: {\"a\":").is_empty());
        let ev = s.push(b"1}\n\nevent: x\r\ndata: dos\r\n\r\ndata: tres");
        assert_eq!(ev, vec![(None, "{\"a\":1}".to_string()), (Some("x".to_string()), "dos".to_string())]);
        assert_eq!(s.push(b"\n\n"), vec![(None, "tres".to_string())]);
    }

    #[test]
    fn acumula_texto_y_herramientas_de_openai() {
        let mut acc = OpenAiAcc::default();
        let mut got = String::new();
        let mut on = |t: &str| got.push_str(t);
        for d in [
            r#"{"choices":[{"delta":{"content":"Hola"}}]}"#,
            r#"{"choices":[{"delta":{"content":" mundo"}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.ts\"}"}}]}}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30}}"#,
            "[DONE]",
        ] {
            acc.feed(d, &mut on).unwrap();
        }
        let r = acc.finish();
        assert_eq!(got, "Hola mundo");
        assert_eq!(r.text, "Hola mundo");
        assert_eq!(r.calls, vec![Call { id: "c9".into(), name: "read_file".into(), args: json!({ "path": "a.ts" }) }]);
        assert_eq!(r.usage, Usage { input: 120, output: 30 });
        // Un error del proveedor dentro del flujo corta la conversación.
        let mut e = OpenAiAcc::default();
        assert_eq!(e.feed(r#"{"error":{"message":"sin crédito"}}"#, &mut |_| {}), Err("sin crédito".to_string()));
    }

    #[test]
    fn acumula_texto_y_herramientas_de_anthropic() {
        let mut acc = AnthropicAcc::default();
        let mut got = String::new();
        let mut on = |t: &str| got.push_str(t);
        for d in [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":10,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Voy a leer."}}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read_file","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"a.ts\"}"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
        ] {
            acc.feed(d, &mut on).unwrap();
        }
        let r = acc.finish();
        assert_eq!(got, "Voy a leer.");
        assert_eq!(r.calls, vec![Call { id: "tu1".into(), name: "read_file".into(), args: json!({ "path": "a.ts" }) }]);
        assert_eq!(r.usage, Usage { input: 60, output: 42 });
        let mut e = AnthropicAcc::default();
        assert_eq!(e.feed(r#"{"type":"error","error":{"type":"overloaded_error","message":"saturado"}}"#, &mut |_| {}), Err("saturado".to_string()));
    }

    #[test]
    fn los_errores_http_dan_una_pista() {
        assert!(http_error(401, r#"{"error":{"message":"bad key"}}"#).contains("bad key"));
        assert!(http_error(429, "").len() > 10);
        assert!(http_error(500, "caído").contains("500"));
    }

    /// Servidor simulado: contesta una vez con `body` como SSE y devuelve lo que recibió.
    fn mock(body: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            // Leer cabeceras y luego el cuerpo según Content-Length.
            loop {
                let n = s.read(&mut buf).unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req).into_owned();
                if let Some(pos) = text.find("\r\n\r\n") {
                    let len = text[..pos].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if req.len() >= pos + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            s.write_all(head.as_bytes()).unwrap();
            s.write_all(body.as_bytes()).unwrap();
            String::from_utf8_lossy(&req).into_owned()
        });
        (format!("http://127.0.0.1:{}/v1", addr.port()), h)
    }

    #[test]
    fn de_extremo_a_extremo_con_openai_simulado() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hola\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"t1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}]}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n".to_string();
        let (base, server) = mock(sse);
        let cancel = AtomicBool::new(false);
        let mut streamed = String::new();
        let ep = Endpoint { protocol: Protocol::OpenAi, base: &base, key: "sk-secreta", context: 0 };
        let r = tauri::async_runtime::block_on(stream_round(&ep, "m", "s", &[Msg::User { text: "hola".into(), images: vec![] }], &[spec()], None, &cancel, |t| streamed.push_str(t))).unwrap();
        assert_eq!((r.text.as_str(), streamed.as_str()), ("Hola", "Hola"));
        assert_eq!(r.calls[0].name, "read_file");
        assert_eq!(r.usage, Usage { input: 7, output: 3 });
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"), "{request}");
        assert!(request.to_lowercase().contains("authorization: bearer sk-secreta"));
    }

    #[test]
    fn de_extremo_a_extremo_con_anthropic_simulado() {
        let sse = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Listo\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2}}\n\n".to_string();
        let (base, server) = mock(sse);
        let cancel = AtomicBool::new(false);
        let ep = Endpoint { protocol: Protocol::Anthropic, base: &base, key: "ak-secreta", context: 0 };
        let r = tauri::async_runtime::block_on(stream_round(&ep, "claude-x", "s", &[Msg::User { text: "hola".into(), images: vec![] }], &[], Some(2000), &cancel, |_| {})).unwrap();
        assert_eq!((r.text.as_str(), r.usage), ("Listo", Usage { input: 5, output: 2 }));
        let request = server.join().unwrap().to_lowercase();
        assert!(request.starts_with("post /v1/messages"), "{request}");
        assert!(request.contains("x-api-key: ak-secreta") && request.contains("anthropic-version: 2023-06-01"));
    }

    #[test]
    fn solicitud_ollama_fija_la_ventana_de_contexto_y_pasa_las_imagenes_sin_prefijo() {
        let b = ollama_body("qwen", "sé breve", &conversation(), &[spec()], 16384, Some(500));
        assert_eq!(b["options"], json!({ "num_ctx": 16384, "num_predict": 500 }));
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0], json!({ "role": "system", "content": "sé breve" }));
        // Las llamadas llevan los argumentos como objeto (no como texto), y los resultados el nombre de la herramienta.
        assert_eq!(b["messages"][2]["tool_calls"][1]["function"], json!({ "name": "read_file", "arguments": { "path": "b.ts" } }));
        assert_eq!(b["messages"][3], json!({ "role": "tool", "tool_name": "read_file", "content": "uno" }));
        assert_eq!(b["tools"][0]["function"]["name"], "read_file");
        let con_imagen = ollama_body("m", "s", &[Msg::User { text: "hola".into(), images: vec!["data:image/png;base64,AAA".into(), "no-es-data-url".into()] }], &[], 0, None);
        assert_eq!(con_imagen["messages"][1]["images"], json!(["AAA"]));
        // Sin contexto conocido ni límite de salida no se manda ninguna opción.
        assert_eq!(con_imagen["options"], json!({}));
        assert!(con_imagen.get("tools").is_none());
    }

    #[test]
    fn acumula_el_ndjson_de_ollama_con_lineas_cortadas_herramientas_y_uso() {
        let mut buf = NdjsonBuf::default();
        let mut acc = OllamaAcc::default();
        let mut got = String::new();
        let mut on = |t: &str| got.push_str(t);
        let stream = "{\"message\":{\"role\":\"assistant\",\"content\":\"Hola\"},\"done\":false}\n{\"message\":{\"content\":\" mundo\",\"tool_calls\":[{\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}},{\"function\":{\"name\":\"grep\",\"arguments\":\"{\\\"pattern\\\":\\\"x\\\"}\"}}]},\"done\":false}\n{\"message\":{\"content\":\"\"},\"done\":true,\"prompt_eval_count\":120,\"eval_count\":30}";
        // El flujo llega en trozos que cortan una línea por la mitad, y el último no termina en salto de línea.
        let (a, b) = stream.split_at(60);
        let mut lines = buf.push(a.as_bytes());
        lines.extend(buf.push(b.as_bytes()));
        lines.extend(buf.rest());
        for l in lines {
            acc.feed(&l, &mut on).unwrap();
        }
        let r = acc.finish();
        assert_eq!((got.as_str(), r.text.as_str()), ("Hola mundo", "Hola mundo"));
        assert_eq!(r.calls, vec![Call { id: "call_0".into(), name: "read_file".into(), args: json!({ "path": "a.ts" }) }, Call { id: "call_1".into(), name: "grep".into(), args: json!({ "pattern": "x" }) }]);
        assert_eq!(r.usage, Usage { input: 120, output: 30 });
        let mut e = OllamaAcc::default();
        assert_eq!(e.feed(r#"{"error":"model 'x' not found"}"#, &mut |_| {}), Err("model 'x' not found".to_string()));
    }

    #[test]
    fn rescata_la_llamada_que_un_modelo_pequeno_escribio_como_texto() {
        let tools = [spec()];
        let want = Some(Call { id: "call_0".into(), name: "read_file".into(), args: json!({ "path": "a.ts" }) });
        assert_eq!(rescue_text_call(r#"{"name": "read_file", "arguments": {"path": "a.ts"}}"#, &tools), want);
        // Con cercas de código, con etiquetas, con «parameters» o con los argumentos como texto.
        assert_eq!(rescue_text_call("```json\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```", &tools), want);
        assert_eq!(rescue_text_call("<tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n</tool_call>", &tools), want);
        assert_eq!(rescue_text_call(r#"{"name":"read_file","parameters":{"path":"a.ts"}}"#, &tools), want);
        assert_eq!(rescue_text_call(r#"{"name":"read_file","arguments":"{\"path\":\"a.ts\"}"}"#, &tools), want);
        // Lo que no es exactamente una llamada a una herramienta ofrecida no se toca.
        assert_eq!(rescue_text_call("Voy a leer el archivo: {\"name\":\"read_file\",\"arguments\":{}}", &tools), None);
        assert_eq!(rescue_text_call(r#"{"name":"borrar_todo","arguments":{}}"#, &tools), None);
        assert_eq!(rescue_text_call(r#"{"name":"read_file","arguments":[1]}"#, &tools), None);
        assert_eq!(rescue_text_call(r#"{"respuesta": 42}"#, &tools), None);
        assert_eq!(rescue_text_call("Hola, ¿en qué ayudo?", &tools), None);
        assert_eq!(rescue_text_call("", &tools), None);
    }

    #[test]
    fn ollama_con_la_llamada_como_texto_la_convierte_en_herramienta_y_no_la_muestra_como_respuesta() {
        let line = json!({ "message": { "content": "{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}" }, "done": true, "prompt_eval_count": 5, "eval_count": 3 });
        let (base, _server) = mock(format!("{line}\n"));
        let base = base.trim_end_matches("/v1").to_string();
        let ep = Endpoint { protocol: Protocol::Ollama, base: &base, key: "", context: 0 };
        let r = tauri::async_runtime::block_on(stream_round(&ep, "m", "s", &[Msg::User { text: "hola".into(), images: vec![] }], &[spec()], None, &AtomicBool::new(false), |_| {})).unwrap();
        assert_eq!((r.text.as_str(), r.calls.len(), r.calls[0].name.as_str()), ("", 1, "read_file"));
    }

    #[test]
    fn de_extremo_a_extremo_con_ollama_simulado() {
        let ndjson = "{\"message\":{\"content\":\"Listo\"},\"done\":false}\n{\"message\":{\"content\":\"\"},\"done\":true,\"prompt_eval_count\":9,\"eval_count\":2}\n".to_string();
        let (base, server) = mock(ndjson);
        // `mock` devuelve `.../v1`; Ollama habla en `/api/chat` desde la raíz.
        let base = base.trim_end_matches("/v1").to_string();
        let cancel = AtomicBool::new(false);
        let ep = Endpoint { protocol: Protocol::Ollama, base: &base, key: "", context: 8192 };
        let r = tauri::async_runtime::block_on(stream_round(&ep, "qwen", "s", &[Msg::User { text: "hola".into(), images: vec![] }], &[spec()], None, &cancel, |_| {})).unwrap();
        assert_eq!((r.text.as_str(), r.usage), ("Listo", Usage { input: 9, output: 2 }));
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /api/chat"), "{request}");
        assert!(request.contains("\"num_ctx\":8192"), "{request}");
        assert!(!request.to_lowercase().contains("authorization"), "Ollama no recibe ninguna clave: {request}");
    }

    #[test]
    fn nunca_manda_la_clave_a_una_direccion_insegura() {
        let cancel = AtomicBool::new(false);
        let ep = Endpoint { protocol: Protocol::OpenAi, base: "http://evil.example.com/v1", key: "sk-secreta", context: 0 };
        let r = tauri::async_runtime::block_on(stream_round(&ep, "m", "s", &[], &[], None, &cancel, |_| {}));
        assert!(r.is_err());
    }

    #[test]
    fn convierte_el_esquema_de_herramientas() {
        let specs = specs_from_openai(&json!([{ "type": "function", "function": { "name": "x", "description": "d", "parameters": { "type": "object" } } }, { "bad": 1 }]));
        assert_eq!(specs.len(), 1);
        assert_eq!((specs[0].name.as_str(), specs[0].description.as_str()), ("x", "d"));
    }
}
