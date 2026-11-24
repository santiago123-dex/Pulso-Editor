//! Ganchos (hooks) del agente propio: comandos que Pulso ejecuta **antes y después de cada herramienta**.
//!
//! Se configuran en `hooks.json`, en `~/.pulso/` (los tuyos, siempre) y en `.pulso/` del proyecto (solo si confías en él):
//!
//! ```json
//! { "hooks": {
//!     "PreToolUse":  [ { "matcher": "run_command|edit_file", "command": "node scripts/check.js", "timeout": 10 } ],
//!     "PostToolUse": [ { "matcher": "edit_file", "command": "npx prettier --check ." } ]
//! } }
//! ```
//!
//! - `matcher`: expresión regular sobre el nombre de la herramienta (`run_command`, `edit_file`, `write_file`…); sin ella vale para todas.
//! - El comando recibe `PULSO_HOOK_EVENT`, `PULSO_TOOL`, `PULSO_TOOL_INPUT` (JSON, recortado) y `PULSO_PROJECT` como variables de entorno
//!   y corre en la carpeta del proyecto, con un tiempo límite (10 s por defecto, 60 como máximo).
//! - `PreToolUse`: si termina con el código **2**, la herramienta **no se ejecuta** y el modelo recibe lo que el comando escribió.
//!   Cualquier otro resultado (otro código, error, tiempo agotado) no bloquea.
//! - `PostToolUse`: lo que el comando escribe se añade al resultado de la herramienta.
use crate::i18n::{tr, trf};
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::{atomic::AtomicBool, Arc};

const MAX_HOOKS: usize = 20;
const DEFAULT_TIMEOUT_SECS: u64 = 10;
const MAX_TIMEOUT_SECS: u64 = 60;
const MAX_OUTPUT_CHARS: usize = 1_000;
const MAX_INPUT_CHARS: usize = 8_000;
/// Código de salida con el que un gancho `PreToolUse` bloquea la herramienta.
pub const BLOCK_EXIT_CODE: i32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookEvent {
    Pre,
    Post,
}

impl HookEvent {
    fn name(self) -> &'static str {
        match self {
            HookEvent::Pre => "PreToolUse",
            HookEvent::Post => "PostToolUse",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Hook {
    pub event: HookEvent,
    matcher: Option<Regex>,
    pub command: String,
    pub timeout: u64,
    /// Viene del proyecto (no de la carpeta personal).
    pub project: bool,
}

impl Hook {
    fn matches(&self, tool: &str) -> bool {
        self.matcher.as_ref().is_none_or(|m| m.is_match(tool))
    }
}

#[derive(Clone, Debug, Default)]
pub struct Hooks {
    pub list: Vec<Hook>,
}

/// Lee un `hooks.json`. Lo que no se entiende se ignora (un gancho mal escrito no debe romper al agente).
pub fn parse_hooks(text: &str, project: bool) -> Vec<Hook> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let mut out = Vec::new();
    for (key, event) in [("PreToolUse", HookEvent::Pre), ("PostToolUse", HookEvent::Post)] {
        let Some(items) = v["hooks"][key].as_array() else { continue };
        for it in items {
            let command = it["command"].as_str().unwrap_or("").trim().to_string();
            if command.is_empty() {
                continue;
            }
            let matcher = match it["matcher"].as_str().map(str::trim).filter(|m| !m.is_empty()) {
                // Anclada: `edit` no vale para `edit_file`; para varias herramientas se usa `edit_file|write_file`.
                Some(m) => match Regex::new(&format!("^(?:{m})$")) {
                    Ok(r) => Some(r),
                    Err(_) => continue,
                },
                None => None,
            };
            let timeout = it["timeout"].as_u64().unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS);
            out.push(Hook { event, matcher, command, timeout, project });
        }
    }
    out
}

