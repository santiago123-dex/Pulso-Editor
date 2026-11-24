//! Agente de código con un modelo de la nube (cualquier proveedor de [models.dev](https://models.dev)).
//!
//! Es el bucle del agente: la persona escribe, el modelo responde o pide herramientas, se ejecutan (con los permisos del modo elegido),
//! el resultado vuelve al modelo, y así hasta que responde sin pedir más. El modelo viene de `llm.rs` (dos protocolos para más de 300
//! proveedores), las herramientas de `agenttools.rs` y la configuración (instrucciones del proyecto, skills, subagentes y comandos)
//! de `agentconfig.rs`.
//!
//! **Subagentes:** la herramienta `task` lanza otro agente con su propio contexto y sus propias herramientas (nunca más permisos que el
//! que lo lanza) y devuelve solo su informe final. Varias llamadas a `task` en una misma respuesta se ejecutan a la vez. Un subagente no
//! puede lanzar otros.
//!
//! Emite los mismos eventos que Claude Code, así que la tarjeta de actividad, los diffs y el historial del panel no cambian.
use crate::agentconfig::{self, AgentDef, Config};
use crate::agentperms::Permissions;
use crate::agenttools::{self, Mode, Outcome, Session};
use crate::catalog::Protocol;
use crate::i18n::{tr, trf};
use crate::llm::{self, Endpoint, Msg, Spec};
use crate::localai::{self, HistoryMsg};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    time::Instant,
};

/// Vueltas máximas con herramientas en una respuesta del agente principal y de un subagente.
const MAX_ROUNDS: usize = 40;
const MAX_SUBAGENT_ROUNDS: usize = 25;
/// Cuántas veces seguidas se acepta exactamente la misma llamada antes de cortar el bucle.
const MAX_REPEATS: usize = 3;
const MAX_REPORT_CHARS: usize = 24_000;

/// Un modelo concreto de un proveedor, con todo lo necesario para hablar con él.
#[derive(Clone)]
pub struct CloudModel {
    pub provider_name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub key: String,
    pub model: String,
    pub images: bool,
    /// Ventana de contexto del modelo (tokens); 0 si no se conoce.
    pub context: u64,
    /// Salida máxima del modelo (tokens), para no pedir más de lo que admite.
    pub max_output: u64,
    /// Dólares por millón de tokens.
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
}

impl CloudModel {
    /// Un modelo del catálogo con la clave de su proveedor.
    pub fn from_catalog(p: &crate::catalog::ProviderEntry, m: &crate::catalog::ModelEntry, key: String) -> CloudModel {
        CloudModel {
            provider_name: p.name.clone(),
            protocol: p.protocol,
            base_url: p.base_url.clone(),
            key,
            model: m.id.clone(),
            images: m.images,
            context: m.context,
            max_output: m.output,
            input_cost: m.input_cost,
            output_cost: m.output_cost,
        }
    }
}

/// Resolvedor de modelos a partir del catálogo: `proveedor/modelo` si existe y su proveedor tiene clave.
pub fn catalog_resolver(list: Arc<Vec<crate::catalog::ProviderEntry>>) -> ModelResolver {
    Arc::new(move |spec: &str| {
        let (provider_id, model_id) = spec.split_once('/')?;
        let p = list.iter().find(|p| p.id == provider_id)?;
        let m = p.models.iter().find(|m| m.id == model_id)?;
        Some(CloudModel::from_catalog(p, m, crate::catalog::get_key(p)?))
    })
}

/// Busca un modelo `proveedor/modelo` con su clave (para los subagentes que piden otro modelo). `None` si no existe o no hay clave.
pub type ModelResolver = Arc<dyn Fn(&str) -> Option<CloudModel> + Send + Sync>;

/// Lo que comparten el agente principal y sus subagentes.
#[derive(Clone)]
pub struct AgentEnv {
    pub root: PathBuf,
    pub config: Arc<Config>,
    pub resolver: ModelResolver,
    pub cancel: Arc<AtomicBool>,
    /// Permisos y preguntas a la persona; los subagentes usan los mismos que el agente principal.
    pub perms: Arc<Permissions>,
}

/// Coste en dólares de los tokens usados según el precio del catálogo (0 si el catálogo no lo trae).
pub fn cost_usd(m: &CloudModel, input: u64, output: u64) -> f64 {
    (input as f64 * m.input_cost.unwrap_or(0.0) + output as f64 * m.output_cost.unwrap_or(0.0)) / 1_000_000.0
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
}

fn image_data_urls(paths: &[String]) -> Vec<String> {
    use base64::Engine;
    paths
        .iter()
        .filter_map(|p| std::fs::read(p).ok().map(|b| format!("data:{};base64,{}", mime_for(p), base64::engine::general_purpose::STANDARD.encode(b))))
        .collect()
}

/// Cuenta llamadas idénticas seguidas para cortar a un modelo que se queda repitiendo lo mismo.
#[derive(Default)]
struct RepeatGuard {
    last: Option<(String, usize)>,
}

impl RepeatGuard {
    /// `true` si esta llamada ya se hizo `MAX_REPEATS` veces seguidas y no debe ejecutarse otra vez.
    fn blocked(&mut self, name: &str, args: &Value) -> bool {
        let key = format!("{name}:{args}");
        let n = match &self.last {
            Some((k, n)) if *k == key => n + 1,
            _ => 1,
        };
        self.last = Some((key, n));
        n > MAX_REPEATS
    }
}

// ---------- Herramientas propias del agente: skills y subagentes ----------

fn function(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description,
        "parameters": { "type": "object", "properties": properties, "required": required } } })
}

fn use_skill_spec() -> Value {
    function("use_skill", "Load a skill (specialised instructions) by name, or one of its supporting files with `file`. Do this before starting a task that matches a skill.",
        json!({ "name": { "type": "string" }, "file": { "type": "string", "description": "Optional supporting file inside the skill folder" } }), &["name"])
}

fn task_spec(agents: &[AgentDef]) -> Value {
    let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
    function("task", "Delegate a self-contained job to a subagent and get its final report. The subagent does not see this conversation: put everything it needs in `prompt`. Call it several times in one reply to run jobs in parallel.",
        json!({ "agent": { "type": "string", "enum": names }, "description": { "type": "string", "description": "3-6 word summary shown to the user" }, "prompt": { "type": "string" } }),
        &["agent", "description", "prompt"])
}

/// Herramientas de un subagente: las del modo, filtradas por lo que su definición declara.
fn subagent_specs(mode: Mode, def: &AgentDef, has_skills: bool) -> Vec<Spec> {
    let mut specs = llm::specs_from_openai(&agenttools::schema(mode));
    if let Some(allowed) = &def.tools {
        specs.retain(|s| allowed.contains(&s.name));
    }
    if has_skills && def.tools.as_ref().is_none_or(|t| t.contains("read_file")) {
        specs.extend(llm::specs_from_openai(&json!([use_skill_spec()])));
    }
    specs
}

