//! Asistente de IA en la terminal (`pulso`): decide qué hacer con los argumentos y traduce la salida en streaming de
//! cada herramienta (Claude Code, Codex, Antigravity) a eventos sencillos para imprimir. Sin DOM ni ventana: todo es puro y se prueba.
use crate::i18n::{tr, trf};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub edit: bool,
    /// Confiar en la carpeta actual sin preguntar (para scripts).
    pub trust: bool,
    /// Emitir eventos en formato NDJSON (`pulso -p "..." --json`).
    pub json: bool,
    /// Carpeta de trabajo explícita (`--cwd` / `-C`).
    pub cwd: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            provider: "claude".into(),
            model: None,
            effort: None,
            edit: false,
            trust: false,
            json: false,
            cwd: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Abrir la ventana gráfica con estos argumentos (`pulso .`, `pulso archivo`, `pulso -g archivo:línea`).
    Gui,
    /// Conversación interactiva en la terminal.
    Repl(Settings),
    /// Una sola pregunta y salir (`pulso -p "texto"`).
    Ask(Settings, String),
    /// Diagnóstico del entorno y proveedores instalados (`pulso doctor`).
    Doctor(Option<String>),
    Help,
    Version,
    Error(String),
}

const PROVIDERS: [&str; 3] = ["claude", "codex", "antigravity"];

pub fn normalize_provider(p: &str) -> Option<&'static str> {
    match p.to_ascii_lowercase().as_str() {
        "claude" => Some("claude"),
        "codex" | "chatgpt" | "gpt" => Some("codex"),
        "antigravity" | "agy" | "gemini" => Some("antigravity"),
        _ => None,
    }
}

fn take(args: &[String], i: &mut usize, name: &str) -> Result<String, String> {
    *i += 1;
    args.get(*i).cloned().ok_or_else(|| trf("Falta el valor de {name}.", &[("name", &name)]))
}

/// Decide la acción a partir de los argumentos (sin el nombre del programa).
/// Sin argumentos, o solo con opciones del asistente, se conversa en la terminal; cualquier ruta u opción de apertura abre la ventana.
pub fn route(args: &[String]) -> Action {
    let mut s = Settings::default();
    let mut ask: Option<String> = None;
    let mut doctor = false;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-h" | "--help" | "help" => return Action::Help,
            "-v" | "--version" => return Action::Version,
            "doctor" if i == 0 => { doctor = true; }
            "ai" | "chat" if i == 0 => {}
            "--provider" | "--ia" => match take(args, &mut i, a) {
                Ok(v) => match normalize_provider(&v) {
                    Some(p) => s.provider = p.into(),
                    None => return Action::Error(format!("Proveedor desconocido: {v}. Usa {}.", PROVIDERS.join(", "))),
                },
                Err(e) => return Action::Error(e),
            },
            "--model" | "-m" => match take(args, &mut i, a) { Ok(v) => s.model = Some(v), Err(e) => return Action::Error(e) },
            "--effort" => match take(args, &mut i, a) { Ok(v) => s.effort = Some(v), Err(e) => return Action::Error(e) },
            "--cwd" | "-C" => match take(args, &mut i, a) { Ok(v) => s.cwd = Some(v), Err(e) => return Action::Error(e) },
            "--edit" => s.edit = true,
            "--trust" => s.trust = true,
            "--json" => s.json = true,
            "-p" | "--print" => match take(args, &mut i, a) { Ok(v) => ask = Some(v), Err(e) => return Action::Error(e) },
            _ => return Action::Gui,
        }
        i += 1;
    }
    if doctor {
        return Action::Doctor(s.cwd);
    }
    match ask { Some(q) => Action::Ask(s, q), None => Action::Repl(s) }
}

pub const HELP: &str = "\
Pulso Editor

  pulso                       Asistente de IA en esta terminal (carpeta actual)
  pulso -p \"pregunta\"         Una sola pregunta y salir (admite entrada por pipe/stdin)
  pulso doctor                Comprobar proveedores instalados, sesiones y entorno
  pulso .  |  pulso archivo   Abrir la carpeta o el archivo en la ventana de Pulso
  pulso -g archivo:línea:col  Abrir en una línea

