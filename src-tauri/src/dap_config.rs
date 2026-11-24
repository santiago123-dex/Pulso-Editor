//! Configuración de lanzamiento del depurador (`.pulso/launch.json` y respaldo `.vscode/launch.json`),
//! expansión de variables, detección de adaptadores DAP y comprobación de confianza de carpeta.
use crate::i18n::{tr, trf};
use crate::termui::{add_trusted, broad_dir_reason, is_trusted, trusted_list};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "default_request")]
    pub request: String,
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub adapter_command: Option<String>,
    #[serde(default)]
    pub adapter_args: Vec<String>,
    /// Origen de la configuración: "pulso", "vscode" o "auto".
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_request() -> String {
    "launch".into()
}

fn default_source() -> String {
    "pulso".into()
}

/// Elimina comentarios (`//`, `/* */`) y comas finales de JSONC para leer `.vscode/launch.json`.
pub fn strip_jsonc(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                i += 1;
                out.push(chars[i]);
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        out.push(c);
        i += 1;
    }

    // Quita comas finales antes de `}` o `]` fuera de cadenas.
    let c2: Vec<char> = out.chars().collect();
    let mut clean = String::with_capacity(out.len());
    let mut j = 0;
    let mut s = false;
    while j < c2.len() {
        let ch = c2[j];
        if s {
            clean.push(ch);
            if ch == '\\' && j + 1 < c2.len() {
                j += 1;
                clean.push(c2[j]);
            } else if ch == '"' {
                s = false;
            }
            j += 1;
            continue;
        }
        if ch == '"' {
            s = true;
            clean.push(ch);
            j += 1;
            continue;
        }
        if ch == ',' {
            let mut k = j + 1;
            while k < c2.len() && c2[k].is_whitespace() {
                k += 1;
            }
            if k < c2.len() && (c2[k] == '}' || c2[k] == ']') {
                j += 1;
                continue;
            }
        }
        clean.push(ch);
        j += 1;
    }
    clean
}

/// Expande `${workspaceFolder}`, `${file}` y `${fileBasename}` dentro de un valor de configuración.
pub fn expand_vars(value: &str, workspace: &str, active_file: Option<&str>) -> String {
    let mut s = value.replace("${workspaceFolder}", workspace);
    if let Some(f) = active_file {
        s = s.replace("${file}", f);
        if let Some(name) = Path::new(f).file_name().and_then(|n| n.to_str()) {
            s = s.replace("${fileBasename}", name);
        }
    }
    s
}

/// Analiza un archivo `launch.json` (JSON o JSONC) y devuelve sus configuraciones válidas.
pub fn parse_launch_json(raw: &str, source: &str) -> Result<Vec<LaunchConfig>, String> {
    let clean = strip_jsonc(raw);
    let val: Value = serde_json::from_str(&clean)
        .map_err(|e| trf("Error al leer launch.json: {e}", &[("e", &e)]))?;
    let list = val
        .get("configurations")
        .and_then(Value::as_array)
        .ok_or_else(|| tr("launch.json no contiene una lista «configurations».").to_string())?;

    let mut out = Vec::new();
    for item in list {
        let Some(name) = item.get("name").and_then(Value::as_str) else { continue };
        let Some(kind) = item.get("type").and_then(Value::as_str) else { continue };
        let request = item
            .get("request")
            .and_then(Value::as_str)
            .unwrap_or("launch")
            .to_string();
        let program = item
            .get("program")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = item
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        let cwd = item.get("cwd").and_then(Value::as_str).map(String::from);
        let env = item
            .get("env")
            .and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let adapter_command = item.get("adapterCommand").and_then(Value::as_str).map(String::from);
        let adapter_args = item
            .get("adapterArgs")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();

        out.push(LaunchConfig {
            name: name.to_string(),
            kind: kind.to_string(),
            request,
            program,
            args,
            cwd,
            env,
            adapter_command,
            adapter_args,
            source: source.to_string(),
        });
    }
    Ok(out)
}

/// Lee `.pulso/launch.json`, después `.vscode/launch.json` y añade una configuración automática si el archivo activo es Python.
pub fn load_workspace_configs(root: &Path, active_file: Option<&str>) -> Vec<LaunchConfig> {
    let mut configs = Vec::new();
    let pulso_file = root.join(".pulso").join("launch.json");
    if let Ok(raw) = fs::read_to_string(&pulso_file) {
        if let Ok(list) = parse_launch_json(&raw, "pulso") {
            configs.extend(list);
        }
    }
    let vscode_file = root.join(".vscode").join("launch.json");
    if let Ok(raw) = fs::read_to_string(&vscode_file) {
        if let Ok(list) = parse_launch_json(&raw, "vscode") {
            for cfg in list {
                if !configs.iter().any(|c| c.name == cfg.name) {
                    configs.push(cfg);
                }
            }
        }
    }
    if active_file.is_some_and(|f| f.to_ascii_lowercase().ends_with(".py")) || configs.is_empty() {
        configs.push(LaunchConfig {
            name: tr("Python: Archivo actual").into(),
            kind: "python".into(),
            request: "launch".into(),
            program: "${file}".into(),
            args: Vec::new(),
            cwd: Some("${workspaceFolder}".into()),
            env: HashMap::new(),
            adapter_command: None,
            adapter_args: Vec::new(),
            source: "auto".into(),
        });
    }
    configs
}

/// Plantilla inicial para crear `.pulso/launch.json`.
pub fn default_launch_template() -> &'static str {
    r#"{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: Archivo actual",
      "type": "python",
      "request": "launch",
      "program": "${file}",
      "cwd": "${workspaceFolder}",
      "args": []
    }
  ]
}
"#
}

fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Busca el intérprete de Python del entorno virtual del proyecto o del sistema.
pub fn find_python(workspace: &Path) -> Option<PathBuf> {
    let venv_candidates = [
        workspace.join(".venv").join("Scripts").join("python.exe"),
        workspace.join("venv").join("Scripts").join("python.exe"),
        workspace.join(".venv").join("bin").join("python"),
        workspace.join("venv").join("bin").join("python"),
    ];
    for c in venv_candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    #[cfg(windows)]
    let names = ["python.exe", "python3.exe", "py.exe"];
    #[cfg(not(windows))]
    let names = ["python3", "python"];
    find_in_path(&names)
}

/// Resuelve el ejecutable y argumentos del adaptador DAP para la configuración dada.
pub fn resolve_adapter(cfg: &LaunchConfig, workspace: &Path) -> Result<(String, Vec<String>), String> {
    if let Some(cmd) = cfg.adapter_command.as_deref().filter(|s| !s.trim().is_empty()) {
        return Ok((cmd.trim().to_string(), cfg.adapter_args.clone()));
    }
    match cfg.kind.to_ascii_lowercase().as_str() {
        "python" | "debugpy" => {
            let py = find_python(workspace).ok_or_else(|| {
                tr("No se encontró Python en el sistema. Instala Python y `pip install debugpy` para depurar.").to_string()
            })?;
            Ok((
                py.to_string_lossy().into_owned(),
                vec!["-m".into(), "debugpy.adapter".into()],
            ))
        }
        other => Err(trf(
            "Tipo de depurador «{kind}» no soportado todavía. Usa «python» (debugpy) o indica «adapterCommand» en .pulso/launch.json.",
            &[("kind", &other)],
        )),
    }
}

// ---------- Confianza de carpeta (comparte `trusted-folders.json` con la CLI) ----------

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn trust_file() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".config")))?;
    Some(base.join("dev.pulso.editor").join("trusted-folders.json"))
}

pub fn is_workspace_trusted(root: &Path) -> bool {
    if broad_dir_reason(root, home_dir().as_deref()).is_some() {
        return false;
    }
    let Some(f) = trust_file() else { return false };
    let text = fs::read_to_string(&f).unwrap_or_default();
    is_trusted(&trusted_list(&text), root)
}

pub fn trust_workspace_folder(root: &Path) -> Result<(), String> {
    if let Some(why) = broad_dir_reason(root, home_dir().as_deref()) {
        return Err(trf(
            "No se puede confiar en esta carpeta para depurar porque {why}.",
            &[("why", &why)],
        ));
    }
    let f = trust_file().ok_or_else(|| tr("No se pudo localizar el archivo de carpetas de confianza.").to_string())?;
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let prev = fs::read_to_string(&f).unwrap_or_default();
    fs::write(&f, add_trusted(&prev, root)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_jsonc_removes_comments_and_trailing_commas() {
        let raw = r#"{
            // comentario de línea
            "version": "0.2.0",
            /* comentario
               de bloque */
            "configurations": [
                {
                    "name": "URL https://example.com // no comentar",
                    "type": "python",
                    "program": "${file}",
                },
            ],
        }"#;
        let parsed = parse_launch_json(raw, "vscode").expect("debe analizar JSONC válido");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "URL https://example.com // no comentar");
        assert_eq!(parsed[0].kind, "python");
        assert_eq!(parsed[0].source, "vscode");
    }

    #[test]
    fn expand_vars_replaces_workspace_and_file() {
        let out = expand_vars("${workspaceFolder}/src/${fileBasename}", "/repo", Some("/repo/src/app.py"));
        assert_eq!(out, "/repo/src/app.py");
        assert_eq!(expand_vars("${file}", "/repo", Some("/repo/main.py")), "/repo/main.py");
    }

    #[test]
    fn load_workspace_configs_prefers_pulso_over_vscode_same_name() {
        let dir = std::env::temp_dir().join(format!("pulso-dap-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".pulso")).unwrap();
        fs::create_dir_all(dir.join(".vscode")).unwrap();
        fs::write(
            dir.join(".pulso").join("launch.json"),
            r#"{"configurations":[{"name":"App","type":"python","program":"a.py"}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join(".vscode").join("launch.json"),
            r#"{"configurations":[{"name":"App","type":"python","program":"b.py"},{"name":"Extra","type":"python","program":"c.py"}]}"#,
        )
        .unwrap();

        let list = load_workspace_configs(&dir, Some("main.py"));
        assert!(list.iter().any(|c| c.name == "App" && c.program == "a.py" && c.source == "pulso"));
        assert!(list.iter().any(|c| c.name == "Extra" && c.program == "c.py" && c.source == "vscode"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_adapter_supports_custom_command_and_rejects_unknown_kind() {
        let custom = LaunchConfig {
            name: "Custom".into(),
            kind: "node".into(),
            request: "launch".into(),
            program: "app.js".into(),
            args: vec![],
            cwd: None,
            env: HashMap::new(),
            adapter_command: Some("my-dap".into()),
            adapter_args: vec!["--stdio".into()],
            source: "pulso".into(),
        };
        let (cmd, args) = resolve_adapter(&custom, Path::new(".")).unwrap();
        assert_eq!(cmd, "my-dap");
        assert_eq!(args, vec!["--stdio"]);

        let unknown = LaunchConfig { adapter_command: None, ..custom };
        assert!(resolve_adapter(&unknown, Path::new(".")).is_err());
    }
}
