//! Argumentos de línea de comandos de cada herramienta según el modo (leer, editar, agente).
use super::*;

#[derive(Debug, Clone, PartialEq)]
pub struct ChatOptions {
    pub session: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// «read» (solo leer) o «edit» (puede editar archivos).
    pub mode: String,
}

pub(super) fn safe_token(s: &str) -> bool {
    // Sin guion inicial: un valor como «--help» se tomaría por una opción.
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.len() <= 80
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '[' | ']'))
}

/// Programa que se ejecuta. Solo en compilaciones de desarrollo puede cambiarse con `PULSO_CLAUDE_BIN` (las pruebas usan una herramienta falsa);
/// en la aplicación instalada siempre es `claude`.
pub fn claude_program() -> String {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("PULSO_CLAUDE_BIN") {
            if !p.trim().is_empty() {
                return p;
            }
        }
    }
    "claude".to_string()
}

/// Argumentos de `claude` para una conversación. El mensaje va por la entrada estándar, no aquí.
pub fn build_claude_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    if let Some(s) = &o.session {
        if !safe_token(s) {
            return Err(tr("Identificador de sesión no válido").into());
        }
        a.push("--resume".into());
        a.push(s.clone());
    }
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) {
                return Err(tr("Modelo no válido").into());
            }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    if let Some(e) = &o.effort {
        if !e.is_empty() {
            if !matches!(e.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                return Err(tr("Nivel de esfuerzo no válido").into());
            }
            a.push("--effort".into());
            a.push(e.clone());
        }
    }
    let read_tools = "Read,Glob,Grep";
    match o.mode.as_str() {
        "read" => {
            a.extend(["--permission-mode", "default", "--allowedTools", read_tools].iter().map(|s| s.to_string()));
        }
        "edit" => {
            a.extend(["--permission-mode", "acceptEdits", "--allowedTools", "Read,Glob,Grep,Edit,Write,MultiEdit"].iter().map(|s| s.to_string()));
        }
        "full" => {
            a.extend(["--permission-mode", "acceptEdits", "--allowedTools", "Read,Glob,Grep,Edit,Write,MultiEdit,Bash"].iter().map(|s| s.to_string()));
        }
        _ => return Err(tr("Modo de permisos no válido").into()),
    }
    Ok(a)
}

/// Argumentos de `codex exec` para ChatGPT/Codex CLI. El mensaje va por stdin (`-`).
pub fn build_codex_args(o: &ChatOptions) -> Result<Vec<String>, String> {
    let sandbox = match o.mode.as_str() {
        "read" => "read-only",
        "edit" => "workspace-write",
        "full" => "danger-full-access",
        _ => return Err(tr("Modo de permisos no válido").into()),
    };
    if let Some(s) = &o.session {
        if !safe_token(s) {
            return Err(tr("Identificador de sesión no válido").into());
        }
    }
    // `exec resume` no tiene `--sandbox`: el modo se fuerza por configuración para que «Solo leer» valga también al continuar
    // una conversación (si no, mandaría el `config.toml` de la persona, que puede permitirlo todo).
    let mut a: Vec<String> = match &o.session {
        Some(_) => ["exec", "resume", "--json", "-c", &format!("sandbox_mode=\"{sandbox}\"")].iter().map(|s| s.to_string()).collect(),
        None => ["exec", "--json", "--sandbox", sandbox].iter().map(|s| s.to_string()).collect(),
    };
    // La carpeta la abrió la persona en Pulso, aunque no sea un repositorio de git.
    a.push("--skip-git-repo-check".into());
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) {
                return Err(tr("Modelo no válido").into());
            }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    if let Some(e) = &o.effort {
        if !e.is_empty() {
            let mapped = match e.as_str() {
                "low" | "medium" | "high" | "xhigh" => e.as_str(),
                "max" => "xhigh",
                _ => return Err(tr("Nivel de esfuerzo no válido").into()),
            };
            a.push("-c".into());
            a.push(format!("model_reasoning_effort=\"{mapped}\""));
        }
    }
    if let Some(s) = &o.session {
        a.push(s.clone());
    }
    a.push("-".into());
    Ok(a)
}

/// Argumentos de Antigravity CLI (`agy`) en modo headless con streaming JSON.
pub fn build_agy_args(o: &ChatOptions, prompt: &str) -> Result<Vec<String>, String> {
    let (mode_flags, guide, resume_guide): (Vec<&str>, &str, Option<&str>) = match o.mode.as_str() {
        "read" => (
            vec!["--mode", "plan"],
            "[Instrucción de entorno: estás en modo Solo leer dentro de Pulso Editor. Explora usando únicamente herramientas de lectura y búsqueda. Nunca invoques run_command ni herramientas de escritura.]\n\n",
            None,
        ),
        "edit" => (
            vec!["--mode", "accept-edits"],
            "[Instrucción de entorno: estás en modo Edición en Pulso Editor. Puedes leer, buscar y editar archivos directamente. Si necesitas ejecutar un comando de terminal, inténtalo o indícalo claramente para que Pulso pida aprobación al usuario.]\n\n",
            Some("[Permisos actuales en Pulso: modo Edición activo; puedes leer, buscar y editar archivos directamente.]\n\n"),
        ),
        "full" => (
            vec!["--dangerously-skip-permissions"],
            "[Instrucción de entorno: estás en modo Agente completo en Pulso Editor. Tienes permiso aprobado por el usuario para leer, buscar, editar archivos y ejecutar comandos de terminal (run_command) dentro del proyecto para completar y verificar la tarea.]\n\n",
            Some("[Permisos actuales en Pulso: modo Agente completo aprobado; puedes editar archivos y ejecutar comandos de terminal (run_command) para completar la tarea.]\n\n"),
        ),
        _ => return Err(tr("Modo de permisos no válido").into()),
    };
    let mut a: Vec<String> = vec!["--output-format".into(), "stream-json".into()];
    a.extend(mode_flags.into_iter().map(|s| s.to_string()));
    if let Some(s) = &o.session {
        if !safe_token(s) {
            return Err(tr("Identificador de sesión no válido").into());
        }
        a.push("--conversation".into());
        a.push(s.clone());
    }
    let has_explicit_model = o.model.as_deref().is_some_and(|m| !m.trim().is_empty());
    if let Some(m) = &o.model {
        if !m.is_empty() {
            if !safe_token(m) {
                return Err(tr("Modelo no válido").into());
            }
            a.push("--model".into());
            a.push(m.clone());
        }
    }
    // En `agy models` cada modelo ya fija su variante de esfuerzo: `--effort` solo aplica en Predeterminado.
    if !has_explicit_model {
        if let Some(e) = &o.effort {
            if !e.is_empty() {
                if !matches!(e.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                    return Err(tr("Nivel de esfuerzo no válido").into());
                }
                a.push("--effort".into());
                a.push(e.clone());
            }
        }
    }
    let full_prompt = if o.session.is_none() {
        format!("{guide}{prompt}")
    } else if let Some(rg) = resume_guide {
        format!("{rg}{prompt}")
    } else {
        prompt.to_string()
    };
    a.push("-p".into());
    a.push(full_prompt);
    Ok(a)
}