Opciones del asistente:
  --provider claude|codex|antigravity   (por defecto claude)
  --model <modelo>   --effort low|medium|high|xhigh|max
  --cwd <carpeta>    -C <carpeta>       Ejecutar sobre otra carpeta sin hacer cd
  --edit (permite editar archivos)      --trust (confiar en la carpeta sin preguntar)
  --json (emitir eventos NDJSON en modo -p)

El asistente solo trabaja en carpetas de proyecto: la primera vez en cada una pide confianza, y no
abre la raíz de una unidad, tu carpeta personal, Escritorio, Documentos, Descargas ni carpetas del sistema.

Dentro del asistente: /provider, /model, /effort, /edit, /read, /doctor, /new, /clear, /help, /exit
";

// ---------- Salida en streaming ----------

#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    Session(String),
    /// Texto de la respuesta (un trozo, no necesariamente una línea).
    Text(String),
    /// Una herramienta que la IA usó («Read src/main.ts»).
    Tool(String),
    Done(Result<(), String>),
}

#[derive(Default)]
pub struct Parser {
    provider: String,
    claude_streamed: bool,
    agy_printed: HashMap<i64, usize>,
    agy_tools: HashSet<i64>,
    agy_text: bool,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str { v.get(k).and_then(Value::as_str).unwrap_or("") }

fn hint(input: &Value) -> String {
    for k in ["file_path", "path", "pattern", "command", "query", "url"] {
        let t = s(input, k);
        if !t.is_empty() { return t.chars().take(80).collect(); }
    }
    String::new()
}

fn tool_line(name: &str, input: &Value) -> String {
    let h = hint(input);
    if h.is_empty() { name.to_string() } else { format!("{name} {h}") }
}

impl Parser {
    pub fn new(provider: &str) -> Self { Parser { provider: provider.into(), ..Default::default() } }

    pub fn feed(&mut self, line: &str) -> Vec<Ev> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
        match self.provider.as_str() {
            "codex" => self.codex(&v),
            "antigravity" | "gemini" => self.agy(&v),
            _ => self.claude(&v),
        }
    }

