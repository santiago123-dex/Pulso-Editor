//! Aprobación de comandos y de lectura de la web por la persona (fase 2 de docs/AGENTE.md).
//!
//! En el modo «Agente» el agente **se detiene** antes de ejecutar un comando que no es de solo lectura: el panel muestra una tarjeta y la
//! persona elige permitir una vez, permitir siempre ese comando, permitir todo en esa conversación o denegar. Las reglas que se guardan
//! viven en la carpeta de datos de Pulso (no en el proyecto, para que un repositorio ajeno no pueda autorizarse comandos por sí mismo).
//!
//! Dos cosas no se pueden saltar con «siempre» ni con «todo»: los comandos **de riesgo** (borrar de forma recursiva, `git push`,
//! `git reset --hard`, `sudo`, descargar y ejecutar, publicar paquetes…) siempre preguntan, y las reglas de **denegar** mandan sobre todo.
use crate::i18n::tr;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

/// Cuánto espera una pregunta sin respuesta antes de darla por denegada.
const ASK_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Once,
    /// Guardar una regla para este comando exacto.
    AlwaysCommand,
    /// Permitir todo en esta conversación (salvo lo de riesgo).
    AllowAll,
    Deny,
}

impl Decision {
    pub fn parse(s: &str) -> Decision {
        match s {
            "once" => Decision::Once,
            "always" => Decision::AlwaysCommand,
            "all" => Decision::AllowAll,
            _ => Decision::Deny,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Command,
    Web,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRequest {
    pub tool: Tool,
    /// El comando completo o la dirección.
    pub detail: String,
    pub risky: bool,
    /// Qué subagente lo pide (vacío = el agente principal).
    pub agent: String,
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Allow,
    Deny(String),
}

// ---------- Análisis de comandos (puro) ----------

fn collapse(cmd: &str) -> String {
    cmd.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parte un comando encadenado (`a && b | c; d`) en sus órdenes simples. `None` si trae algo que no se puede analizar con seguridad:
/// redirecciones, sustitución de comandos, subshells o bloques.
pub fn split_commands(cmd: &str) -> Option<Vec<String>> {
    if cmd.contains('`') || cmd.contains("$(") || cmd.contains('>') || cmd.contains('<') || cmd.contains('(') || cmd.contains(')') || cmd.contains('{') || cmd.contains('}') {
        return None;
    }
    let mut parts = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let two = chars.get(i + 1).copied();
        if matches!(c, ';' | '\n' | '\r' | '|' | '&') {
            if (c == '&' && two == Some('&')) || (c == '|' && two == Some('|')) {
                i += 1;
            }
            parts.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
        i += 1;
    }
    parts.push(cur);
    let out: Vec<String> = parts.into_iter().map(|p| collapse(&p)).filter(|p| !p.is_empty()).collect();
    if out.is_empty() { None } else { Some(out) }
}

/// ¿Es un comando de riesgo? Esos siempre preguntan y no se pueden dejar permitidos.
pub fn is_risky(cmd: &str) -> bool {
    use std::sync::OnceLock;
    static RISKY: OnceLock<regex::RegexSet> = OnceLock::new();
    let set = RISKY.get_or_init(|| {
        regex::RegexSetBuilder::new([
            r"\brm\b.*\s-[a-z]*[rf]",
            r"\brm\s+-[a-z]*[rf]",
            r"\bdel\b.*(\s/[sq]\b|\*)",
            r"\brmdir\b.*\s/s\b",
            r"\brd\b.*\s/s\b",
            r"remove-item\b.*-recurse",
            r"\bgit\s+push\b",
            r"\bgit\s+reset\s+--hard",
            r"\bgit\s+clean\b",
            r"\bgit\s+checkout\s+(--|\.)",
            r"\bgit\s+restore\b",
            r"\bgit\s+branch\s+-[dD]\b",
            r"\bgit\s+(rebase|filter-branch|gc\s+--prune)",
            r"\bsudo\b",
            r"\bsu\s+-?\w*\s*$",
            r"\bchmod\b",
            r"\bchown\b",
            r"\b(curl|wget)\b.*\|",
            r"\b(iwr|invoke-webrequest|irm|invoke-restmethod)\b.*\|\s*(iex|invoke-expression)",
            r"\b(iex|invoke-expression)\b",
            r"\bformat\s+[a-z]:",
            r"\bmkfs",
            r"\bdd\s+if=",
            r"\bshutdown\b",
            r"\breg\s+(delete|add|import)\b",
            r"\b(npm|pnpm|yarn|cargo|pip|twine|gem)\s+publish\b",
            r"\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b",
            r"\bkubectl\s+(delete|apply)\b",
            r"\bterraform\s+(destroy|apply)\b",
            r"\bdrop\s+(table|database|schema)\b",
            r"\btaskkill\b",
            r"\bkill\s+-9\b",
            r"\b(setx|\[environment\]::setenvironmentvariable)\b",
            r"\bnet\s+user\b",
            r"/dev/(sd|nvme|disk)",
        ])
        .case_insensitive(true)
        .build()
        .expect("expresiones fijas")
    });
    // Se mira el comando completo y también cada orden suelta.
    set.is_match(cmd) || split_commands(cmd).is_some_and(|ps| ps.iter().any(|p| set.is_match(p)))
}

fn rule_matches(rule: &str, part: &str) -> bool {
    let rule = collapse(rule);
    if let Some(prefix) = rule.strip_suffix(" *") {
        part == prefix || part.starts_with(&format!("{prefix} "))
    } else {
        part == rule
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rules {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

impl Rules {
    /// Una regla de denegar manda sobre todo: basta con que una de las órdenes del comando coincida.
    pub fn denies(&self, cmd: &str) -> bool {
        let whole = collapse(cmd);
        let parts = split_commands(cmd).unwrap_or_else(|| vec![whole.clone()]);
        self.deny.iter().any(|r| rule_matches(r, &whole) || parts.iter().any(|p| rule_matches(r, p)))
    }

    /// Una regla de permitir vale si el comando entero coincide, o si se puede partir y **todas** sus órdenes están permitidas.
    pub fn allows(&self, cmd: &str, read_only: impl Fn(&str) -> bool) -> bool {
        let whole = collapse(cmd);
        if self.allow.iter().any(|r| collapse(r) == whole) {
            return true;
        }
        let Some(parts) = split_commands(cmd) else { return false };
        parts.iter().all(|p| read_only(p) || self.allow.iter().any(|r| rule_matches(r, p)))
    }
}

// ---------- Reglas guardadas ----------

#[derive(Default, Serialize, Deserialize)]
struct RulesFile {
    #[serde(default)]
    roots: BTreeMap<String, Rules>,
}

/// Clave de una carpeta de proyecto en el archivo de reglas.
pub fn root_key(root: &Path) -> String {
    let p = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut s = p.to_string_lossy().replace('\\', "/");
    if let Some(r) = s.strip_prefix("//?/") {
        s = r.to_string();
    }
    s.trim_end_matches('/').to_lowercase()
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone)]
pub struct RuleStore {
    file: PathBuf,
}

impl RuleStore {
    pub fn new(file: PathBuf) -> Self {
        RuleStore { file }
    }

    fn read(&self) -> RulesFile {
        std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn write(&self, f: &RulesFile) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        crate::write_atomic(&self.file, serde_json::to_string_pretty(f).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn load(&self, root: &Path) -> Rules {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read().roots.get(&root_key(root)).cloned().unwrap_or_default()
    }

    pub fn add_allow(&self, root: &Path, rule: &str) -> Result<(), String> {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut f = self.read();
        let r = f.roots.entry(root_key(root)).or_default();
        let rule = collapse(rule);
        if !r.allow.contains(&rule) {
            r.allow.push(rule);
        }
        self.write(&f)
    }

    pub fn remove(&self, root: &Path, kind: &str, rule: &str) -> Result<(), String> {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut f = self.read();
        if let Some(r) = f.roots.get_mut(&root_key(root)) {
            match kind {
                "deny" => r.deny.retain(|x| x != rule),
                _ => r.allow.retain(|x| x != rule),
            }
        }
        self.write(&f)
    }
}

// ---------- Quien pregunta ----------

pub trait Approver: Send + Sync {
    fn ask(&self, req: ApprovalRequest) -> Pin<Box<dyn Future<Output = Decision> + Send>>;
}

/// Responde siempre lo mismo (pruebas y usos sin persona delante).
pub struct FixedApprover(pub Decision);

impl Approver for FixedApprover {
    fn ask(&self, _req: ApprovalRequest) -> Pin<Box<dyn Future<Output = Decision> + Send>> {
        let d = self.0;
        Box::pin(async move { d })
    }
}

/// Reparte las respuestas de la persona a las preguntas en curso.
#[derive(Default)]
pub struct Broker {
    pending: Mutex<HashMap<String, mpsc::Sender<Decision>>>,
    allow_all: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next: AtomicU64,
}

impl Broker {
    /// La bandera «permitir todo» de una conversación (sobrevive entre los mensajes de la misma conversación).
    pub fn allow_all_for(&self, conversation: &str) -> Arc<AtomicBool> {
        self.allow_all.lock().unwrap_or_else(|e| e.into_inner()).entry(conversation.to_string()).or_default().clone()
    }

    pub fn respond(&self, id: &str, decision: Decision) -> bool {
        let tx = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        tx.is_some_and(|t| t.send(decision).is_ok())
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Pregunta a la persona a través del panel: manda un evento `pulso_permission` y espera la respuesta.
pub struct UiApprover {
    pub broker: Arc<Broker>,
    pub conversation: String,
    pub cancel: Arc<AtomicBool>,
    pub emit: Arc<dyn Fn(String) + Send + Sync>,
}

impl Approver for UiApprover {
    fn ask(&self, req: ApprovalRequest) -> Pin<Box<dyn Future<Output = Decision> + Send>> {
        let n = self.broker.next.fetch_add(1, Ordering::Relaxed);
        let id = format!("perm-{}-{n}", self.conversation);
        let (tx, rx) = mpsc::channel();
        self.broker.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
        (self.emit)(
            json!({ "type": "pulso_permission", "id": id, "tool": if req.tool == Tool::Web { "web" } else { "command" }, "detail": req.detail, "risky": req.risky, "agent": req.agent })
                .to_string(),
        );
        let (broker, cancel, emit) = (self.broker.clone(), self.cancel.clone(), self.emit.clone());
        Box::pin(async move {
            let wait_id = id.clone();
            let decision = tauri::async_runtime::spawn_blocking(move || {
                let deadline = Instant::now() + ASK_TIMEOUT;
                loop {
                    match rx.recv_timeout(Duration::from_millis(300)) {
                        Ok(d) => return d,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            // Si se detuvo la conversación o pasó demasiado tiempo, se da por denegada.
                            if cancel.load(Ordering::Relaxed) || Instant::now() >= deadline {
                                return Decision::Deny;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => return Decision::Deny,
                    }
                }
            })
            .await
            .unwrap_or(Decision::Deny);
            broker.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&wait_id);
            emit(json!({ "type": "pulso_permission_resolved", "id": wait_id }).to_string());
            decision
        })
    }
}

// ---------- Decidir ----------

pub struct Permissions {
    approver: Arc<dyn Approver>,
    store: Option<RuleStore>,
    root: PathBuf,
    rules: Mutex<Rules>,
    allow_all: Arc<AtomicBool>,
}

impl Permissions {
    pub fn new(approver: Arc<dyn Approver>, store: Option<RuleStore>, root: &Path, allow_all: Arc<AtomicBool>) -> Self {
        let rules = store.as_ref().map(|s| s.load(root)).unwrap_or_default();
        Permissions { approver, store, root: root.to_path_buf(), rules: Mutex::new(rules), allow_all }
    }

    /// Sin preguntar ni guardar nada: lo que `approver` responda.
    pub fn fixed(decision: Decision) -> Self {
        Permissions::new(Arc::new(FixedApprover(decision)), None, Path::new("."), Arc::new(AtomicBool::new(false)))
    }

    pub fn with_rules(mut self, rules: Rules) -> Self {
        self.rules = Mutex::new(rules);
        self
    }

    fn denied(&self, what: &str) -> Verdict {
        Verdict::Deny(format!("{} {what}", tr("La persona denegó esto:")) + " " + &tr("No lo reintentes. Prueba otra cosa o pregunta cómo continuar."))
    }

    /// ¿Se puede ejecutar este comando (que no es de solo lectura)? Aplica las reglas y, si hace falta, pregunta.
    pub async fn check_command(&self, command: &str, agent: &str, read_only: impl Fn(&str) -> bool) -> Verdict {
        let risky = is_risky(command);
        {
            let rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
            if rules.denies(command) {
                return Verdict::Deny(tr("Una regla de permisos de esta carpeta deniega este comando.").to_string());
            }
            // Lo de riesgo nunca se permite por regla ni por «todo»: solo con una respuesta de la persona.
            if !risky && (self.allow_all.load(Ordering::Relaxed) || rules.allows(command, read_only)) {
                return Verdict::Allow;
            }
        }
        let decision = self.approver.ask(ApprovalRequest { tool: Tool::Command, detail: command.to_string(), risky, agent: agent.to_string() }).await;
        match decision {
            Decision::Deny => self.denied(command),
            Decision::Once => Verdict::Allow,
            Decision::AlwaysCommand => {
                if !risky {
                    if let Some(store) = &self.store {
                        let _ = store.add_allow(&self.root, command);
                    }
                    self.rules.lock().unwrap_or_else(|e| e.into_inner()).allow.push(collapse(command));
                }
                Verdict::Allow
            }
            Decision::AllowAll => {
                if !risky {
                    self.allow_all.store(true, Ordering::Relaxed);
                }
                Verdict::Allow
            }
        }
    }

    /// Leer una página web: se pregunta cada vez, salvo con «permitir todo» en la conversación.
    pub async fn check_web(&self, url: &str, agent: &str) -> Verdict {
        if self.allow_all.load(Ordering::Relaxed) {
            return Verdict::Allow;
        }
        match self.approver.ask(ApprovalRequest { tool: Tool::Web, detail: url.to_string(), risky: false, agent: agent.to_string() }).await {
            Decision::Deny => self.denied(url),
            Decision::AllowAll => {
                self.allow_all.store(true, Ordering::Relaxed);
                Verdict::Allow
            }
            _ => Verdict::Allow,
        }
    }
}

// ---------- Comandos ----------

fn store(app: &AppHandle) -> Result<RuleStore, String> {
    Ok(RuleStore::new(app.path().app_data_dir().map_err(|e| e.to_string())?.join("agent-permissions.json")))
}

pub fn rule_store(app: &AppHandle) -> Option<RuleStore> {
    store(app).ok()
}

/// Respuesta de la persona a una pregunta del agente: `once`, `always`, `all` o `deny`.
#[tauri::command]
pub fn ai_permission_respond(broker: State<'_, Arc<Broker>>, id: String, decision: String) -> bool {
    broker.respond(&id, Decision::parse(&decision))
}

#[derive(Serialize)]
pub struct RuleEntry {
    /// `allow` o `deny`.
    pub kind: String,
    pub rule: String,
}

/// Reglas guardadas para una carpeta.
#[tauri::command]
pub async fn agent_rules_list(app: AppHandle, guard: State<'_, crate::fsguard::WorkspaceGuard>, cwd: String) -> Result<Vec<RuleEntry>, String> {
    guard.ensure_dir(&cwd)?;
    let s = store(&app)?;
    let rules = tauri::async_runtime::spawn_blocking(move || s.load(Path::new(&cwd))).await.map_err(|e| e.to_string())?;
    Ok(rules.deny.into_iter().map(|r| RuleEntry { kind: "deny".into(), rule: r }).chain(rules.allow.into_iter().map(|r| RuleEntry { kind: "allow".into(), rule: r })).collect())
}

/// Borra una regla guardada.
#[tauri::command]
pub async fn agent_rules_remove(app: AppHandle, guard: State<'_, crate::fsguard::WorkspaceGuard>, cwd: String, kind: String, rule: String) -> Result<(), String> {
    guard.ensure_dir(&cwd)?;
    let s = store(&app)?;
    tauri::async_runtime::spawn_blocking(move || s.remove(Path::new(&cwd), &kind, &rule)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!("pulso-perms-{tag}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst))).join("agent-permissions.json")
    }

    fn block<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn no_read_only(_: &str) -> bool {
        false
    }

    /// Aprobador de pruebas que apunta lo que le preguntan y responde lo que se le diga, en orden.
    struct Script {
        seen: Mutex<Vec<ApprovalRequest>>,
        answers: Mutex<Vec<Decision>>,
    }
    impl Script {
        fn new(answers: &[Decision]) -> Arc<Script> {
            Arc::new(Script { seen: Mutex::new(vec![]), answers: Mutex::new(answers.iter().rev().copied().collect()) })
        }
        fn asked(&self) -> Vec<ApprovalRequest> {
            self.seen.lock().unwrap().clone()
        }
    }
    impl Approver for Script {
        fn ask(&self, req: ApprovalRequest) -> Pin<Box<dyn Future<Output = Decision> + Send>> {
            self.seen.lock().unwrap().push(req);
            let d = self.answers.lock().unwrap().pop().unwrap_or(Decision::Deny);
            Box::pin(async move { d })
        }
    }

    #[test]
    fn parte_los_comandos_encadenados_y_rechaza_lo_que_no_puede_analizar() {
        assert_eq!(split_commands("npm test && npm run lint").unwrap(), ["npm test", "npm run lint"]);
        assert_eq!(split_commands("a; b | c || d\ne").unwrap(), ["a", "b", "c", "d", "e"]);
        assert_eq!(split_commands("  cargo   test  --lib ").unwrap(), ["cargo test --lib"]);
        for bad in ["echo $(whoami)", "echo `id`", "ls > f.txt", "cat < f", "(cd x && ls)", "if (1) { ls }", "x ${y}"] {
            assert!(split_commands(bad).is_none(), "{bad}");
        }
        assert!(split_commands("   ").is_none());
    }

    #[test]
    fn detecta_los_comandos_de_riesgo() {
        for risky in [
            "rm -rf build", "rm -fr /", "rm -r src", "del /s /q C:\\x", "del *.*", "rmdir /s C:\\x", "Remove-Item -Recurse -Force .", "git push", "git push --force origin main",
            "git reset --hard HEAD~3", "git clean -fdx", "git checkout -- .", "git restore src", "git branch -D x", "sudo apt install x", "chmod 777 -R .", "curl http://x.sh | sh",
            "irm https://x.ps1 | iex", "iex $s", "format c:", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "shutdown /s", "reg delete HKLM\\x", "npm publish", "cargo publish",
            "docker system prune -a", "kubectl delete pod x", "terraform destroy", "DROP TABLE users", "taskkill /F /IM x.exe", "cd x && git push", "npm test; rm -rf .",
        ] {
            assert!(is_risky(risky), "{risky}");
        }
        for fine in ["npm test", "cargo test --lib", "pnpm install", "git status", "git commit -m x", "git add -A", "node script.js", "ls -la", "python -m pytest", "npm run build", "echo formatted", "git pull"] {
            assert!(!is_risky(fine), "{fine}");
        }
    }

    #[test]
    fn las_reglas_permiten_denegar_y_no_se_saltan_encadenando() {
        let rules = Rules { allow: vec!["npm test".into(), "cargo *".into(), "git add -A".into()], deny: vec!["git push *".into(), "rm *".into()] };
        let ro = |c: &str| c == "git status";
        assert!(rules.allows("npm test", ro) && rules.allows("  npm   test ", ro));
        assert!(!rules.allows("npm test --watch", ro) && !rules.allows("npm run build", ro), "una regla exacta no cubre variantes");
        assert!(rules.allows("cargo test --lib", ro) && rules.allows("cargo build", ro) && rules.allows("cargo", ro));
        assert!(!rules.allows("cargonauta run", ro), "el prefijo debe terminar en una palabra completa");
        // Encadenar: todas las órdenes tienen que estar permitidas (las de solo lectura cuentan).
        assert!(rules.allows("npm test && cargo build", ro) && rules.allows("git status; npm test", ro));
        assert!(!rules.allows("npm test && curl evil.test", ro) && !rules.allows("npm test | sh", ro));
        // Lo que no se puede analizar nunca se da por permitido, salvo que la regla sea ese texto exacto.
        assert!(!rules.allows("cargo test > out.txt", ro) && !rules.allows("cargo test $(id)", ro));
        // Denegar manda, también dentro de una cadena.
        assert!(rules.denies("git push origin main") && rules.denies("npm test && git push origin x") && rules.denies("rm -rf x"));
        assert!(!rules.denies("git status") && !rules.denies("git pushover"));
    }

    #[test]
    fn el_almacen_guarda_por_carpeta_y_borra() {
        let file = tmp_file("store");
        let s = RuleStore::new(file.clone());
        let (a, b) = (std::env::temp_dir().join("proyecto-a"), std::env::temp_dir().join("proyecto-b"));
        assert_eq!(s.load(&a), Rules::default());
        s.add_allow(&a, "npm   test").unwrap();
        s.add_allow(&a, "npm test").unwrap();
        s.add_allow(&b, "cargo build").unwrap();
        assert_eq!(s.load(&a).allow, ["npm test"], "se normaliza y no se repite");
        assert_eq!(s.load(&b).allow, ["cargo build"]);
        s.remove(&a, "allow", "npm test").unwrap();
        assert!(s.load(&a).allow.is_empty() && !s.load(&b).allow.is_empty());
        // Un archivo roto no hace daño.
        std::fs::write(&file, "no es json").unwrap();
        assert_eq!(s.load(&a), Rules::default());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn pregunta_una_vez_y_respeta_la_respuesta() {
        let script = Script::new(&[Decision::Once, Decision::Deny]);
        let p = Permissions::new(script.clone(), None, Path::new("."), Arc::new(AtomicBool::new(false)));
        assert_eq!(block(p.check_command("npm test", "", no_read_only)), Verdict::Allow);
        assert!(matches!(block(p.check_command("npm test", "", no_read_only)), Verdict::Deny(m) if m.contains("No lo reintentes") || m.to_lowercase().contains("retry")));
        // «Una vez» no deja nada guardado: la segunda vez volvió a preguntar.
        assert_eq!(script.asked().len(), 2);
        assert_eq!(script.asked()[0], ApprovalRequest { tool: Tool::Command, detail: "npm test".into(), risky: false, agent: String::new() });
    }

    #[test]
    fn siempre_guarda_la_regla_y_ya_no_pregunta() {
        let file = tmp_file("always");
        let store = RuleStore::new(file.clone());
        let root = std::env::temp_dir().join("proyecto-always");
        let script = Script::new(&[Decision::AlwaysCommand]);
        let p = Permissions::new(script.clone(), Some(store.clone()), &root, Arc::new(AtomicBool::new(false)));
        assert_eq!(block(p.check_command("npm test", "revisor", no_read_only)), Verdict::Allow);
        assert_eq!(block(p.check_command("npm test", "", no_read_only)), Verdict::Allow);
        assert_eq!(script.asked().len(), 1);
        assert_eq!(script.asked()[0].agent, "revisor");
        // Y queda para la próxima vez que se abra el proyecto.
        assert_eq!(store.load(&root).allow, ["npm test"]);
        let again = Permissions::new(Script::new(&[]), Some(store.clone()), &root, Arc::new(AtomicBool::new(false)));
        assert_eq!(block(again.check_command("npm test", "", no_read_only)), Verdict::Allow);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn permitir_todo_vale_para_la_conversacion_pero_no_para_lo_de_riesgo() {
        let broker = Broker::default();
        let flag = broker.allow_all_for("conv-1");
        let script = Script::new(&[Decision::AllowAll, Decision::Once, Decision::Deny]);
        let p = Permissions::new(script.clone(), None, Path::new("."), flag.clone());
        assert_eq!(block(p.check_command("npm test", "", no_read_only)), Verdict::Allow);
        // A partir de aquí no pregunta por comandos normales…
        assert_eq!(block(p.check_command("cargo build", "", no_read_only)), Verdict::Allow);
        assert_eq!(script.asked().len(), 1);
        // …pero lo de riesgo siempre pregunta, y se queda en una sola vez aunque se responda «todo».
        assert_eq!(block(p.check_command("git push origin main", "", no_read_only)), Verdict::Allow);
        assert!(script.asked()[1].risky);
        assert!(matches!(block(p.check_command("git push origin main", "", no_read_only)), Verdict::Deny(_)));
        assert_eq!(script.asked().len(), 3);
        // La bandera es de la conversación: otra Permissions de la misma conversación la comparte; otra conversación, no.
        assert!(broker.allow_all_for("conv-1").load(Ordering::Relaxed));
        assert!(!broker.allow_all_for("conv-2").load(Ordering::Relaxed));
    }

    #[test]
    fn lo_de_riesgo_no_se_puede_dejar_permitido_para_siempre() {
        let file = tmp_file("risky");
        let store = RuleStore::new(file.clone());
        let root = std::env::temp_dir().join("proyecto-risky");
        let script = Script::new(&[Decision::AlwaysCommand, Decision::AllowAll, Decision::Deny]);
        let p = Permissions::new(script.clone(), Some(store.clone()), &root, Arc::new(AtomicBool::new(false)));
        assert_eq!(block(p.check_command("git reset --hard", "", no_read_only)), Verdict::Allow);
        assert_eq!(block(p.check_command("git reset --hard", "", no_read_only)), Verdict::Allow);
        assert!(matches!(block(p.check_command("git reset --hard", "", no_read_only)), Verdict::Deny(_)));
        assert_eq!(script.asked().len(), 3, "preguntó las tres veces");
        assert!(store.load(&root).allow.is_empty(), "no se guardó nada");
        // Ni siquiera una regla escrita a mano lo deja pasar sin preguntar.
        let manual = Permissions::new(Script::new(&[Decision::Deny]), None, &root, Arc::new(AtomicBool::new(false))).with_rules(Rules { allow: vec!["git reset --hard".into()], deny: vec![] });
        assert!(matches!(block(manual.check_command("git reset --hard", "", no_read_only)), Verdict::Deny(_)));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn una_regla_de_denegar_no_pregunta_ni_se_puede_aprobar() {
        let script = Script::new(&[Decision::Once]);
        let p = Permissions::new(script.clone(), None, Path::new("."), Arc::new(AtomicBool::new(false))).with_rules(Rules { allow: vec![], deny: vec!["npm publish *".into()] });
        assert!(matches!(block(p.check_command("npm publish --access public", "", no_read_only)), Verdict::Deny(_)));
        assert!(script.asked().is_empty());
    }

    #[test]
    fn la_web_pregunta_cada_vez_salvo_con_permitir_todo() {
        let script = Script::new(&[Decision::Once, Decision::AllowAll]);
        let p = Permissions::new(script.clone(), None, Path::new("."), Arc::new(AtomicBool::new(false)));
        assert_eq!(block(p.check_web("https://docs.rs/x", "")), Verdict::Allow);
        assert_eq!(block(p.check_web("https://docs.rs/y", "")), Verdict::Allow);
        assert_eq!(block(p.check_web("https://docs.rs/z", "")), Verdict::Allow);
        assert_eq!(script.asked().len(), 2);
        assert_eq!(script.asked()[0].tool, Tool::Web);
    }

    #[test]
    fn el_panel_responde_a_traves_del_intermediario() {
        let broker = Arc::new(Broker::default());
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let sink = events.clone();
        let emit: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |l| sink.lock().unwrap().push(serde_json::from_str(&l).unwrap()));
        let ui = UiApprover { broker: broker.clone(), conversation: "c9".into(), cancel: Arc::new(AtomicBool::new(false)), emit };
        let fut = ui.ask(ApprovalRequest { tool: Tool::Command, detail: "npm test".into(), risky: false, agent: "explore".into() });
        // La pregunta salió al panel con su identificador…
        let (id, detail) = {
            let ev = events.lock().unwrap();
            assert_eq!((ev[0]["type"].as_str(), ev[0]["tool"].as_str(), ev[0]["agent"].as_str()), (Some("pulso_permission"), Some("command"), Some("explore")));
            (ev[0]["id"].as_str().unwrap().to_string(), ev[0]["detail"].as_str().unwrap().to_string())
        };
        assert_eq!(detail, "npm test");
        assert_eq!(broker.pending_count(), 1);
        // …y la respuesta de la persona la despierta.
        assert!(broker.respond(&id, Decision::AlwaysCommand));
        assert_eq!(block(fut), Decision::AlwaysCommand);
        assert_eq!(broker.pending_count(), 0);
        assert_eq!(events.lock().unwrap().last().unwrap()["type"], "pulso_permission_resolved");
        // Responder a una pregunta que ya no existe no hace nada.
        assert!(!broker.respond(&id, Decision::Once) && !broker.respond("inventado", Decision::Once));
    }

    #[test]
    fn detener_la_conversacion_deniega_las_preguntas_pendientes() {
        let broker = Arc::new(Broker::default());
        let cancel = Arc::new(AtomicBool::new(false));
        let ui = UiApprover { broker: broker.clone(), conversation: "c10".into(), cancel: cancel.clone(), emit: Arc::new(|_| {}) };
        let fut = ui.ask(ApprovalRequest { tool: Tool::Command, detail: "x".into(), risky: false, agent: String::new() });
        let started = Instant::now();
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(block(fut), Decision::Deny);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!(broker.pending_count(), 0);
    }

    #[test]
    fn interpreta_las_respuestas_del_panel() {
        assert_eq!((Decision::parse("once"), Decision::parse("always"), Decision::parse("all")), (Decision::Once, Decision::AlwaysCommand, Decision::AllowAll));
        assert_eq!((Decision::parse("deny"), Decision::parse(""), Decision::parse("cualquier cosa")), (Decision::Deny, Decision::Deny, Decision::Deny));
    }
}