fn clip(mut s: String, max: usize) -> String {
    if s.chars().count() > max {
        s = s.chars().take(max).collect();
        s.push_str("\n… (truncated)");
    }
    s
}

fn use_skill(config: &Config, args: &Value) -> Outcome {
    let name = args["name"].as_str().unwrap_or("").to_string();
    let ui = json!({ "name": name });
    let Some(skill) = config.skill(&name) else {
        let known: Vec<&str> = config.skills.iter().map(|s| s.name.as_str()).collect();
        return Outcome { ui_name: "Skill", ui_input: ui, result: trf("No existe la skill «{name}». Disponibles: {list}", &[("name", &name), ("list", &known.join(", "))]), is_error: true };
    };
    if let Some(file) = args["file"].as_str().filter(|f| !f.trim().is_empty()) {
        return match agentconfig::read_skill_file(skill, file) {
            Ok(t) => Outcome { ui_name: "Skill", ui_input: json!({ "name": name, "file": file }), result: t, is_error: false },
            Err(e) => Outcome { ui_name: "Skill", ui_input: json!({ "name": name, "file": file }), result: e, is_error: true },
        };
    }
    let files = agentconfig::skill_files(skill);
    let mut text = skill.body.clone();
    if !files.is_empty() {
        text.push_str(&format!("\n\n(Supporting files, readable with use_skill and `file`: {})", files.join(", ")));
    }
    Outcome { ui_name: "Skill", ui_input: ui, result: text, is_error: false }
}

/// Lo que devuelve un subagente al agente que lo lanzó.
struct TaskResult {
    outcome: Outcome,
    proposed: Vec<(String, String)>,
    input: u64,
    output: u64,
    cost: f64,
}

/// Ejecuta un subagente hasta que entrega su informe. Devuelve un futuro «en caja» porque `converse` y esta función se llaman entre sí.
fn run_task(env: AgentEnv, mode: Mode, parent: CloudModel, args: Value) -> Pin<Box<dyn Future<Output = TaskResult> + Send>> {
    Box::pin(async move {
        let agent_name = args["agent"].as_str().unwrap_or("").to_string();
        let description = args["description"].as_str().unwrap_or("").to_string();
        let ui = json!({ "agent": agent_name, "description": description });
        let fail = |msg: String| TaskResult { outcome: Outcome { ui_name: "Task", ui_input: ui.clone(), result: msg, is_error: true }, proposed: vec![], input: 0, output: 0, cost: 0.0 };
        let prompt = args["prompt"].as_str().unwrap_or("").trim().to_string();
        if prompt.is_empty() {
            return fail(tr("Falta el encargo (prompt) para el subagente.").to_string());
        }
        let Some(def) = env.config.agent(&agent_name).cloned() else {
            let known: Vec<&str> = env.config.agents.iter().map(|a| a.name.as_str()).collect();
            return fail(trf("No existe el subagente «{name}». Disponibles: {list}", &[("name", &agent_name), ("list", &known.join(", "))]));
        };
        // Otro modelo si la definición lo pide y se puede usar; si no, el mismo que el agente principal.
        let model = def.model.as_deref().and_then(|m| (env.resolver)(m)).unwrap_or(parent);
        let system = format!(
            "{}\n\n# Your role\n{}\n\nYou are a subagent working for the main coding agent. Do the job in the prompt, then reply with a concise final report: the main agent sees only your last message, not your tool calls. Do not ask questions; make reasonable assumptions and say what you assumed.{}",
            agenttools::system_prompt(&env.root, mode),
            def.prompt,
            env.config.prompt_addendum(false),
        );
        let specs = subagent_specs(mode, &def, !env.config.skills.is_empty());
        let msgs = vec![Msg::User { text: prompt, images: vec![] }];
        match converse(&env, &model, &system, &specs, mode, msgs, false, MAX_SUBAGENT_ROUNDS, &def.name, None).await {
            Ok(c) => {
                let report = if c.final_text.trim().is_empty() { tr("(El subagente terminó sin informe.)").to_string() } else { c.final_text };
                let header = trf("[Subagente {name}: {n} llamadas a herramientas]", &[("name", &def.name), ("n", &c.tool_calls)]);
                TaskResult { outcome: Outcome { ui_name: "Task", ui_input: ui, result: clip(format!("{header}\n{report}"), MAX_REPORT_CHARS), is_error: false }, proposed: c.proposed, input: c.input, output: c.output, cost: c.cost }
            }
            Err(e) => fail(e),
        }
    })
}

// ---------- Bucle ----------

struct Converse {
    final_text: String,
    input: u64,
    output: u64,
    cost: f64,
    proposed: Vec<(String, String)>,
    tool_calls: usize,
}

const PARAGRAPH: &str = "\n\n";

type Events<'a> = Option<&'a (dyn Fn(Value) + Send + Sync)>;

/// Pide al modelo un resumen de los mensajes viejos. Suma su coste a la respuesta.
async fn summarize(ep: &Endpoint<'_>, model_id: &str, old: &[Msg], cancel: &AtomicBool, out: &mut Converse, model: &CloudModel) -> Result<String, String> {
    let system = "You summarize the earlier part of a coding session so the work can continue with less context. Write a dense summary in the same language the user used: the user's goal, what was done (files changed and why), what was learned about the project, decisions and constraints, and what is still pending. Keep file paths and names exact. Do not invent anything and do not call tools.";
    let mut req = old.to_vec();
    req.push(Msg::User { text: "Summarize everything above as instructed. Reply with the summary only.".into(), images: vec![] });
    let r = llm::stream_round(ep, model_id, system, &req, &[], Some(2_000), cancel, |_| {}).await?;
    out.input += r.usage.input;
    out.output += r.usage.output;
    out.cost += cost_usd(model, r.usage.input, r.usage.output);
    let text = r.text.trim().to_string();
    if text.is_empty() { Err(tr("El resumen salió vacío.").into()) } else { Ok(text) }
}