    fn claude(&mut self, v: &Value) -> Vec<Ev> {
        match s(v, "type") {
            "system" if s(v, "subtype") == "init" && !s(v, "session_id").is_empty() => vec![Ev::Session(s(v, "session_id").into())],
            "stream_event" => {
                let d = &v["event"]["delta"];
                if s(&v["event"], "type") == "content_block_delta" && s(d, "type") == "text_delta" && !s(d, "text").is_empty() {
                    self.claude_streamed = true;
                    return vec![Ev::Text(s(d, "text").into())];
                }
                vec![]
            }
            "assistant" => {
                let mut out = Vec::new();
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    match s(b, "type") {
                        "tool_use" => out.push(Ev::Tool(tool_line(s(b, "name"), &b["input"]))),
                        "text" if !self.claude_streamed && !s(b, "text").is_empty() => out.push(Ev::Text(s(b, "text").into())),
                        _ => {}
                    }
                }
                self.claude_streamed = false;
                out
            }
            "result" => {
                let mut out = Vec::new();
                if !s(v, "session_id").is_empty() { out.push(Ev::Session(s(v, "session_id").into())); }
                let err = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                out.push(Ev::Done(if err { Err(s(v, "result").to_string()) } else { Ok(()) }));
                out
            }
            _ => vec![],
        }
    }

    fn codex(&mut self, v: &Value) -> Vec<Ev> {
        match s(v, "type") {
            "thread.started" => vec![Ev::Session(s(v, "thread_id").into())],
            "item.started" if s(&v["item"], "type") == "command_execution" => vec![Ev::Tool(format!("Command {}", s(&v["item"], "command").chars().take(80).collect::<String>()))],
            "item.completed" => {
                let item = &v["item"];
                match s(item, "type") {
                    "agent_message" if !s(item, "text").is_empty() => vec![Ev::Text(format!("{}\n", s(item, "text")))],
                    "file_change" => item["changes"].as_array().into_iter().flatten()
                        .map(|c| Ev::Tool(format!("{} {}", if s(c, "kind") == "add" { "Write" } else { "Edit" }, s(c, "path")))).collect(),
                    "web_search" => vec![Ev::Tool(format!("WebSearch {}", s(item, "query")))],
                    _ => vec![],
                }
            }
            "turn.completed" => vec![Ev::Done(Ok(()))],
            "turn.failed" => vec![Ev::Done(Err(non_empty(s(&v["error"], "message"), tr("La ejecución de Codex falló."))))],
            "error" => vec![Ev::Done(Err(non_empty(s(v, "message"), tr("Error de Codex CLI."))))],
            _ => vec![],
        }
    }

    fn agy(&mut self, v: &Value) -> Vec<Ev> {
        let kind = if !s(v, "event").is_empty() { s(v, "event") } else { s(v, "type") };
        match kind {
            "init" => {
                let id = if !s(v, "conversation_id").is_empty() { s(v, "conversation_id") } else { s(v, "session_id") };
                if id.is_empty() { vec![] } else { vec![Ev::Session(id.into())] }
            }
            "step_update" => {
                let su = &v["step_update"];
                let idx = su.get("step_index").and_then(Value::as_i64).unwrap_or(-1);
                let ty = s(su, "step_type");
                match ty {
                    "user_input" | "thinking" | "thought" => vec![],
                    "error_message" => {
                        let m = [s(su, "text"), s(su, "text_delta"), s(su, "error")].into_iter().find(|t| !t.is_empty()).unwrap_or("");
                        if m.is_empty() { vec![] } else { vec![Ev::Done(Err(m.into()))] }
                    }
                    "agent_response" => {
                        let (delta, full) = (s(su, "text_delta"), s(su, "text"));
                        let printed = self.agy_printed.entry(idx).or_insert(0);
                        let new = if !delta.is_empty() { delta.to_string() } else { full.chars().skip(*printed).collect() };
                        *printed += new.chars().count();
                        if new.is_empty() { vec![] } else { self.agy_text = true; vec![Ev::Text(new)] }
                    }
                    _ => {
                        let ti = &su["tool_info"];
                        let name = [s(ti, "name"), s(su, "tool_name"), s(su, "name")].into_iter().find(|t| !t.is_empty())
                            .unwrap_or(if ty != "planner_response" && ty != "tool" { ty } else { "" });
                        if name.is_empty() || !self.agy_tools.insert(idx) { return vec![]; }
                        vec![Ev::Tool(tool_line(name, &ti["parameters"]))]
                    }
                }
            }
            "result" => {
                let res = if v.get("result").is_some_and(Value::is_object) { &v["result"] } else { v };
                let mut out = Vec::new();
                let final_text = s(res, "response");
                if !self.agy_text && !final_text.is_empty() { out.push(Ev::Text(format!("{final_text}\n"))); }
                let denied = res["denied_actions"].as_array().is_some_and(|a| !a.is_empty());
                let ok = s(res, "status").eq_ignore_ascii_case("success") && !(denied && !self.agy_text && final_text.is_empty());
                out.push(Ev::Done(if ok { Ok(()) } else if denied {
                    Err(tr("Antigravity necesitó permiso para ejecutar un comando y no puede pedir confirmación en este modo.").into())
                } else { Err(non_empty(s(res, "error"), tr("Antigravity terminó con error."))) }));
                out
            }
            _ => vec![],
        }
    }
}

