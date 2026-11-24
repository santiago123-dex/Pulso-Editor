//! Agente propio con modelos de la nube: configuración del proyecto, confianza y arranque.
use super::*;

#[derive(Serialize)]
pub struct ConfigEntry {
    /// `instruction`, `skill`, `agent` o `command`.
    pub kind: String,
    pub name: String,
    pub description: String,
    /// Archivo que lo define (vacío en los subagentes integrados).
    pub path: String,
    /// De la carpeta personal, no del proyecto.
    pub user: bool,
    /// Viene del proyecto y no se carga porque la persona todavía no confió en él.
    pub blocked: bool,
}

pub(super) fn trust_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("trusted-folders.json"))
}

/// ¿Confió la persona en este proyecto? Es la misma lista que usa la terminal (`pulso`); confiar en una carpeta incluye sus subcarpetas.
pub(crate) fn project_trusted(app: &AppHandle, dir: &Path) -> bool {
    let Some(file) = trust_file(app) else { return false };
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    crate::termui::is_trusted(&crate::termui::trusted_list(&text), &dir)
}

pub(super) fn release_slot(state: &AiState, id: &str) {
    if let Ok(mut m) = state.running.lock() {
        m.remove(id);
    }
}

/// Agente con un modelo de la nube (`proveedor/modelo`): corre dentro de Pulso y emite los mismos eventos que las herramientas externas.
pub(super) async fn start_cloud(
    app: AppHandle,
    state: &AiState,
    id: String,
    cwd: String,
    prompt: String,
    model: Option<String>,
    history: Vec<crate::agent::HistoryMsg>,
    images: Vec<String>,
    mode: String,
) -> Result<(), String> {
    let prepared = async {
        let cwd_for_config = cwd.clone();
        let wanted = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).ok_or_else(|| tr("Elige un modelo para conversar.").to_string())?;
        let (prov_id, model_id) = wanted.split_once('/').ok_or_else(|| tr("Elige un modelo para conversar.").to_string())?;
        let (list, _) = crate::catalog::ensure(&app, false).await?;
        let provider = list.iter().find(|p| p.id == prov_id).ok_or_else(|| tr("El modelo elegido ya no está en el catálogo.").to_string())?;
        let entry = provider.models.iter().find(|m| m.id == model_id).ok_or_else(|| tr("El modelo elegido ya no está en el catálogo.").to_string())?;
        let key = crate::catalog::get_key(provider).ok_or_else(|| trf("Falta la clave de {provider}.", &[("provider", &provider.name)]))?;
        let cloud = crate::agent::CloudModel::from_catalog(provider, entry, key);
        let config = load_config(&app, &cwd_for_config).await?;
        Ok::<_, String>((cloud, config, crate::agent::catalog_resolver(list.clone())))
    }
    .await;
    let (cloud, config, resolver) = match prepared {
        Ok(c) => c,
        Err(e) => {
            release_slot(state, &id);
            return Err(e);
        }
    };
    spawn_agent(app, state, id, cwd, prompt, history, images, mode, cloud, config, resolver)
}

/// Agente con un modelo local de Ollama: el mismo motor y las mismas herramientas, permisos y configuración que con un modelo de la nube.
pub(super) async fn start_local(
    app: AppHandle,
    state: &AiState,
    id: String,
    cwd: String,
    prompt: String,
    model: Option<String>,
    history: Vec<crate::agent::HistoryMsg>,
    images: Vec<String>,
    mode: String,
) -> Result<(), String> {
    let prepared = async {
        let wanted = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).ok_or_else(|| tr("Elige un modelo de Ollama para conversar.").to_string())?;
        let local = crate::ollama::cloud_model(&crate::ollama::base_url(), &wanted).await?;
        let config = load_config(&app, &cwd).await?;
        Ok::<_, String>((local, config))
    }
    .await;
    let (local, config) = match prepared {
        Ok(c) => c,
        Err(e) => {
            release_slot(state, &id);
            return Err(e);
        }
    };
    // Un subagente que pida otro modelo no lo encuentra: con Ollama todos usan el mismo modelo local.
    let resolver: crate::agent::ModelResolver = Arc::new(|_| None);
    spawn_agent(app, state, id, cwd, prompt, history, images, mode, local, config, resolver)
}