/// Una conversación con herramientas: la usan el agente principal (con `events`, que va al panel) y los subagentes (sin ellos).
#[allow(clippy::too_many_arguments)]
async fn converse(
    env: &AgentEnv,
    model: &CloudModel,
    system: &str,
    specs: &[Spec],
    mode: Mode,
    mut msgs: Vec<Msg>,
    can_task: bool,
    max_rounds: usize,
    agent: &str,
    events: Events<'_>,
) -> Result<Converse, String> {
    let emit = |v: Value| {
        if let Some(e) = events {
            e(v)
        }
    };
    let ep = Endpoint { protocol: model.protocol, base: &model.base_url, key: &model.key };
    let max_tokens = (model.max_output > 0).then(|| model.max_output.min(16_384));
    let stamp = Instant::now().elapsed().as_nanos() ^ (std::process::id() as u128) << 64 ^ (rand_part() as u128);
    let mut out = Converse { final_text: String::new(), input: 0, output: 0, cost: 0.0, proposed: Vec::new(), tool_calls: 0 };
    let mut session = Session { root: &env.root, mode, cancel: env.cancel.clone(), perms: env.perms.clone(), agent: agent.to_string(), proposed: Vec::new(), todos: Vec::new(), memory: if agent.is_empty() { env.config.memory_store.clone() } else { None } };
    let mut guard = RepeatGuard::default();

    for round in 0..max_rounds {
        // Si la conversación se acerca al límite del modelo, se vacían los resultados de herramientas más viejos.
        agenttools::prune_context(&mut msgs, model.context);
        let mut compacted = false;
        // Si aun así no cabe, lo viejo se resume en un solo mensaje y se conserva lo reciente.
        if let Some(cut) = agenttools::compaction_cut(&msgs, model.context) {
            if let Ok(summary) = summarize(&ep, &model.model, &msgs[..cut], &env.cancel, &mut out, model).await {
                let tail = msgs.split_off(cut);
                msgs = vec![Msg::User { text: format!("[Summary of the earlier part of this conversation, written by you to save space]\n{summary}"), images: vec![] }];
                msgs.extend(tail);
                compacted = true;
            }
        }
        let turn = format!("cloud_{stamp:x}_{round}");
        emit(json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "id": turn } } }));
        emit(json!({ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } } }));
        if compacted {
            let notice = format!("_{}_{PARAGRAPH}", tr("La conversación era larga: resumí lo anterior para seguir."));
            emit(json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": notice } } }));
        }
        let r = llm::stream_round(&ep, &model.model, system, &msgs, specs, max_tokens, &env.cancel, |piece| {
            emit(json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": piece } } }));
        })
        .await?;
        out.input += r.usage.input;
        out.output += r.usage.output;
        out.cost += cost_usd(model, r.usage.input, r.usage.output);
        let mut text = r.text.clone();
        let mut content = Vec::new();

        if r.calls.is_empty() && !session.proposed.is_empty() {
            // Las ediciones propuestas se añaden como bloques `path=…` para que el panel muestre el botón de revisión.
            let mut appendix = String::new();
            for (p, body) in &session.proposed {
                if !text.contains(&format!("path={p}")) {
                    let fence = localai::fence_for_content(body);
                    appendix.push_str(&format!("\n\n{fence}{} path={p}\n{body}\n{fence}", localai::lang_for_path(p)));
                }
            }
            if !appendix.is_empty() {
                emit(json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": appendix } } }));
                text.push_str(&appendix);
            }
        }
        emit(json!({ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 } }));
        content.push(json!({ "type": "text", "text": text }));

        // Cada llamada: o ya tiene resultado, o es un subagente en marcha. Los subagentes de una misma respuesta corren a la vez.
        enum Slot {
            Done(Outcome),
            Task(tauri::async_runtime::JoinHandle<TaskResult>),
        }
        let mut slots: Vec<Slot> = Vec::new();
        for call in &r.calls {
            out.tool_calls += 1;
            let slot = if guard.blocked(&call.name, &call.args) {
                Slot::Done(Outcome { ui_name: "Tool", ui_input: json!({ "name": call.name }), result: tr("Ya hiciste exactamente esta llamada varias veces seguidas. Prueba otra cosa o responde con lo que tienes.").to_string(), is_error: true })
            } else if call.name == "task" && can_task {
                Slot::Task(tauri::async_runtime::spawn(run_task(env.clone(), mode, model.clone(), call.args.clone())))
            } else if call.name == "use_skill" && !env.config.skills.is_empty() {
                Slot::Done(use_skill(&env.config, &call.args))
            } else {
                let hooks = &env.config.hooks;
                match hooks.pre(&env.root, &call.name, &call.args, &env.cancel).await {
                    Err(reason) => Slot::Done(Outcome { ui_name: "Hook", ui_input: json!({ "tool": call.name }), result: reason, is_error: true }),
                    Ok(()) => {
                        let mut done = agenttools::dispatch(&mut session, &call.name, &call.args).await;
                        if hooks.has_any() {
                            done.result.push_str(&hooks.post(&env.root, &call.name, &call.args, &env.cancel).await);
                        }
                        Slot::Done(done)
                    }
                }
            };
            slots.push(slot);
        }
        let mut results: Vec<(String, String, String, String, bool)> = Vec::new();
        for (k, (call, slot)) in r.calls.iter().zip(slots).enumerate() {
            let ui_id = format!("{turn}_t{k}");
            let outcome = match slot {
                Slot::Done(o) => o,
                Slot::Task(handle) => match handle.await {
                    Ok(t) => {
                        out.input += t.input;
                        out.output += t.output;
                        out.cost += t.cost;
                        for (p, body) in t.proposed {
                            session.proposed.retain(|(existing, _)| existing != &p);
                            session.proposed.push((p, body));
                        }
                        t.outcome
                    }
                    Err(e) => Outcome { ui_name: "Task", ui_input: json!({ "agent": call.args["agent"] }), result: e.to_string(), is_error: true },
                },
            };
            content.push(json!({ "type": "tool_use", "id": ui_id, "name": outcome.ui_name, "input": outcome.ui_input }));
            results.push((ui_id, call.id.clone(), call.name.clone(), outcome.result, outcome.is_error));
        }
        emit(json!({ "type": "assistant", "message": { "id": turn, "content": content } }));
        emit(json!({ "type": "stream_event", "event": { "type": "message_stop" } }));
        msgs.push(Msg::Assistant { text: text.clone(), calls: r.calls.clone() });
        if results.is_empty() {
            out.final_text = text;
            break;
        }
        for (ui_id, model_id, name, result, is_error) in results {
            emit(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": ui_id, "content": result, "is_error": is_error }] } }));
            msgs.push(Msg::Tool { id: model_id, name, content: result });
        }
        if env.cancel.load(Ordering::Relaxed) {
            return Err(tr("La conversación se detuvo.").into());
        }
        if round + 1 == max_rounds {
            out.final_text = tr("El modelo siguió pidiendo herramientas sin terminar de responder; se detuvo por el límite de vueltas.").into();
        }
    }
    out.proposed = session.proposed;
    Ok(out)
}

/// Un número que cambia en cada llamada, para que los identificadores de turno de dos subagentes no choquen.
fn rand_part() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Conversación completa con herramientas. `emit` recibe cada evento (una línea JSON) para el panel.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    model: CloudModel,
    root: PathBuf,
    conversation: String,
    history: Vec<HistoryMsg>,
    prompt: String,
    images: Vec<String>,
    mode: String,
    cancel: Arc<AtomicBool>,
    emit: Arc<dyn Fn(String) + Send + Sync>,
    config: Arc<Config>,
    resolver: ModelResolver,
    perms: Arc<Permissions>,
) -> Result<(), String> {
    // `/plan …` se atiende siempre en solo lectura: el agente explora y propone, no toca nada.
    let mode = if agentconfig::is_plan_request(&prompt) { Mode::Read } else { Mode::parse(&mode) };
    let started = Instant::now();
    let send = |v: Value| emit(v.to_string());
    send(json!({ "type": "system", "subtype": "init", "session_id": conversation, "model": model.model }));
    let env = AgentEnv { root: root.clone(), config: config.clone(), resolver, cancel, perms };

    let system = format!("{}{}", agenttools::system_prompt(&root, mode), config.prompt_addendum(true));
    let mut specs = llm::specs_from_openai(&agenttools::schema(mode));
    let mut extra = vec![task_spec(&config.agents)];
    if !config.skills.is_empty() {
        extra.push(use_skill_spec());
    }
    specs.extend(llm::specs_from_openai(&Value::Array(extra)));

    let mut msgs: Vec<Msg> = history
        .iter()
        .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty())
        .map(|m| if m.role == "user" { Msg::User { text: m.content.clone(), images: vec![] } } else { Msg::Assistant { text: m.content.clone(), calls: vec![] } })
        .collect();
    // `/comando argumentos` se sustituye por la plantilla del comando; la persona sigue viendo lo que escribió.
    let prompt = agentconfig::expand_command(&config.commands, &prompt).unwrap_or(prompt);
    let urls = if model.images { image_data_urls(&images) } else { Vec::new() };
    let note = if !images.is_empty() && !model.images { format!("\n\n{}", tr("(La persona adjuntó imágenes, pero este modelo no las admite.)")) } else { String::new() };
    msgs.push(Msg::User { text: format!("{prompt}{note}"), images: urls });

    let sink = |v: Value| emit(v.to_string());
    let c = converse(&env, &model, &system, &specs, mode, msgs, true, MAX_ROUNDS, "", Some(&sink)).await?;
    send(json!({
        "type": "result", "subtype": "success", "is_error": false, "session_id": conversation,
        "duration_ms": started.elapsed().as_millis() as u64, "total_cost_usd": c.cost, "result": c.final_text,
        "usage": { "input_tokens": c.input, "output_tokens": c.output }
    }));
    Ok(())
}