fn non_empty(t: &str, fallback: &str) -> String { if t.is_empty() { fallback.into() } else { t.into() } }

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }

    #[test]
    fn enruta_terminal_o_ventana() {
        assert_eq!(route(&[]), Action::Repl(Settings::default()));
        assert_eq!(route(&a(&["."])), Action::Gui);
        assert_eq!(route(&a(&["-g", "a.ts:3"])), Action::Gui);
        assert_eq!(route(&a(&["src/main.ts", "x.ts"])), Action::Gui);
        assert_eq!(route(&a(&["ai"])), Action::Repl(Settings::default()));
        assert_eq!(route(&a(&["--help"])), Action::Help);
        assert_eq!(route(&a(&["doctor"])), Action::Doctor(None));
        assert_eq!(route(&a(&["doctor", "--cwd", "C:/proj"])), Action::Doctor(Some("C:/proj".into())));
        match route(&a(&["--provider", "agy", "--model", "m", "--edit", "--json", "-C", "sub", "-p", "hola"])) {
            Action::Ask(s, q) => {
                assert_eq!(
                    (s.provider.as_str(), s.model.as_deref(), s.edit, s.json, s.cwd.as_deref(), q.as_str()),
                    ("antigravity", Some("m"), true, true, Some("sub"), "hola")
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(route(&a(&["--provider", "nadie"])), Action::Error(_)));
        assert!(matches!(route(&a(&["--model"])), Action::Error(_)));
    }

    #[test]
    fn claude_imprime_el_streaming_una_sola_vez() {
        let mut p = Parser::new("claude");
        assert_eq!(p.feed(r#"{"type":"system","subtype":"init","session_id":"s1"}"#), vec![Ev::Session("s1".into())]);
        assert_eq!(p.feed(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Ho"}}}"#), vec![Ev::Text("Ho".into())]);
        // El mensaje completo no repite el texto ya emitido, pero sí avisa de la herramienta.
        let evs = p.feed(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hola"},{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}"#);
        assert_eq!(evs, vec![Ev::Tool("Read a.ts".into())]);
        // Un mensaje sin deltas previos sí se imprime.
        assert_eq!(p.feed(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fin"}]}}"#), vec![Ev::Text("Fin".into())]);
        assert_eq!(p.feed(r#"{"type":"result","is_error":true,"result":"no hay sesión","session_id":"s1"}"#), vec![Ev::Session("s1".into()), Ev::Done(Err("no hay sesión".into()))]);
    }

    #[test]
    fn codex_lee_mensajes_y_herramientas() {
        let mut p = Parser::new("codex");
        assert_eq!(p.feed(r#"{"type":"thread.started","thread_id":"t9"}"#), vec![Ev::Session("t9".into())]);
        assert_eq!(p.feed(r#"{"type":"item.started","item":{"type":"command_execution","command":"ls"}}"#), vec![Ev::Tool("Command ls".into())]);
        assert_eq!(p.feed(r#"{"type":"item.completed","item":{"type":"agent_message","text":"listo"}}"#), vec![Ev::Text("listo\n".into())]);
        assert_eq!(p.feed(r#"{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"x.rs","kind":"add"}]}}"#), vec![Ev::Tool("Write x.rs".into())]);
        assert_eq!(p.feed(r#"{"type":"turn.completed"}"#), vec![Ev::Done(Ok(()))]);
        assert_eq!(p.feed("no es json"), vec![]);
    }

    #[test]
    fn antigravity_acumula_texto_sin_repetirlo() {
        let mut p = Parser::new("antigravity");
        assert_eq!(p.feed(r#"{"event":"init","conversation_id":"c1"}"#), vec![Ev::Session("c1".into())]);
        assert_eq!(p.feed(r#"{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","text_delta":"Ho"}}"#), vec![Ev::Text("Ho".into())]);
        assert_eq!(p.feed(r#"{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","text":"Hola mundo"}}"#), vec![Ev::Text("la mundo".into())]);
        assert_eq!(p.feed(r#"{"event":"step_update","step_update":{"step_index":3,"step_type":"x","tool_info":{"name":"view_file","parameters":{"path":"a.rs"}}}}"#), vec![Ev::Tool("view_file a.rs".into())]);
        assert_eq!(p.feed(r#"{"event":"step_update","step_update":{"step_index":3,"step_type":"x","state":"DONE","tool_info":{"name":"view_file"}}}"#), vec![]);
        assert_eq!(p.feed(r#"{"event":"result","result":{"status":"SUCCESS","response":"Hola mundo"}}"#), vec![Ev::Done(Ok(()))]);
    }

    #[test]
    fn antigravity_sin_streaming_usa_la_respuesta_final() {
        let mut p = Parser::new("antigravity");
        assert_eq!(p.feed(r#"{"event":"result","result":{"status":"SUCCESS","response":"ok"}}"#), vec![Ev::Text("ok\n".into()), Ev::Done(Ok(()))]);
        let mut q = Parser::new("antigravity");
        assert!(matches!(q.feed(r#"{"event":"result","result":{"status":"ERROR","error":"mal"}}"#).last(), Some(Ev::Done(Err(e))) if e == "mal"));
    }
}