/// Instrucciones del proyecto, skills, subagentes, comandos, memoria y ganchos, según la confianza de la persona en la carpeta.
async fn load_config(app: &AppHandle, cwd: &str) -> Result<Arc<crate::agentconfig::Config>, String> {
    let trusted = project_trusted(app, Path::new(cwd));
    let for_load = cwd.to_string();
    let config = tauri::async_runtime::spawn_blocking(move || crate::agentconfig::Config::load(Path::new(&for_load))).await.map_err(|e| e.to_string())?;
    // Sin confianza, lo del proyecto no llega al modelo: solo lo personal y los subagentes integrados.
    Ok(Arc::new(if trusted { config.with_memory(crate::agentmem::memory_store(app, Path::new(cwd))) } else { config.without_project() }))
}

/// Registra la conversación, prepara los permisos y lanza el motor del agente en segundo plano.
#[allow(clippy::too_many_arguments)]
fn spawn_agent(
    app: AppHandle,
    state: &AiState,
    id: String,
    cwd: String,
    prompt: String,
    history: Vec<crate::agent::HistoryMsg>,
    images: Vec<String>,
    mode: String,
    cloud: crate::agent::CloudModel,
    config: Arc<crate::agentconfig::Config>,
    resolver: crate::agent::ModelResolver,
) -> Result<(), String> {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.running.lock().map_err(|e| e.to_string())?.insert(id.clone(), AiSlot::Local(cancel.clone()));
    let (emitter, id_line) = (app.clone(), id.clone());
    let emit: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line| {
        let _ = emitter.emit("ai-line", AiLine { id: id_line.clone(), line });
    });
    // Permisos: en modo Agente los comandos y las páginas web se preguntan en el panel, salvo lo que ya se permitió.
    let broker = app.state::<Arc<crate::agentperms::Broker>>().inner().clone();
    let perms = Arc::new(crate::agentperms::Permissions::new(
        Arc::new(crate::agentperms::UiApprover { broker: broker.clone(), conversation: id.clone(), cancel: cancel.clone(), emit: emit.clone() }),
        crate::agentperms::rule_store(&app),
        Path::new(&cwd),
        broker.allow_all_for(&id),
    ));
    tauri::async_runtime::spawn(async move {
        let outcome = crate::agent::run(cloud, PathBuf::from(&cwd), id.clone(), history, prompt, images, mode, cancel.clone(), emit, config, resolver, perms).await;
        release_slot(&app.state::<AiState>(), &id);
        let stopped = cancel.load(std::sync::atomic::Ordering::Relaxed);
        let (code, stderr) = match outcome {
            Ok(()) => (Some(0), String::new()),
            Err(_) if stopped => (None, String::new()),
            Err(e) => (Some(1), e),
        };
        let _ = app.emit("ai-exit", AiExit { id, code, stderr });
    });
    Ok(())
}

/// Qué servidores MCP hay configurados y cómo están: para la pantalla «IA: Servidores MCP…».
#[derive(Serialize)]
pub struct McpStatus {
    pub servers: Vec<crate::agentmcp::ServerStatus>,
    /// Dónde se escriben los servidores personales y los del proyecto (puede que el archivo todavía no exista).
    pub personal_file: String,
    pub project_file: String,
}

/// Arranca un momento cada servidor MCP configurado para saber si funciona y qué herramientas ofrece, y lo cierra. Los del proyecto solo
/// se arrancan si la persona confía en él (igual que en una conversación).
#[tauri::command]
pub async fn agent_mcp_status(app: AppHandle, guard: State<'_, crate::fsguard::WorkspaceGuard>, cwd: String) -> Result<McpStatus, String> {
    let dir = guard.ensure_dir(&cwd)?;
    let trusted = project_trusted(&app, &dir);
    let home = user_home();
    let personal_file = home.as_ref().map(|h| h.join(".pulso").join("mcp.json").to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let project_file = dir.join(".pulso").join("mcp.json").to_string_lossy().replace('\\', "/");
    let (root, home_for_load) = (PathBuf::from(&cwd), home.clone());
    let servers = tauri::async_runtime::spawn_blocking(move || {
        let config = crate::agentmcp::McpConfig::load(&root, home_for_load.as_deref());
        crate::agentmcp::probe(&config, &root, trusted, &Arc::new(std::sync::atomic::AtomicBool::new(false)))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(McpStatus { servers, personal_file, project_file })
}