/// Nombres de herramientas que se ofrecen al agente principal en un modo, para pruebas y documentación.
pub fn main_tool_names(mode: Mode, config: &Config) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = llm::specs_from_openai(&agenttools::schema(mode)).into_iter().map(|s| s.name).collect();
    set.insert("task".into());
    if !config.skills.is_empty() {
        set.insert("use_skill".into());
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> CloudModel {
        CloudModel { provider_name: "X".into(), protocol: Protocol::OpenAi, base_url: "http://127.0.0.1:9/v1".into(), key: "k".into(), model: "m".into(), images: false, context: 0, max_output: 0, input_cost: Some(3.0), output_cost: Some(15.0) }
    }

    #[test]
    fn calcula_el_coste_con_el_precio_del_catalogo() {
        let c = cost_usd(&model(), 1_000_000, 100_000);
        assert!((c - 4.5).abs() < 1e-9, "{c}");
        let gratis = CloudModel { input_cost: None, output_cost: None, ..model() };
        assert_eq!(cost_usd(&gratis, 5_000_000, 5_000_000), 0.0);
    }

    #[test]
    fn el_tipo_de_imagen_sale_de_la_extension() {
        assert_eq!(mime_for("a/b.PNG"), "image/png");
        assert_eq!(mime_for("x.jpeg"), "image/jpeg");
        assert_eq!(mime_for("x.webp"), "image/webp");
        assert_eq!(mime_for("sin-extension"), "image/png");
    }

    #[test]
    fn corta_al_modelo_que_repite_la_misma_llamada() {
        let mut g = RepeatGuard::default();
        let a = json!({ "path": "a" });
        assert!(!g.blocked("read_file", &a) && !g.blocked("read_file", &a) && !g.blocked("read_file", &a));
        assert!(g.blocked("read_file", &a));
        // Otra llamada reinicia la cuenta.
        assert!(!g.blocked("read_file", &json!({ "path": "b" })));
        assert!(!g.blocked("read_file", &a));
    }

    /// Servidor simulado que contesta, en orden de llegada, una respuesta SSE por solicitud; guarda los cuerpos recibidos.
    fn mock_server(replies: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for reply in replies {
                let (mut s, _) = listener.accept().unwrap();
                let mut req = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let n = s.read(&mut buf).unwrap();
                    req.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&req).into_owned();
                    if let Some(pos) = text.find("\r\n\r\n") {
                        let len = text[..pos].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if req.len() >= pos + 4 + len {
                            bodies.push(text[pos + 4..].to_string());
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len());
                s.write_all(head.as_bytes()).unwrap();
                s.write_all(reply.as_bytes()).unwrap();
            }
            bodies
        });
        (format!("http://127.0.0.1:{port}/v1"), h)
    }

    /// Un evento SSE de OpenAI con este objeto JSON.
    fn sse(v: Value) -> String {
        format!("data: {v}\n\n")
    }

    /// Una respuesta del modelo que pide estas herramientas (`(id, nombre, argumentos)`).
    fn tool_reply(calls: &[(&str, &str, Value)]) -> String {
        let list: Vec<Value> = calls.iter().enumerate().map(|(i, (id, name, args))| json!({ "index": i, "id": id, "function": { "name": name, "arguments": args.to_string() } })).collect();
        sse(json!({ "choices": [{ "delta": { "tool_calls": list } }] })) + "data: [DONE]\n\n"
    }

    fn text_reply(t: &str) -> String {
        sse(json!({ "choices": [{ "delta": { "content": t } }] })) + "data: [DONE]\n\n"
    }

    fn collect_events() -> (Arc<std::sync::Mutex<Vec<Value>>>, Arc<dyn Fn(String) + Send + Sync>) {
        let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = events.clone();
        (events, Arc::new(move |l| sink.lock().unwrap().push(serde_json::from_str(&l).unwrap())))
    }

    fn project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pulso-agent-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.ts"), "export const respuesta = 42;\n").unwrap();
        dir
    }

    fn put(dir: &std::path::Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn no_resolver() -> ModelResolver {
        Arc::new(|_| None)
    }

    /// Ejecuta una conversación contra un servidor simulado y devuelve los eventos del panel y las solicitudes recibidas.
    fn go_with(m: CloudModel, dir: &PathBuf, mode: &str, prompt: &str, config: Config, resolver: ModelResolver, replies: Vec<String>) -> (Vec<Value>, Vec<Value>) {
        go_perms(m, dir, mode, prompt, config, resolver, Arc::new(Permissions::fixed(crate::agentperms::Decision::Once)), replies)
    }

    #[allow(clippy::too_many_arguments)]
    fn go_perms(m: CloudModel, dir: &PathBuf, mode: &str, prompt: &str, config: Config, resolver: ModelResolver, perms: Arc<Permissions>, replies: Vec<String>) -> (Vec<Value>, Vec<Value>) {
        let (base, server) = mock_server(replies);
        let (events, emit) = collect_events();
        tauri::async_runtime::block_on(run(CloudModel { base_url: base, ..m }, dir.clone(), "c".into(), vec![], prompt.into(), vec![], mode.into(), Arc::new(AtomicBool::new(false)), emit, Arc::new(config), resolver, perms)).unwrap();
        let bodies: Vec<Value> = server.join().unwrap().iter().map(|b| serde_json::from_str(b).unwrap()).collect();
        let ev = events.lock().unwrap().clone();
        (ev, bodies)
    }

    fn go(m: CloudModel, dir: &PathBuf, mode: &str, replies: Vec<String>) -> (Vec<Value>, Vec<Value>) {
        go_with(m, dir, mode, "haz algo", Config::default(), no_resolver(), replies)
    }

    fn tool_names(body: &Value) -> Vec<String> {
        body["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect()
    }

    fn system_of(body: &Value) -> String {
        body["messages"][0]["content"].as_str().unwrap().to_string()
    }

    #[test]
    fn el_agente_lee_un_archivo_y_responde_con_su_coste() {
        let dir = project("lee");
        let first = sse(json!({ "choices": [{ "delta": { "content": "Voy a mirar." } }] }))
            + &sse(json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "t1", "function": { "name": "read_file", "arguments": "{\"path\":\"src/main.ts\"}" } }] } }] }))
            + &sse(json!({ "choices": [], "usage": { "prompt_tokens": 1_000_000, "completion_tokens": 0 } }))
            + "data: [DONE]\n\n";
        let second = sse(json!({ "choices": [{ "delta": { "content": "La respuesta es 42." } }] }))
            + &sse(json!({ "choices": [], "usage": { "prompt_tokens": 0, "completion_tokens": 100_000 } }))
            + "data: [DONE]\n\n";
        let (ev, bodies) = go(model(), &dir, "read", vec![first, second]);
        assert!(ev.iter().any(|e| e["type"] == "assistant" && e["message"]["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "tool_use" && b["name"] == "Read"))));
        let result = ev.iter().find(|e| e["type"] == "user").unwrap();
        assert!(result["message"]["content"][0]["content"].as_str().unwrap().contains("respuesta = 42"));
        let last = ev.last().unwrap();
        assert_eq!((last["type"].as_str(), last["result"].as_str()), (Some("result"), Some("La respuesta es 42.")));
        assert!((last["total_cost_usd"].as_f64().unwrap() - 4.5).abs() < 1e-9);
        let msgs = bodies[1]["messages"].as_array().unwrap();
        assert_eq!((msgs.last().unwrap()["role"].as_str(), msgs.last().unwrap()["tool_call_id"].as_str()), (Some("tool"), Some("t1")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn en_modo_agente_edita_ejecuta_y_verifica() {
        let dir = project("agente");
        let edit = json!({ "path": "src/main.ts", "old_string": "42", "new_string": "43" });
        let cmd = json!({ "command": if cfg!(windows) { "Get-Content src/main.ts" } else { "cat src/main.ts" } });
        let first = tool_reply(&[("e1", "edit_file", edit), ("r1", "run_command", cmd)]);
        let (ev, bodies) = go(model(), &dir, "full", vec![first, text_reply("Listo.")]);
        assert!(std::fs::read_to_string(dir.join("src/main.ts")).unwrap().contains("respuesta = 43"));
        let results: Vec<&Value> = ev.iter().filter(|e| e["type"] == "user").collect();
        assert_eq!(results.len(), 2);
        assert!(results[1]["message"]["content"][0]["content"].as_str().unwrap().contains("respuesta = 43"), "{}", results[1]);
        let names: Vec<&str> = ev.iter().filter(|e| e["type"] == "assistant").flat_map(|e| e["message"]["content"].as_array().unwrap().iter()).filter(|b| b["type"] == "tool_use").map(|b| b["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Edit", "Command"]);
        let offered = tool_names(&bodies[0]);
        assert!(offered.contains(&"edit_file".into()) && offered.contains(&"run_command".into()) && offered.contains(&"web_fetch".into()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn en_modo_editar_la_edicion_es_una_propuesta_revisable() {
        let dir = project("editar");
        let edit = json!({ "path": "src/main.ts", "old_string": "42", "new_string": "99" });
        let (ev, _) = go(model(), &dir, "edit", vec![tool_reply(&[("e1", "edit_file", edit)]), text_reply("Propuse el cambio.")]);
        assert!(std::fs::read_to_string(dir.join("src/main.ts")).unwrap().contains("42"));
        let last = ev.last().unwrap()["result"].as_str().unwrap().to_string();
        assert!(last.contains("path=src/main.ts") && last.contains("respuesta = 99"), "{last}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn en_solo_lectura_no_se_ofrece_ni_se_acepta_escribir() {
        let dir = project("ro");
        let edit = json!({ "path": "a.txt", "content": "x" });
        let (ev, bodies) = go(model(), &dir, "read", vec![tool_reply(&[("e1", "write_file", edit)]), text_reply("No puedo editar.")]);
        let result = ev.iter().find(|e| e["type"] == "user").unwrap();
        assert_eq!(result["message"]["content"][0]["is_error"], true);
        let offered = tool_names(&bodies[0]);
        assert!(!offered.contains(&"write_file".into()) && !offered.contains(&"edit_file".into()));
        assert!(!dir.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corta_el_bucle_si_el_modelo_repite_la_misma_llamada() {
        let dir = project("repite");
        let same = json!({ "path": "src/main.ts" });
        let mut replies: Vec<String> = (0..5).map(|i| tool_reply(&[(&format!("r{i}"), "read_file", same.clone())])).collect();
        replies.push(text_reply("Ya está."));
        let (ev, _) = go(model(), &dir, "read", replies);
        let results: Vec<&Value> = ev.iter().filter(|e| e["type"] == "user").collect();
        assert_eq!(results.len(), 5);
        assert_eq!(results.iter().filter(|r| r["message"]["content"][0]["is_error"] == true).count(), 2);
        assert_eq!(ev.last().unwrap()["result"], "Ya está.");
        let _ = std::fs::remove_dir_all(dir);
    }

    // ----- Fase 3 -----

    #[test]
    fn las_instrucciones_del_proyecto_y_el_catalogo_llegan_al_modelo() {
        let dir = project("instr");
        put(&dir, "AGENTS.md", "Usa siempre pnpm.");
        put(&dir, ".pulso/skills/deploy/SKILL.md", "---\ndescription: Publica la app\n---\nPasos.");
        let config = Config::load_with_home(&dir, None);
        let (_, bodies) = go_with(model(), &dir, "read", "hola", config, no_resolver(), vec![text_reply("ok")]);
        let sys = system_of(&bodies[0]);
        assert!(sys.contains("Usa siempre pnpm.") && sys.contains("- deploy: Publica la app") && sys.contains("- explore:"), "{sys}");
        let offered = tool_names(&bodies[0]);
        assert!(offered.contains(&"task".into()) && offered.contains(&"use_skill".into()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn una_skill_se_carga_a_demanda_con_sus_archivos_de_apoyo() {
        let dir = project("skill");
        put(&dir, ".pulso/skills/deploy/SKILL.md", "---\ndescription: Publica la app\n---\nPaso 1: compila. Paso 2: sube.");
        put(&dir, ".pulso/skills/deploy/checklist.md", "- revisar versión");
        let config = Config::load_with_home(&dir, None);
        let first = tool_reply(&[("s1", "use_skill", json!({ "name": "deploy" })), ("s2", "use_skill", json!({ "name": "deploy", "file": "checklist.md" })), ("s3", "use_skill", json!({ "name": "no-existe" }))]);
        let (ev, bodies) = go_with(model(), &dir, "read", "publica", config, no_resolver(), vec![first, text_reply("Publicado.")]);
        let results: Vec<&Value> = ev.iter().filter(|e| e["type"] == "user").collect();
        assert!(results[0]["message"]["content"][0]["content"].as_str().unwrap().contains("Paso 1: compila") && results[0]["message"]["content"][0]["content"].as_str().unwrap().contains("checklist.md"));
        assert!(results[1]["message"]["content"][0]["content"].as_str().unwrap().contains("revisar versión"));
        assert_eq!(results[2]["message"]["content"][0]["is_error"], true);
        assert_eq!(bodies.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_comando_con_barra_se_expande_antes_de_enviarse() {
        let dir = project("cmd");
        put(&dir, ".pulso/commands/revisar.md", "Revisa $1 y busca errores. Contexto: $ARGUMENTS");
        let config = Config::load_with_home(&dir, None);
        let (_, bodies) = go_with(model(), &dir, "read", "/revisar src/main.ts con cuidado", config, no_resolver(), vec![text_reply("ok")]);
        let user = bodies[0]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_string();
        assert_eq!(user, "Revisa src/main.ts y busca errores. Contexto: src/main.ts con cuidado");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_subagente_hace_el_trabajo_y_devuelve_solo_su_informe() {
        let dir = project("sub");
        let principal1 = tool_reply(&[("t1", "task", json!({ "agent": "explore", "description": "Buscar respuesta", "prompt": "Dime cuánto vale respuesta en src/main.ts" }))]);
        let sub1 = tool_reply(&[("s1", "read_file", json!({ "path": "src/main.ts" }))]);
        let sub2 = text_reply("Informe: respuesta vale 42 (src/main.ts:1).");
        let principal2 = text_reply("El subagente dice que vale 42.");
        let (ev, bodies) = go(model(), &dir, "full", vec![principal1, sub1, sub2, principal2]);
        assert_eq!(bodies.len(), 4);
        // El panel ve una herramienta «Task» con su informe; no ve las llamadas internas del subagente.
        let task_use = ev.iter().filter(|e| e["type"] == "assistant").flat_map(|e| e["message"]["content"].as_array().unwrap().iter()).find(|b| b["type"] == "tool_use").unwrap();
        assert_eq!((task_use["name"].as_str(), task_use["input"]["agent"].as_str()), (Some("Task"), Some("explore")));
        assert_eq!(ev.iter().filter(|e| e["type"] == "user").count(), 1);
        let report = ev.iter().find(|e| e["type"] == "user").unwrap()["message"]["content"][0]["content"].as_str().unwrap().to_string();
        assert!(report.contains("Informe: respuesta vale 42") && report.contains("[Subagente explore: 1"), "{report}");
        // El subagente trabajó con su propio contexto y solo con herramientas de lectura, aunque el principal está en modo Agente y no puede delegar.
        let sub_tools = tool_names(&bodies[1]);
        assert!(sub_tools.contains(&"grep".into()) && sub_tools.contains(&"read_file".into()));
        assert!(!sub_tools.contains(&"run_command".into()) && !sub_tools.contains(&"edit_file".into()) && !sub_tools.contains(&"write_file".into()) && !sub_tools.contains(&"web_fetch".into()) && !sub_tools.contains(&"task".into()), "{sub_tools:?}");
        assert!(system_of(&bodies[1]).contains("exploration specialist"));
        assert_eq!(bodies[1]["messages"].as_array().unwrap().len(), 2);
        // Al principal le llegó el informe, con el id de su llamada.
        let msgs = bodies[3]["messages"].as_array().unwrap();
        assert_eq!((msgs.last().unwrap()["role"].as_str(), msgs.last().unwrap()["tool_call_id"].as_str()), (Some("tool"), Some("t1")));
        assert!(msgs.last().unwrap()["content"].as_str().unwrap().contains("respuesta vale 42"));
        assert_eq!(ev.last().unwrap()["result"], "El subagente dice que vale 42.");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn varios_subagentes_de_una_respuesta_corren_a_la_vez_y_suman_su_coste() {
        let dir = project("par");
        let call = |id: &str, n: &str| (id.to_string(), "task".to_string(), json!({ "agent": "general", "description": n, "prompt": format!("trabajo {n}") }));
        let (a, b) = (call("t1", "uno"), call("t2", "dos"));
        let principal1 = tool_reply(&[(&a.0, &a.1, a.2), (&b.0, &b.1, b.2)]);
        // Cada subagente responde con un informe y 1 M de tokens de entrada ($3).
        let sub = sse(json!({ "choices": [{ "delta": { "content": "Hecho." } }] })) + &sse(json!({ "choices": [], "usage": { "prompt_tokens": 1_000_000, "completion_tokens": 0 } })) + "data: [DONE]\n\n";
        let (ev, bodies) = go(model(), &dir, "read", vec![principal1, sub.clone(), sub, text_reply("Ambos terminaron.")]);
        assert_eq!(bodies.len(), 4);
        let results: Vec<&Value> = ev.iter().filter(|e| e["type"] == "user").collect();
        assert_eq!(results.len(), 2);
        let ids: Vec<&str> = results.iter().map(|r| r["message"]["content"][0]["tool_use_id"].as_str().unwrap()).collect();
        assert!(ids[0].ends_with("_t0") && ids[1].ends_with("_t1"), "{ids:?}");
        assert!(results.iter().all(|r| r["message"]["content"][0]["content"].as_str().unwrap().contains("Hecho.")));
        // Las dos respuestas de herramienta vuelven al principal en el orden en que las pidió.
        let msgs = bodies[3]["messages"].as_array().unwrap();
        let tools: Vec<&str> = msgs.iter().filter(|m| m["role"] == "tool").map(|m| m["tool_call_id"].as_str().unwrap()).collect();
        assert_eq!(tools, ["t1", "t2"]);
        // Coste: lo de los dos subagentes (2 × $3) más lo del principal (que no declaró tokens).
        assert!((ev.last().unwrap()["total_cost_usd"].as_f64().unwrap() - 6.0).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_subagente_puede_usar_otro_modelo_con_su_propio_servidor() {
        let dir = project("otro");
        put(&dir, ".pulso/agents/revisor.md", "---\ndescription: Revisa\ntools: Read\nmodel: otro/modelo-b\n---\nEres un revisor.");
        let config = Config::load_with_home(&dir, None);
        let (base_b, server_b) = mock_server(vec![text_reply("Revisado por el otro modelo.")]);
        let b = CloudModel { base_url: base_b, model: "modelo-b".into(), provider_name: "Otro".into(), ..model() };
        let resolver: ModelResolver = Arc::new(move |m| (m == "otro/modelo-b").then(|| b.clone()));
        let principal1 = tool_reply(&[("t1", "task", json!({ "agent": "revisor", "description": "Revisar", "prompt": "revisa" }))]);
        let (ev, bodies) = go_with(model(), &dir, "read", "pide una revisión", config, resolver, vec![principal1, text_reply("Listo.")]);
        // El principal solo habló con su servidor (2 solicitudes); el subagente fue al otro, con el nombre del otro modelo.
        assert_eq!(bodies.len(), 2);
        let b_req: Vec<Value> = server_b.join().unwrap().iter().map(|r| serde_json::from_str(r).unwrap()).collect();
        assert_eq!(b_req.len(), 1);
        assert_eq!(b_req[0]["model"], "modelo-b");
        assert!(ev.iter().find(|e| e["type"] == "user").unwrap()["message"]["content"][0]["content"].as_str().unwrap().contains("Revisado por el otro modelo."));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_subagente_no_hereda_mas_permisos_que_el_agente_que_lo_lanza() {
        let dir = project("perm");
        // El subagente declara Edit y Bash, pero el principal está en modo «Puede editar»: sus ediciones son propuestas y no tiene comandos libres.
        put(&dir, ".pulso/agents/editor.md", "---\ndescription: Edita\ntools: Read, Edit, Bash\n---\nEdita lo que te pidan.");
        let config = Config::load_with_home(&dir, None);
        let principal1 = tool_reply(&[("t1", "task", json!({ "agent": "editor", "description": "Editar", "prompt": "cambia 42 por 7 en src/main.ts" }))]);
        let sub1 = tool_reply(&[("e1", "edit_file", json!({ "path": "src/main.ts", "old_string": "42", "new_string": "7" })), ("c1", "run_command", json!({ "command": "git push --force" }))]);
        let (ev, bodies) = go_with(model(), &dir, "edit", "delega", config, no_resolver(), vec![principal1, sub1, text_reply("Propuse el cambio."), text_reply("Listo.")]);
        assert!(std::fs::read_to_string(dir.join("src/main.ts")).unwrap().contains("42"), "no debe escribir en disco");
        assert!(tool_names(&bodies[1]).contains(&"edit_file".into()));
        // El comando destructivo se rechazó por el modo, y la edición del subagente llegó al principal como propuesta revisable.
        let sub2_msgs = bodies[2]["messages"].as_array().unwrap();
        assert!(sub2_msgs.iter().any(|m| m["role"] == "tool" && m["content"].as_str().unwrap().contains("solo lectura") || m["content"].as_str().is_some_and(|c| c.to_lowercase().contains("read-only"))));
        let last = ev.last().unwrap()["result"].as_str().unwrap().to_string();
        assert!(last.contains("path=src/main.ts") && last.contains("respuesta = 7"), "{last}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_subagente_desconocido_o_sin_encargo_es_un_error_claro() {
        let dir = project("mal");
        let principal1 = tool_reply(&[("t1", "task", json!({ "agent": "fantasma", "description": "x", "prompt": "haz" })), ("t2", "task", json!({ "agent": "explore", "description": "y", "prompt": "  " }))]);
        let (ev, _) = go(model(), &dir, "read", vec![principal1, text_reply("Entendido.")]);
        let results: Vec<&Value> = ev.iter().filter(|e| e["type"] == "user").collect();
        assert!(results.iter().all(|r| r["message"]["content"][0]["is_error"] == true));
        assert!(results[0]["message"]["content"][0]["content"].as_str().unwrap().contains("explore"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn el_agente_principal_siempre_puede_delegar() {
        let names = main_tool_names(Mode::Read, &Config::default());
        assert!(names.contains("task") && !names.contains("use_skill") && names.contains("grep"));
    }

    // ----- Aprobación de comandos -----

    /// Aprobador que apunta lo que le preguntan y responde siempre lo mismo.
    struct Recorder {
        seen: std::sync::Mutex<Vec<crate::agentperms::ApprovalRequest>>,
        answer: crate::agentperms::Decision,
    }

    impl Recorder {
        fn new(answer: crate::agentperms::Decision) -> Arc<Recorder> {
            Arc::new(Recorder { seen: std::sync::Mutex::new(Vec::new()), answer })
        }
        fn asked(&self) -> Vec<crate::agentperms::ApprovalRequest> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl crate::agentperms::Approver for Recorder {
        fn ask(&self, req: crate::agentperms::ApprovalRequest) -> Pin<Box<dyn Future<Output = crate::agentperms::Decision> + Send>> {
            self.seen.lock().unwrap().push(req);
            let d = self.answer;
            Box::pin(async move { d })
        }
    }

    fn perms_with(approver: Arc<Recorder>) -> Arc<Permissions> {
        Arc::new(Permissions::new(approver, None, std::path::Path::new("."), Arc::new(AtomicBool::new(false))))
    }

    /// Un comando que deja un archivo `marca.txt`, para comprobar si de verdad se ejecutó.
    fn write_marker_command() -> Value {
        json!({ "command": if cfg!(windows) { "Set-Content -Path marca.txt -Value hola" } else { "echo hola > marca.txt" } })
    }

    #[test]
    fn en_modo_agente_pregunta_antes_de_ejecutar_y_si_se_deniega_no_se_ejecuta() {
        let dir = project("aprob-no");
        let approver = Recorder::new(crate::agentperms::Decision::Deny);
        let first = tool_reply(&[("c1", "run_command", write_marker_command())]);
        let (ev, _) = go_perms(model(), &dir, "full", "crea la marca", Config::default(), no_resolver(), perms_with(approver.clone()), vec![first, text_reply("No pude ejecutarlo.")]);
        assert!(!dir.join("marca.txt").exists(), "se ejecutó aunque se denegó");
        let asked = approver.asked();
        assert_eq!(asked.len(), 1);
        assert_eq!((asked[0].tool, asked[0].risky, asked[0].agent.as_str()), (crate::agentperms::Tool::Command, false, ""));
        assert!(asked[0].detail.contains("marca.txt"));
        // El modelo recibió un error que le dice que no lo reintente.
        let result = ev.iter().find(|e| e["type"] == "user").unwrap();
        assert_eq!(result["message"]["content"][0]["is_error"], true);
        let text = result["message"]["content"][0]["content"].as_str().unwrap().to_lowercase();
        assert!(text.contains("reintentes") || text.contains("retry"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn si_se_aprueba_el_comando_se_ejecuta() {
        let dir = project("aprob-si");
        let approver = Recorder::new(crate::agentperms::Decision::Once);
        let first = tool_reply(&[("c1", "run_command", write_marker_command())]);
        let (ev, _) = go_perms(model(), &dir, "full", "crea la marca", Config::default(), no_resolver(), perms_with(approver.clone()), vec![first, text_reply("Hecho.")]);
        assert!(dir.join("marca.txt").exists());
        assert_eq!(approver.asked().len(), 1);
        assert_eq!(ev.iter().find(|e| e["type"] == "user").unwrap()["message"]["content"][0]["is_error"], false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn los_comandos_de_solo_lectura_no_molestan_y_en_otros_modos_no_se_pregunta() {
        let dir = project("aprob-ro");
        let approver = Recorder::new(crate::agentperms::Decision::Deny);
        // En modo Agente, `git status` no pregunta.
        let first = tool_reply(&[("c1", "run_command", json!({ "command": "git status" }))]);
        go_perms(model(), &dir, "full", "estado", Config::default(), no_resolver(), perms_with(approver.clone()), vec![first, text_reply("Visto.")]);
        assert!(approver.asked().is_empty());
        // En «Puede editar» un comando libre se rechaza por el modo, sin preguntar.
        let second = tool_reply(&[("c1", "run_command", write_marker_command())]);
        let (ev, _) = go_perms(model(), &dir, "edit", "crea la marca", Config::default(), no_resolver(), perms_with(approver.clone()), vec![second, text_reply("No.")]);
        assert!(approver.asked().is_empty() && !dir.join("marca.txt").exists());
        assert_eq!(ev.iter().find(|e| e["type"] == "user").unwrap()["message"]["content"][0]["is_error"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_gancho_previo_bloquea_la_herramienta_y_uno_posterior_comenta_el_resultado() {
        let dir = project("ganchos");
        let approver = Recorder::new(crate::agentperms::Decision::Once);
        // PreToolUse bloquea run_command con el código 2 (el comando no llega a ejecutarse); PostToolUse comenta glob.
        let mut config = Config::default();
        config.hooks = crate::agenthooks::Hooks { list: crate::agenthooks::parse_hooks(
            r#"{"hooks":{"PreToolUse":[{"matcher":"run_command","command":"echo 'prohibido por el gancho'; exit 2"}],
                         "PostToolUse":[{"matcher":"glob","command":"echo 'gancho: glob revisado'"}]}}"#, false) };
        let bloqueada = tool_reply(&[("c1", "run_command", write_marker_command())]);
        let (ev, _) = go_perms(model(), &dir, "full", "crea la marca", config.clone(), no_resolver(), perms_with(approver.clone()), vec![bloqueada, text_reply("No pude.")]);
        assert!(!dir.join("marca.txt").exists(), "el gancho no bloqueó el comando");
        assert!(approver.asked().is_empty(), "ni siquiera se llegó a preguntar");
        let r = ev.iter().find(|e| e["type"] == "user").unwrap();
        assert_eq!(r["message"]["content"][0]["is_error"], true);
        assert!(r["message"]["content"][0]["content"].as_str().unwrap().contains("prohibido por el gancho"));
        // PostToolUse añade su salida al resultado de glob.
        let buscar = tool_reply(&[("c1", "glob", json!({ "pattern": "**/*" }))]);
        let (ev2, _) = go_perms(model(), &dir, "full", "busca", config, no_resolver(), perms_with(approver), vec![buscar, text_reply("Listo.")]);
        let c2 = ev2.iter().find(|e| e["type"] == "user").unwrap()["message"]["content"][0]["content"].as_str().unwrap().to_string();
        assert!(c2.contains("[hook] gancho: glob revisado"), "{c2}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_subagente_pregunta_diciendo_quien_es() {
        let dir = project("aprob-sub");
        let approver = Recorder::new(crate::agentperms::Decision::Once);
        let principal1 = tool_reply(&[("t1", "task", json!({ "agent": "general", "description": "Crear marca", "prompt": "crea la marca" }))]);
        let sub1 = tool_reply(&[("c1", "run_command", write_marker_command())]);
        go_perms(model(), &dir, "full", "delega", Config::default(), no_resolver(), perms_with(approver.clone()), vec![principal1, sub1, text_reply("Listo."), text_reply("Hecho.")]);
        let asked = approver.asked();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].agent, "general");
        assert!(dir.join("marca.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn leer_la_web_tambien_se_pregunta_y_lo_privado_se_rechaza_sin_preguntar() {
        let dir = project("aprob-web");
        let approver = Recorder::new(crate::agentperms::Decision::Deny);
        let first = tool_reply(&[("w1", "web_fetch", json!({ "url": "https://docs.rs/serde" })), ("w2", "web_fetch", json!({ "url": "http://127.0.0.1:8080/x" }))]);
        let (ev, _) = go_perms(model(), &dir, "full", "lee la doc", Config::default(), no_resolver(), perms_with(approver.clone()), vec![first, text_reply("Vale.")]);
        let asked = approver.asked();
        // Solo preguntó por la dirección pública; la local se rechazó antes.
        assert_eq!(asked.len(), 1);
        assert_eq!((asked[0].tool, asked[0].detail.as_str()), (crate::agentperms::Tool::Web, "https://docs.rs/serde"));
        let results: Vec<&Value> = ev.iter().filter(|e| e["type"] == "user").collect();
        assert!(results.iter().all(|r| r["message"]["content"][0]["is_error"] == true));
        let _ = std::fs::remove_dir_all(dir);
    }
}