fn short(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

impl Hooks {
    /// Carga los ganchos personales y, si hay `root`, los del proyecto.
    pub fn load(root: &Path, home: Option<&Path>) -> Hooks {
        let mut list = Vec::new();
        if let Some(h) = home {
            if let Some(t) = crate::agentconfig::read_small(&h.join(".pulso").join("hooks.json"), None) {
                list.extend(parse_hooks(&t, false));
            }
        }
        if let Some(t) = crate::agentconfig::read_small(&root.join(".pulso").join("hooks.json"), Some(root)) {
            list.extend(parse_hooks(&t, true));
        }
        list.truncate(MAX_HOOKS);
        Hooks { list }
    }

    /// Sin confianza en el proyecto solo valen los ganchos personales: los del proyecto los escribió otra persona.
    pub fn without_project(mut self) -> Hooks {
        self.list.retain(|h| !h.project);
        self
    }

    fn matching<'a>(&'a self, event: HookEvent, tool: &'a str) -> impl Iterator<Item = &'a Hook> + 'a {
        self.list.iter().filter(move |h| h.event == event && h.matches(tool))
    }

    pub fn has_any(&self) -> bool {
        !self.list.is_empty()
    }

    async fn run_one(&self, hook: &Hook, root: &Path, tool: &str, input: &Value, cancel: &Arc<AtomicBool>) -> Option<(Option<i32>, String)> {
        let envs = vec![
            ("PULSO_HOOK_EVENT".to_string(), hook.event.name().to_string()),
            ("PULSO_TOOL".to_string(), tool.to_string()),
            ("PULSO_TOOL_INPUT".to_string(), short(&input.to_string(), MAX_INPUT_CHARS)),
            ("PULSO_PROJECT".to_string(), root.to_string_lossy().into_owned()),
        ];
        let (command, timeout, root, cancel) = (hook.command.clone(), hook.timeout, root.to_path_buf(), Arc::clone(cancel));
        let run = tauri::async_runtime::spawn_blocking(move || crate::agenttools::run_command_with_env(&root, &command, timeout, &cancel, &envs)).await;
        match run {
            Ok(Ok(r)) => Some(r),
            _ => None,
        }
    }

    /// Antes de una herramienta: `Err(motivo)` si algún gancho la bloquea (código de salida 2).
    pub async fn pre(&self, root: &Path, tool: &str, input: &Value, cancel: &Arc<AtomicBool>) -> Result<(), String> {
        for hook in self.matching(HookEvent::Pre, tool) {
            if let Some((Some(BLOCK_EXIT_CODE), text)) = self.run_one(hook, root, tool, input, cancel).await {
                let why = short(&text, MAX_OUTPUT_CHARS);
                let why = if why.is_empty() { tr("Un gancho de tu configuración bloqueó esta herramienta.").to_string() } else { why };
                return Err(trf("Un gancho (PreToolUse) bloqueó esta herramienta: {why}", &[("why", &why)]));
            }
        }
        Ok(())
    }

    /// Después de una herramienta: lo que escriban los ganchos se añade al resultado.
    pub async fn post(&self, root: &Path, tool: &str, input: &Value, cancel: &Arc<AtomicBool>) -> String {
        let mut extra = String::new();
        for hook in self.matching(HookEvent::Post, tool) {
            if let Some((code, text)) = self.run_one(hook, root, tool, input, cancel).await {
                let text = short(&text, MAX_OUTPUT_CHARS);
                if text.is_empty() {
                    continue;
                }
                let head = match code {
                    Some(0) | None => "[hook]".to_string(),
                    Some(c) => format!("[hook, exit code {c}]"),
                };
                extra.push_str(&format!("\n{head} {text}"));
            }
        }
        extra
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pulso-hooks-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn hooks(json: &str) -> Hooks {
        Hooks { list: parse_hooks(json, false) }
    }

    #[test]
    fn lee_el_archivo_y_descarta_lo_mal_escrito() {
        let l = parse_hooks(
            r#"{"hooks":{"PreToolUse":[{"matcher":"run_command|edit_file","command":"x","timeout":500},{"command":""},{"matcher":"(","command":"roto"},{"command":"y"}],
                          "PostToolUse":[{"matcher":"edit_file","command":"z"}],"Otro":[{"command":"q"}]}}"#,
            true,
        );
        assert_eq!(l.len(), 3, "sin comando o con expresión rota se ignoran");
        assert_eq!(l[0].timeout, MAX_TIMEOUT_SECS, "el tiempo se acota");
        assert!(l.iter().all(|h| h.project));
        assert!(parse_hooks("no es json", false).is_empty());
        assert!(parse_hooks("{}", false).is_empty());
    }

    #[test]
    fn el_nombre_de_la_herramienta_se_compara_entero() {
        let h = hooks(r#"{"hooks":{"PreToolUse":[{"matcher":"edit","command":"x"},{"matcher":"edit_file|write_file","command":"y"},{"command":"todas"}]}}"#);
        let names = |tool: &str| h.matching(HookEvent::Pre, tool).map(|k| k.command.clone()).collect::<Vec<_>>();
        assert_eq!(names("edit_file"), ["y", "todas"], "«edit» no vale para «edit_file»");
        assert_eq!(names("grep"), ["todas"]);
        assert_eq!(h.matching(HookEvent::Post, "edit_file").count(), 0);
    }

    #[test]
    fn sin_confianza_solo_valen_los_ganchos_personales() {
        let mut h = Hooks { list: parse_hooks(r#"{"hooks":{"PreToolUse":[{"command":"mio"}]}}"#, false) };
        h.list.extend(parse_hooks(r#"{"hooks":{"PreToolUse":[{"command":"ajeno"}]}}"#, true));
        let h = h.without_project();
        assert_eq!(h.list.len(), 1);
        assert_eq!(h.list[0].command, "mio");
    }

    #[test]
    fn carga_los_del_proyecto_y_los_personales() {
        let (root, home) = (dir("c-root"), dir("c-home"));
        std::fs::create_dir_all(root.join(".pulso")).unwrap();
        std::fs::create_dir_all(home.join(".pulso")).unwrap();
        std::fs::write(root.join(".pulso/hooks.json"), r#"{"hooks":{"PostToolUse":[{"command":"p"}]}}"#).unwrap();
        std::fs::write(home.join(".pulso/hooks.json"), r#"{"hooks":{"PreToolUse":[{"command":"u"}]}}"#).unwrap();
        let h = Hooks::load(&root, Some(&home));
        assert_eq!(h.list.len(), 2);
        assert!(h.list.iter().any(|k| k.command == "u" && !k.project) && h.list.iter().any(|k| k.command == "p" && k.project));
    }

    #[test]
    fn un_gancho_previo_bloquea_solo_con_el_codigo_2() {
        let root = dir("pre");
        let cancel = Arc::new(AtomicBool::new(false));
        let input = serde_json::json!({ "command": "git push" });
        let bloquea = hooks(r#"{"hooks":{"PreToolUse":[{"matcher":"run_command","command":"echo 'no se permite'; exit 2"}]}}"#);
        let r = block(bloquea.pre(&root, "run_command", &input, &cancel));
        assert!(r.as_ref().is_err_and(|e| e.contains("no se permite")), "{r:?}");
        // Otra herramienta no coincide.
        assert!(block(bloquea.pre(&root, "grep", &input, &cancel)).is_ok());
        // Un gancho que falla con otro código no bloquea.
        let falla = hooks(r#"{"hooks":{"PreToolUse":[{"command":"exit 1"}]}}"#);
        assert!(block(falla.pre(&root, "run_command", &input, &cancel)).is_ok());
        let ok = hooks(r#"{"hooks":{"PreToolUse":[{"command":"echo 'todo bien'"}]}}"#);
        assert!(block(ok.pre(&root, "run_command", &input, &cancel)).is_ok());
    }

    #[test]
    fn un_gancho_posterior_añade_su_salida_al_resultado() {
        let root = dir("post");
        let cancel = Arc::new(AtomicBool::new(false));
        let h = hooks(r#"{"hooks":{"PostToolUse":[{"matcher":"edit_file","command":"echo revisado"},{"matcher":"edit_file","command":"exit 0"}]}}"#);
        let extra = block(h.post(&root, "edit_file", &serde_json::json!({ "path": "a.ts" }), &cancel));
        assert!(extra.contains("[hook] revisado"), "{extra:?}");
        assert!(block(h.post(&root, "grep", &serde_json::json!({}), &cancel)).is_empty());
    }

    #[test]
    fn el_gancho_recibe_la_herramienta_y_su_entrada_por_variables() {
        let root = dir("env");
        let cancel = Arc::new(AtomicBool::new(false));
        let cmd = if cfg!(windows) {
            "echo $env:PULSO_HOOK_EVENT $env:PULSO_TOOL $env:PULSO_TOOL_INPUT"
        } else {
            "echo $PULSO_HOOK_EVENT $PULSO_TOOL $PULSO_TOOL_INPUT"
        };
        let h = hooks(&serde_json::json!({ "hooks": { "PostToolUse": [{ "command": cmd }] } }).to_string());
        let extra = block(h.post(&root, "write_file", &serde_json::json!({ "path": "nuevo.ts" }), &cancel));
        assert!(extra.contains("PostToolUse") && extra.contains("write_file") && extra.contains("nuevo.ts"), "{extra:?}");
    }
}
