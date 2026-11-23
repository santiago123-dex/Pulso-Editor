//! Traducción de los mensajes que nacen en Rust (errores de archivos, Git, terminal, LSP, IA…) y de
//! la herramienta de línea de comandos `pulso`. Igual que en la interfaz (src/i18n.ts), el texto en
//! español es la clave: lo que no tiene traducción se muestra en español.
//!
//! - `tr("…")` traduce un texto fijo.
//! - `trf("… {nombre} …", &[("nombre", &valor)])` traduce y rellena valores.
//!
//! La ventana fija el idioma al arrancar con `i18n_set_lang` (el que eligió la persona en
//! Configuración). La herramienta `pulso` no puede leer ese ajuste y usa `system_lang()`.
//! Las pruebas de abajo comprueban que cada `tr`/`trf` del código tenga su traducción.
use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// "en" activa el inglés; cualquier otro valor, el español.
pub fn set_lang(lang: &str) {
    ENGLISH.store(lang.eq_ignore_ascii_case("en"), Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

fn lookup(es: &str) -> Option<&'static str> {
    EN.iter().find(|(k, _)| *k == es).map(|(_, v)| *v)
}

fn tr_in(english: bool, es: &'static str) -> &'static str {
    if english {
        lookup(es).unwrap_or(es)
    } else {
        es
    }
}

fn trf_in(english: bool, es: &'static str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut out = tr_in(english, es).to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), &value.to_string());
    }
    out
}

/// Traduce un texto fijo de la interfaz.
pub fn tr(es: &'static str) -> &'static str {
    tr_in(is_english(), es)
}

/// Traduce y rellena los `{nombre}` del texto con los valores dados.
pub fn trf(es: &'static str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    trf_in(is_english(), es, args)
}

/// Idioma para la herramienta `pulso`: `PULSO_LANG`, luego `LC_ALL`, `LC_MESSAGES` y `LANG`, y en
/// Windows el idioma del usuario. Español si empieza por «es»; si no, inglés.
pub fn system_lang() -> &'static str {
    let pick = |v: &str| if v.trim().to_ascii_lowercase().starts_with("es") { "es" } else { "en" };
    for var in ["PULSO_LANG", "LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() && v != "C" && v != "POSIX" {
                return pick(&v);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut buf = [0u16; 85];
        let n = unsafe { windows_sys::Win32::Globalization::GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        if n > 1 {
            return pick(&String::from_utf16_lossy(&buf[..(n - 1) as usize]));
        }
    }
    "es"
}

#[tauri::command]
pub fn i18n_set_lang(lang: String) {
    set_lang(&lang);
}

const HELP_EN: &str = "\
Pulso Editor

  pulso                       AI assistant in this terminal (current folder)
  pulso -p \"question\"         A single question, then exit
  pulso .  |  pulso file      Open the folder or the file in the Pulso window
  pulso -g file:line:col      Open at a line

Assistant options:
  --provider claude|codex|antigravity   (claude by default)
  --model <model>   --effort low|medium|high|xhigh|max
  --edit (allows editing files)   --trust (trust the folder without asking)

The assistant only works in project folders: the first time in each one it asks for trust, and it
doesn't open a drive root, your home folder, Desktop, Documents, Downloads or system folders.

Inside the assistant: /help, /provider <name>, /model <model>, /effort <level>, /edit, /read, /new, /exit
";

const EN: &[(&str, &str)] = &[
    // ---------- Procesos y herramientas ----------
    ("sin salida", "no output"),
    ("sin salida de error", "no error output"),
    ("tardó demasiado", "took too long"),
    // ---------- Asistente de IA ----------
    ("No se encontró Claude Code en este equipo.", "Claude Code wasn't found on this computer."),
    ("No se pudo comprobar si hay una sesión iniciada.", "Couldn't check whether there's an active session."),
    ("No se encontró Codex CLI (ChatGPT) en este equipo.", "Codex CLI (ChatGPT) wasn't found on this computer."),
    ("No se pudo comprobar la sesión de Codex.", "Couldn't check the Codex session."),
    ("No se encontró Antigravity CLI (`agy`) en este equipo.", "Antigravity CLI (`agy`) wasn't found on this computer."),
    ("Proveedor de IA no soportado", "Unsupported AI provider"),
    ("La herramienta no informó el uso del plan.", "The tool didn't report the plan usage."),
    ("Identificador de sesión no válido", "Invalid session identifier"),
    ("Modelo no válido", "Invalid model"),
    ("Nivel de esfuerzo no válido", "Invalid effort level"),
    ("Modo de permisos no válido", "Invalid permission mode"),
    ("No se pudo iniciar {program}: {e}", "Couldn't start {program}: {e}"),
    ("Identificador de conversación no válido", "Invalid conversation identifier"),
    ("Abre una carpeta de proyecto para hablar con la IA.", "Open a project folder to talk to the AI."),
    ("No se permite lanzar la IA en esa carpeta ({reason}). Abre una carpeta de proyecto concreta.", "The AI can't be launched in that folder ({reason}). Open a specific project folder."),
    ("El mensaje está vacío.", "The message is empty."),
    ("Esta conversación ya está respondiendo.", "This conversation is already answering."),
    ("El mensaje es demasiado largo para pasarlo a través de un script .cmd en Windows. Instala el ejecutable nativo de agy o acorta el contexto.", "The message is too long to pass through a .cmd script on Windows. Install the native agy executable or shorten the context."),
    ("La ejecución de Codex falló.", "The Codex run failed."),
    ("Error de Codex CLI.", "Codex CLI error."),
    ("Antigravity necesitó permiso para ejecutar un comando y no puede pedir confirmación en este modo.", "Antigravity needed permission to run a command and can't ask for confirmation in this mode."),
    ("Antigravity terminó con error.", "Antigravity finished with an error."),
    // ---------- Rutas y espacio de trabajo ----------
    ("La ruta está vacía", "The path is empty"),
    ("No se pudo resolver la ruta de forma segura", "Couldn't resolve the path safely"),
    ("Ruta no permitida", "Path not allowed"),
    ("La ruta del espacio de trabajo no es válida", "The workspace path isn't valid"),
    ("No se pudo abrir la carpeta: {e}", "Couldn't open the folder: {e}"),
    ("La ruta indicada no es una carpeta", "The given path isn't a folder"),
    ("Acceso denegado: ruta fuera del espacio de trabajo", "Access denied: path outside the workspace"),
    ("Acceso denegado: la ruta está fuera del espacio de trabajo abierto", "Access denied: the path is outside the open workspace"),
    ("Escritura denegada: ruta no permitida", "Write denied: path not allowed"),
    ("Escritura denegada: la ruta está fuera del espacio de trabajo abierto", "Write denied: the path is outside the open workspace"),
    ("La ruta no es una carpeta válida", "The path isn't a valid folder"),
    // ---------- GitHub ----------
    ("No se encontró Git. Instálalo para conectar con GitHub desde Pulso", "Git wasn't found. Install it to connect to GitHub from Pulso"),
    ("La autorización en GitHub tardó demasiado y se canceló. Vuelve a intentarlo", "GitHub authorization took too long and was canceled. Try again"),
    ("Git no respondió a tiempo", "Git didn't respond in time"),
    ("No se pudo autorizar con GitHub. Comprueba que Git Credential Manager esté instalado (viene con Git para Windows) y vuelve a intentarlo", "Couldn't authorize with GitHub. Check that Git Credential Manager is installed (it comes with Git for Windows) and try again"),
    ("Git no tiene una sesión de GitHub guardada", "Git has no saved GitHub session"),
    ("Ruta de API de GitHub no válida", "Invalid GitHub API path"),
    ("Dirección de API de GitHub no permitida", "GitHub API address not allowed"),
    ("Método HTTP no permitido", "HTTP method not allowed"),
    ("No se pudo contactar con GitHub: {e}", "Couldn't reach GitHub: {e}"),
    ("Error leyendo respuesta de GitHub: {e}", "Error reading GitHub's response: {e}"),
    ("GitHub rechazó la sesión guardada en Git (caducó o se revocó). Vuelve a iniciar sesión desde una terminal con «git credential-manager github login» y reintenta.", "GitHub rejected the session saved in Git (it expired or was revoked). Sign in again from a terminal with “git credential-manager github login” and retry."),
    ("GitHub respondió {status}", "GitHub responded {status}"),
    ("Solo se pueden abrir enlaces http o https", "Only http or https links can be opened"),
    ("No se pudo abrir el navegador: {e}", "Couldn't open the browser: {e}"),
    // ---------- Inicio de sesión con GitHub por código ----------
    ("Dirección de GitHub no permitida", "GitHub address not allowed"),
    ("GitHub devolvió una respuesta que Pulso no entiende.", "GitHub returned a response Pulso doesn't understand."),
    ("El código caducó antes de que lo autorizaras. Vuelve a empezar.", "The code expired before you authorized it. Start again."),
    ("Cancelaste la autorización en GitHub.", "You canceled the authorization on GitHub."),
    ("La aplicación de Pulso en GitHub no tiene activado el inicio de sesión por código (Device Flow).", "Pulso's GitHub app doesn't have sign-in with a code (Device Flow) enabled."),
    ("GitHub no reconoce la aplicación de Pulso (identificador incorrecto).", "GitHub doesn't recognize Pulso's app (wrong identifier)."),
    ("GitHub rechazó el código. Vuelve a empezar.", "GitHub rejected the code. Start again."),
    ("GitHub rechazó el inicio de sesión: {reason}", "GitHub rejected the sign-in: {reason}"),
    ("Esta compilación de Pulso no tiene configurado el inicio de sesión con GitHub.", "This build of Pulso doesn't have GitHub sign-in configured."),
    ("Inicio de sesión cancelado.", "Sign-in canceled."),
    // ---------- Git ----------
    ("No se pudo ejecutar git: {e}", "Couldn't run git: {e}"),
    ("No se pudo ejecutar git", "Couldn't run git"),
    ("No se encontró Git. Instálalo (git-scm.com) y reinicia Pulso para usar el control de código fuente", "Git wasn't found. Install it (git-scm.com) and restart Pulso to use source control"),
    ("Esta carpeta no es un repositorio de Git", "This folder isn't a Git repository"),
    ("Escribe un mensaje para el commit", "Write a commit message"),
    ("No hay cambios preparados para confirmar", "There are no staged changes to commit"),
    ("No se pudo enviar el mensaje a git", "Couldn't send the message to git"),
    ("El archivo es demasiado grande para mostrar diferencias", "The file is too large to show differences"),
    ("Ruta no válida", "Invalid path"),
    ("Ruta de origen no válida", "Invalid source path"),
    ("Escribe un nombre para la rama", "Write a name for the branch"),
    ("El nombre de la rama no puede empezar por «-»", "The branch name can't start with “-”"),
    ("«{name}» no es un nombre de rama válido", "“{name}” isn't a valid branch name"),
    ("«{short}» no es un nombre de rama válido", "“{short}” isn't a valid branch name"),
    ("Ruta no válida: {path}", "Invalid path: {path}"),
    ("La operación tardó más de {secs} s y se canceló. Si Git esperaba un inicio de sesión, inicia sesión desde una terminal y reinténtalo", "The operation took more than {secs} s and was canceled. If Git was waiting for a sign-in, sign in from a terminal and retry"),
    ("Estás en HEAD desacoplado: cambia a una rama antes de sincronizar", "You're on a detached HEAD: switch to a branch before syncing"),
    ("Esta rama no tiene remoto. Añade uno con «git remote add origin <url>» en la terminal", "This branch has no remote. Add one with “git remote add origin <url>” in the terminal"),
    ("{e}\n\nTu rama y la remota tienen cambios distintos. Pulso solo trae cambios que se pueden aplicar sin mezclar; resuélvelo en la terminal (git pull --rebase o git merge).", "{e}\n\nYour branch and the remote one have different changes. Pulso only pulls changes that apply without merging; resolve it in the terminal (git pull --rebase or git merge)."),
    ("Esta rama no sigue a ninguna rama remota. Haz push primero para crearla en el remoto", "This branch doesn't track any remote branch. Push first to create it on the remote"),
    ("No se pudo enviar a la papelera {path}: {e}", "Couldn't move {path} to the Recycle Bin: {e}"),
    ("Identificador de commit no válido", "Invalid commit identifier"),
    // ---------- Archivos, búsqueda y credenciales ----------
    ("El archivo es demasiado grande ({size} MB; límite {limit} MB)", "The file is too large ({size} MB; limit {limit} MB)"),
    ("Solo se pueden importar archivos de tema .json o .jsonc", "Only .json or .jsonc theme files can be imported"),
    ("El archivo de tema es demasiado grande o no es válido", "The theme file is too large or invalid"),
    ("El historial del asistente es demasiado grande.", "The assistant history is too large."),
    ("El historial del asistente no tiene un formato válido.", "The assistant history doesn't have a valid format."),
    ("Clave de credencial no permitida", "Credential key not allowed"),
    ("Ya existe un archivo o carpeta con ese nombre", "A file or folder with that name already exists"),
    ("No se puede mover una carpeta dentro de sí misma", "A folder can't be moved into itself"),
    ("No se pudo abrir el explorador de archivos: {e}", "Couldn't open File Explorer: {e}"),
    ("La búsqueda está vacía", "The search is empty"),
    ("Expresión regular no válida: {e}", "Invalid regular expression: {e}"),
    ("El archivo es binario, demasiado grande o no es UTF-8; no se modifica", "The file is binary, too large or not UTF-8; it isn't changed"),
    ("El archivo cambió desde la búsqueda ({expected} coincidencias previstas, {now} ahora)", "The file changed since the search ({expected} matches expected, {now} now)"),
    ("En Linux y macOS el paquete ya instala el comando `pulso` en el PATH; no hace falta hacer nada más.", "On Linux and macOS the package already installs the `pulso` command in the PATH; nothing else is needed."),
    ("No se encontró la carpeta del programa", "The program folder wasn't found"),
    ("No se encontró pulso.exe junto a Pulso Editor (¿es una compilación de desarrollo?).", "pulso.exe wasn't found next to Pulso Editor (is it a development build?)."),
    ("Listo: `pulso` quedó disponible en {dir}. Abre una terminal nueva para usarlo.", "Done: `pulso` is now available in {dir}. Open a new terminal to use it."),
    // ---------- Servidor de lenguaje ----------
    ("No se encontró el servidor de TypeScript de Pulso", "Pulso's TypeScript server wasn't found"),
    ("No se pudo iniciar el servidor de TypeScript: {e}", "Couldn't start the TypeScript server: {e}"),
    ("No se encontró la configuración del servidor de lenguaje", "The language server configuration wasn't found"),
    ("La carpeta de trabajo ya no existe", "The workspace folder no longer exists"),
    ("El proyecto usa TypeScript {major}, pero no se pudo iniciar Node.js ({e}). Se usa TypeScript 7, que puede marcar opciones de tsconfig que ya no existen.", "The project uses TypeScript {major}, but Node.js couldn't be started ({e}). TypeScript 7 is used instead, which may flag tsconfig options that no longer exist."),
    ("No se pudo abrir la entrada del servidor", "Couldn't open the server's input"),
    ("No se pudo abrir la salida del servidor", "Couldn't open the server's output"),
    ("No se pudo leer el error del servidor", "Couldn't read the server's error output"),
    ("El servidor de lenguaje se cerró", "The language server closed"),
    ("El servidor LSP ya no está activo", "The LSP server is no longer active"),
    // ---------- Terminal ----------
    ("No se pudo iniciar «{shell}»: {e}", "Couldn't start “{shell}”: {e}"),
    ("Símbolo del sistema", "Command Prompt"),
    ("Shell no permitida o no disponible: «{id}»", "Shell not allowed or unavailable: “{id}”"),
    ("La shell solicitada no está en la lista de shells autorizadas", "The requested shell isn't in the list of allowed shells"),
    ("No se encontró ninguna shell instalada", "No installed shell was found"),
    ("La terminal ya no existe", "The terminal no longer exists"),
    // ---------- Actualizaciones ----------
    ("Las actualizaciones solo funcionan en la versión instalada de Pulso.", "Updates only work in the installed version of Pulso."),
    ("No se pudo preparar el actualizador: {e}", "Couldn't prepare the updater: {e}"),
    ("No se pudo comprobar si hay una versión nueva: {e}", "Couldn't check for a new version: {e}"),
    ("Ya no hay ninguna versión nueva pendiente.", "There's no pending new version anymore."),
    ("No se pudo descargar la actualización: {e}", "Couldn't download the update: {e}"),
    ("No se pudo instalar la actualización: {e}", "Couldn't install the update: {e}"),
    // ---------- Herramienta de línea de comandos `pulso` ----------
    (crate::termchat::HELP, HELP_EN),
    ("Falta el valor de {name}.", "Missing value for {name}."),
    ("Cambiar IA (claude | codex | antigravity)", "Change AI (claude | codex | antigravity)"),
    ("Elegir modelo activo (vacío = predeterminado)", "Choose the active model (empty = default)"),
    ("Nivel de razonamiento (low | medium | high | max)", "Reasoning level (low | medium | high | max)"),
    ("Activar edición de archivos en esta carpeta", "Allow editing files in this folder"),
    ("Volver a modo solo lectura", "Back to read-only mode"),
    ("Iniciar una conversación nueva", "Start a new conversation"),
    ("Limpiar la pantalla", "Clear the screen"),
    ("Mostrar ayuda y atajos", "Show help and shortcuts"),
    ("Salir de Pulso CLI", "Exit Pulso CLI"),
    ("⚡ edición activa", "⚡ editing on"),
    ("Shift+Tab alternar edición", "Shift+Tab toggle editing"),
    ("◈ Pulso CLI · Seguridad del espacio de trabajo", "◈ Pulso CLI · Workspace safety"),
    ("La IA podrá leer archivos aquí y modificarlos solo si activas /edit o Shift+Tab.", "The AI will be able to read files here, and change them only if you turn on /edit or Shift+Tab."),
    ("es la raíz de una unidad", "is a drive root"),
    ("es tu carpeta personal", "is your home folder"),
    ("mezcla todos tus proyectos y archivos", "mixes all your projects and files"),
    ("es una carpeta del sistema", "is a system folder"),
    ("No se encontró {name} junto a este comando.", "{name} wasn't found next to this command."),
    ("No se pudo abrir Pulso Editor: {e}", "Couldn't open Pulso Editor: {e}"),
    ("No se pudo leer la carpeta actual: {e}", "Couldn't read the current folder: {e}"),
    ("{icon} Esta carpeta {why}:\n  {dir}\n\nEntra en la carpeta de un proyecto (cd) y vuelve a ejecutar `pulso`.", "{icon} This folder {why}:\n  {dir}\n\nGo into a project folder (cd) and run `pulso` again."),
    ("✗ No abro el asistente aquí.", "✗ I won't open the assistant here."),
    ("Carpeta sin confianza. Ejecuta `pulso` una vez en ella desde una terminal, o añade --trust.", "Untrusted folder. Run `pulso` in it once from a terminal, or add --trust."),
    ("¿Confiar y continuar?", "Trust and continue?"),
    ("[s/N · Ctrl+C cancelar]", "[y/N · Ctrl+C cancel]"),
    ("sí", "yes"),
    ("{icon} Sin confianza, no continúo.", "{icon} Not trusted, stopping."),
    ("Cancelado por el usuario (Ctrl+C)", "Canceled by the user (Ctrl+C)"),
    ("La herramienta terminó con el código {code} sin responder.", "The tool exited with code {code} without answering."),
    ("herramienta", "tool"),
    ("herramientas", "tools"),
    ("· Ctrl+C cancelar", "· Ctrl+C cancel"),
    ("Escribe una instrucción o \"/\" para comandos…", "Type an instruction or \"/\" for commands…"),
    ("  ▸▸ edición activa (Shift+Tab solo lectura)", "  ▸▸ editing on (Shift+Tab read only)"),
    ("▸▸ edición activa", "▸▸ editing on"),
    ("(Shift+Tab solo lectura)", "(Shift+Tab read only)"),
    ("Pulsa Ctrl+C de nuevo para salir", "Press Ctrl+C again to exit"),
    ("/help · /model · Ctrl+C salir", "/help · /model · Ctrl+C exit"),
    ("Sesión de Pulso CLI cerrada.", "Pulso CLI session closed."),
    ("Conversación nueva iniciada.", "New conversation started."),
    ("Modo edición activado para esta carpeta.", "Editing mode turned on for this folder."),
    ("Proveedor cambiado a {provider} (conversación nueva).", "Provider changed to {provider} (new conversation)."),
];

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCES: &[(&str, &str)] = &[
        ("aichat.rs", include_str!("aichat.rs")),
        ("fsguard.rs", include_str!("fsguard.rs")),
        ("githubauth.rs", include_str!("githubauth.rs")),
        ("githubdevice.rs", include_str!("githubdevice.rs")),
        ("gitops.rs", include_str!("gitops.rs")),
        ("lib.rs", include_str!("lib.rs")),
        ("lsp.rs", include_str!("lsp.rs")),
        ("term.rs", include_str!("term.rs")),
        ("termchat.rs", include_str!("termchat.rs")),
        ("termui.rs", include_str!("termui.rs")),
        ("updates.rs", include_str!("updates.rs")),
        ("bin/pulso.rs", include_str!("bin/pulso.rs")),
    ];

    /// Lee el literal de cadena que empieza en `s` (justo después de la comilla de apertura).
    fn read_literal(s: &str) -> String {
        let mut out = String::new();
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('r') => out.push('\r'),
                    Some(other) => out.push(other),
                    None => break,
                },
                c => out.push(c),
            }
        }
        out
    }

    fn keys_in(src: &str) -> Vec<String> {
        let mut keys = Vec::new();
        for pat in ["tr(\"", "trf(\""] {
            let mut rest = src;
            while let Some(i) = rest.find(pat) {
                let before = &rest[..i];
                let prev = before.chars().last();
                rest = &rest[i + pat.len()..];
                if prev.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                keys.push(read_literal(rest));
            }
        }
        keys
    }

    fn holes(s: &str) -> Vec<String> {
        let mut v: Vec<String> = s
            .split('{')
            .skip(1)
            .filter_map(|p| p.split_once('}').map(|(name, _)| name.to_string()))
            .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '_'))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn every_key_in_the_code_has_an_english_translation() {
        let mut missing = Vec::new();
        for (file, src) in SOURCES {
            for key in keys_in(src) {
                if lookup(&key).is_none() {
                    missing.push(format!("{file}: {key}"));
                }
            }
        }
        for cmd in crate::termui::SLASH_COMMANDS {
            if lookup(cmd.desc).is_none() {
                missing.push(format!("termui.rs (SLASH_COMMANDS): {}", cmd.desc));
            }
        }
        assert!(missing.is_empty(), "faltan traducciones:\n{}", missing.join("\n"));
    }

    #[test]
    fn translations_keep_the_same_placeholders() {
        let bad: Vec<_> = EN.iter().filter(|(k, v)| holes(k) != holes(v)).map(|(k, _)| *k).collect();
        assert!(bad.is_empty(), "valores distintos en: {bad:?}");
    }

    // Sin tocar el idioma global: las demás pruebas corren en paralelo y comparan mensajes en español.
    #[test]
    fn translation_follows_the_language_given() {
        assert_eq!(tr_in(true, "Ruta no válida"), "Invalid path");
        assert_eq!(trf_in(true, "Ruta no válida: {path}", &[("path", &"a/b")]), "Invalid path: a/b");
        assert_eq!(tr_in(true, "texto sin traducción"), "texto sin traducción");
        assert_eq!(trf_in(false, "Ruta no válida: {path}", &[("path", &"a/b")]), "Ruta no válida: a/b");
    }
}
