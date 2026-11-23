//! `pulso`: el comando de la terminal. Sin argumentos abre el asistente de IA en esta terminal;
//! con una ruta (`pulso .`, `pulso archivo`, `pulso -g archivo:línea`) abre la ventana de Pulso Editor.
use pulso_editor_lib::aichat::{build_agy_args, build_claude_args, build_codex_args, claude_program, resolve_cli, spawn_stream, ChatOptions};
use pulso_editor_lib::i18n::{tr, trf};
use pulso_editor_lib::termchat::{normalize_provider, route, Action, Ev, Parser, Settings, HELP};
use pulso_editor_lib::termui::{
    add_trusted, broad_dir_reason, git_branch, header_banner, is_trusted, paint, provider_color,
    provider_label, render_line, rule, slash_matches, tool_badge, trust_card, trusted_list,
    AMBER, BG_SEL, BRIGHT, CYAN, DIM, INDIGO, MINT, ROSE, RULE, SLATE, VIOLET,
};
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

enum Msg {
    Line(String),
    Exit(Option<i32>, String),
}

/// Colores solo cuando hay una terminal delante y la persona no los desactivó (NO_COLOR).
fn use_color() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

fn main() {
    enable_ansi();
    // La terminal no puede leer el idioma elegido en la ventana: se usa el del sistema (o PULSO_LANG).
    pulso_editor_lib::i18n::set_lang(pulso_editor_lib::i18n::system_lang());
    let args: Vec<String> = std::env::args().skip(1).collect();
    match route(&args) {
        Action::Gui => open_window(&args),
        Action::Help => print!("{}", tr(HELP)),
        Action::Version => println!("Pulso Editor {}", env!("CARGO_PKG_VERSION")),
        Action::Error(e) => {
            eprintln!("{} {e}", paint(use_color(), ROSE, "✗"));
            std::process::exit(2);
        }
        Action::Ask(s, q) => {
            if let Err(e) = guard_folder(&s) {
                eprintln!("{e}");
                std::process::exit(2);
            }
            let mut chat = Chat { settings: s, session: None, color: use_color() };
            std::process::exit(if chat.turn(&q) { 0 } else { 1 });
        }
        Action::Repl(s) => {
            if let Err(e) = guard_folder(&s) {
                eprintln!("{e}");
                std::process::exit(2);
            }
            repl(s);
        }
    }
}

/// Abre la ventana gráfica sin quedarse esperando: la terminal queda libre al instante.
fn open_window(args: &[String]) {
    let name = if cfg!(windows) { "pulso-editor.exe" } else { "pulso-editor" };
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(name)));
    let Some(exe) = exe.filter(|p| p.exists()) else {
        eprintln!("{}", trf("No se encontró {name} junto a este comando.", &[("name", &name)]));
        std::process::exit(1);
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    if let Err(e) = cmd.spawn() {
        eprintln!("{}", trf("No se pudo abrir Pulso Editor: {e}", &[("e", &e)]));
        std::process::exit(1);
    }
}

// ---------- Carpeta: límites y confianza ----------

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn trust_file() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| home_dir().map(|h| h.join(".config")))?;
    Some(base.join("dev.pulso.editor").join("trusted-folders.json"))
}

/// El asistente solo trabaja en carpetas de proyecto, y solo en las que la persona aceptó una vez.
fn guard_folder(s: &Settings) -> Result<(), String> {
    let dir = std::env::current_dir().map_err(|e| trf("No se pudo leer la carpeta actual: {e}", &[("e", &e)]))?;
    let color = std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none();
    if let Some(why) = broad_dir_reason(&dir, home_dir().as_deref()) {
        return Err(trf(
            "{icon} Esta carpeta {why}:\n  {dir}\n\nEntra en la carpeta de un proyecto (cd) y vuelve a ejecutar `pulso`.",
            &[
                ("icon", &paint(color, ROSE, tr("✗ No abro el asistente aquí."))),
                ("why", &why),
                ("dir", &paint(color, SLATE, &dir.display().to_string())),
            ],
        ));
    }
    let file = trust_file();
    let text = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    if is_trusted(&trusted_list(&text), &dir) {
        return Ok(());
    }
    if !s.trust {
        if !std::io::stdin().is_terminal() {
            return Err(tr("Carpeta sin confianza. Ejecuta `pulso` una vez en ella desde una terminal, o añade --trust.").into());
        }
        println!("\n{}", trust_card(&dir, home_dir().as_deref(), color));
        print!(
            "\n{} {} ",
            paint(color, BRIGHT, tr("¿Confiar y continuar?")),
            paint(color, DIM, tr("[s/N · Ctrl+C cancelar]"))
        );
        let _ = std::io::stdout().flush();
        let accepted = if let Some(raw) = RawConsole::enter() {
            let ok = loop {
                match raw.read_key() {
                    Key::Char('s') | Key::Char('S') | Key::Char('y') | Key::Char('Y') => {
                        println!("{}", paint(color, MINT, tr("sí")));
                        break true;
                    }
                    Key::Char('n') | Key::Char('N') | Key::Enter | Key::Esc | Key::CtrlC | Key::CtrlD => {
                        println!("{}", paint(color, DIM, "cancelado"));
                        break false;
                    }
                    _ => {}
                }
            };
            drop(raw);
            ok
        } else {
            let mut ans = String::new();
            let _ = std::io::stdin().lock().read_line(&mut ans);
            matches!(ans.trim().to_lowercase().as_str(), "s" | "si" | "sí" | "y" | "yes")
        };
        if !accepted {
            return Err(trf("{icon} Sin confianza, no continúo.", &[("icon", &paint(color, DIM, "⊘"))]));
        }
    }
    if let Some(f) = file {
        if let Some(parent) = f.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&f, add_trusted(&text, &dir));
    }
    Ok(())
}

// ---------- Conversación ----------

struct Chat {
    settings: Settings,
    session: Option<String>,
    color: bool,
}

const PULSE_FRAMES: [&str; 8] = [
    "▁▂▄▆█▆▄▂",
    "▂▄▆█▆▄▂▁",
    "▄▆█▆▄▂▁▂",
    "▆█▆▄▂▁▂▄",
    "█▆▄▂▁▂▄▆",
    "▆▄▂▁▂▄▆█",
    "▄▂▁▂▄▆█▆",
    "▂▁▂▄▆█▆▄",
];

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

impl Chat {
    fn command(&self, prompt: &str) -> Result<(String, Vec<String>, String), String> {
        let o = ChatOptions {
            session: self.session.clone(),
            model: self.settings.model.clone(),
            effort: self.settings.effort.clone(),
            mode: if self.settings.edit { "edit" } else { "read" }.into(),
        };
        match self.settings.provider.as_str() {
            "codex" => {
                let (prog, mut a) = resolve_cli("codex", "PULSO_CODEX_BIN", Some("@openai/codex"));
                a.extend(build_codex_args(&o)?);
                Ok((prog, a, prompt.to_string()))
            }
            "antigravity" => {
                let (prog, mut a) = resolve_cli("agy", "PULSO_AGY_BIN", None);
                a.extend(build_agy_args(&o, prompt)?);
                Ok((prog, a, String::new()))
            }
            _ => Ok((claude_program(), build_claude_args(&o)?, prompt.to_string())),
        }
    }

    /// Envía un mensaje y va imprimiendo la respuesta con formato. Devuelve si terminó bien.
    fn turn(&mut self, prompt: &str) -> bool {
        let (program, args, stdin) = match self.command(prompt) {
            Ok(c) => c,
            Err(e) => {
                self.fail(&e);
                return false;
            }
        };
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into());
        let (tx, rx) = mpsc::channel::<Msg>();
        let (tx1, tx2) = (Arc::new(Mutex::new(tx.clone())), Arc::new(Mutex::new(tx)));
        let pid = match spawn_stream(
            &program,
            &args,
            &cwd,
            &stdin,
            Arc::new(move |l| {
                let _ = tx1.lock().map(|t| t.send(Msg::Line(l)));
            }),
            Arc::new(move |c, e| {
                let _ = tx2.lock().map(|t| t.send(Msg::Exit(c, e)));
            }),
        ) {
            Ok(p) => p,
            Err(e) => {
                self.fail(&e);
                return false;
            }
        };

        let raw = RawConsole::enter();
        let started = Instant::now();
        let mut parser = Parser::new(&self.settings.provider);
        let mut view = View {
            color: self.color,
            out: std::io::stdout(),
            pending: String::new(),
            in_code: false,
            first: true,
            spinner_on: false,
            ticks: 0,
            tools_used: 0,
        };
        let mut result: Option<Result<(), String>> = None;
        let (mut stderr_tail, mut code, mut cancelled) = (String::new(), None, false);

        loop {
            if let Some(ref r) = raw {
                if r.poll_ctrl_c() {
                    kill_process_tree(pid);
                    cancelled = true;
                    break;
                }
            }
            match rx.recv_timeout(Duration::from_millis(85)) {
                Ok(Msg::Line(l)) => {
                    for ev in parser.feed(&l) {
                        match ev {
                            Ev::Session(id) => self.session = Some(id),
                            Ev::Text(t) => view.text(&t),
                            Ev::Tool(t) => view.tool(&t),
                            Ev::Done(r) => result = Some(r),
                        }
                    }
                }
                Ok(Msg::Exit(c, e)) => {
                    code = c;
                    stderr_tail = e;
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => view.tick(started.elapsed().as_secs_f32()),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(raw);
        view.finish();

        if cancelled {
            println!("  {} {}", paint(self.color, AMBER, "⊘"), paint(self.color, SLATE, tr("Cancelado por el usuario (Ctrl+C)")));
            return false;
        }

        let secs = started.elapsed().as_secs_f32();
        let ok = match result {
            Some(Ok(())) => true,
            Some(Err(e)) => {
                self.fail(&e);
                false
            }
            None if code == Some(0) && !view.first => true,
            None => {
                let detail = stderr_tail.trim();
                self.fail(&if detail.is_empty() {
                    trf("La herramienta terminó con el código {code} sin responder.", &[("code", &format!("{code:?}"))])
                } else {
                    detail.to_string()
                });
                false
            }
        };
        if ok && self.color {
            let tools_note = if view.tools_used > 0 {
                format!(" · {} {}", view.tools_used, if view.tools_used == 1 { tr("herramienta") } else { tr("herramientas") })
            } else {
                String::new()
            };
            let p_name = provider_label(&self.settings.provider);
            println!(
                "  {} {} {}",
                paint(true, RULE, "╰─"),
                paint(true, MINT, "✓"),
                paint(true, DIM, &format!("{p_name} · {secs:.1} s{tools_note}"))
            );
        }
        ok
    }

    fn fail(&self, msg: &str) {
        eprintln!("  {} {}", paint(self.color, ROSE, "✗"), paint(self.color, SLATE, msg));
    }
}

/// Lo que se ve mientras llega la respuesta: texto formateado por líneas, herramientas y pulso en vivo.
struct View {
    color: bool,
    out: std::io::Stdout,
    pending: String,
    in_code: bool,
    first: bool,
    spinner_on: bool,
    ticks: usize,
    tools_used: usize,
}

impl View {
    fn clear_spinner(&mut self) {
        if self.spinner_on {
            let _ = write!(self.out, "\r\x1b[2K");
            self.spinner_on = false;
        }
    }

    fn emit_line(&mut self, line: &str) {
        self.clear_spinner();
        let rendered = render_line(line, &mut self.in_code, self.color);
        let mark = if self.first { paint(self.color, &format!("1;{CYAN}"), "◈") } else { " ".to_string() };
        let _ = writeln!(self.out, "  {mark} {rendered}");
        self.first = false;
        let _ = self.out.flush();
    }

    fn text(&mut self, t: &str) {
        self.pending.push_str(t);
        while let Some(i) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=i).collect();
            self.emit_line(line.trim_end_matches(['\n', '\r']));
        }
    }

    fn flush_pending(&mut self) {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.emit_line(&rest);
        }
    }

    fn tool(&mut self, t: &str) {
        self.flush_pending();
        self.clear_spinner();
        self.tools_used += 1;
        let _ = writeln!(self.out, "{}", tool_badge(t, self.color));
        let _ = self.out.flush();
    }

    fn tick(&mut self, secs: f32) {
        if !self.color || !self.pending.is_empty() {
            return;
        }
        self.ticks += 1;
        let frame = PULSE_FRAMES[self.ticks % PULSE_FRAMES.len()];
        let tone = match (self.ticks / 4) % 3 {
            0 => CYAN,
            1 => INDIGO,
            _ => VIOLET,
        };
        let label = if self.first { "Pensando" } else { "Trabajando" };
        let _ = write!(
            self.out,
            "\r\x1b[2K  {} {}  {}",
            paint(true, tone, frame),
            paint(true, SLATE, &format!("{label}… {secs:.1} s")),
            paint(true, DIM, tr("· Ctrl+C cancelar")),
        );
        let _ = self.out.flush();
        self.spinner_on = true;
    }

    fn finish(&mut self) {
        self.flush_pending();
        self.clear_spinner();
        let _ = self.out.flush();
    }
}

// ---------- Cabecera y compositor interactivo ----------

fn print_header(c: &Chat) {
    let dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let branch = git_branch(&dir);
    let width = term_width();
    if c.color {
        print!("\x1b]0;⚡ Pulso CLI\x07");
    }
    print!(
        "{}",
        header_banner(
            env!("CARGO_PKG_VERSION"),
            &c.settings.provider,
            c.settings.model.as_deref(),
            c.settings.effort.as_deref(),
            c.settings.edit,
            &dir,
            home_dir().as_deref(),
            branch.as_deref(),
            width,
            c.color,
        )
    );
    let _ = std::io::stdout().flush();
}

enum PromptEvent {
    Submit(String),
    ClearScreen,
    Exit,
}

fn char_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices().nth(char_idx).map(|(b, _)| b).unwrap_or(s.len())
}

fn draw_composer(
    chat: &Chat,
    buf: &str,
    cursor_chars: usize,
    menu_sel: usize,
    ctrl_c_armed: bool,
    drawn: &mut bool,
) {
    let mut out = std::io::stdout();
    let width = term_width();
    let color = chat.color;

    if *drawn {
        // El cursor descansa siempre en la fila 2 (línea del prompt).
        let _ = write!(out, "\x1b[?25l\x1b[2A\r\x1b[0J");
    } else {
        let _ = write!(out, "\x1b[?25l\n");
    }

    // Fila 0: telemetría alineada a la derecha (como Claude Code / Codex).
    let effort_lbl = chat.settings.effort.as_deref().unwrap_or("normal");
    let p_lbl = provider_label(&chat.settings.provider);
    let p_col = provider_color(&chat.settings.provider);
    let model_part = chat.settings.model.as_deref().map(|m| format!("{m} · ")).unwrap_or_default();
    let meta_plain = format!("◐ {model_part}{effort_lbl} · /effort  ·  ✦ {p_lbl} · /provider");
    let meta_styled = format!(
        "{} {}  {}  {} {}",
        paint(color, DIM, &format!("◐ {model_part}{effort_lbl}")),
        paint(color, RULE, "· /effort"),
        paint(color, RULE, "·"),
        paint(color, p_col, &format!("✦ {p_lbl}")),
        paint(color, RULE, "· /provider"),
    );
    let pad0 = width.saturating_sub(meta_plain.chars().count());
    let _ = writeln!(out, "{}{}", " ".repeat(pad0), meta_styled);

    // Fila 1: separador superior.
    let _ = writeln!(out, "{}", rule(width, color));

    // Fila 2: caja de entrada con ventana deslizante horizontal (nunca desborda de línea).
    let prompt_col = if chat.settings.edit { AMBER } else { CYAN };
    let prompt_sym = paint(color, &format!("1;{prompt_col}"), "❯");
    let max_vis = width.saturating_sub(4).max(16);
    let chars: Vec<char> = buf.chars().collect();
    let (visible_text, cursor_col) = if chars.is_empty() {
        let ph = tr("Escribe una instrucción o \"/\" para comandos…");
        let clipped: String = ph.chars().take(max_vis).collect();
        (paint(color, DIM, &clipped), 2usize)
    } else {
        let start = cursor_chars.saturating_sub(max_vis.saturating_sub(2));
        let end = (start + max_vis).min(chars.len());
        let slice: String = chars[start..end].iter().collect();
        let col = 2 + (cursor_chars - start);
        (paint(color, BRIGHT, &slice), col)
    };
    let _ = writeln!(out, "{prompt_sym} {visible_text}");

    // Fila 3: separador inferior.
    let _ = writeln!(out, "{}", rule(width, color));

    // Fila 4: barra de modo y atajos.
    let (mode_plain, mode_styled) = if chat.settings.edit {
        (
            tr("  ▸▸ edición activa (Shift+Tab solo lectura)"),
            format!("  {} {}", paint(color, AMBER, tr("▸▸ edición activa")), paint(color, DIM, tr("(Shift+Tab solo lectura)"))),
        )
    } else {
        (
            "  ▸▸ solo lectura (Shift+Tab editar)",
            format!("  {} {}", paint(color, CYAN, "▸▸ solo lectura"), paint(color, DIM, "(Shift+Tab editar)")),
        )
    };
    let (right_plain, right_styled) = if ctrl_c_armed {
        (tr("Pulsa Ctrl+C de nuevo para salir"), paint(color, AMBER, tr("Pulsa Ctrl+C de nuevo para salir")))
    } else {
        (tr("/help · /model · Ctrl+C salir"), paint(color, DIM, tr("/help · /model · Ctrl+C salir")))
    };
    let gap = width.saturating_sub(mode_plain.chars().count() + right_plain.chars().count());
    let _ = write!(out, "{mode_styled}{}{right_styled}", if gap > 1 { " ".repeat(gap) } else { "  ".into() });

    // Filas 5..: menú desplegable de comandos `/` si aplica.
    let matches = slash_matches(buf);
    let shown_menu = matches.len().min(6);
    for (idx, cmd) in matches.iter().take(shown_menu).enumerate() {
        let selected = idx == menu_sel.min(shown_menu.saturating_sub(1));
        let _ = write!(out, "\n");
        let text = format!("  {:<11} {}", cmd.name, tr(cmd.desc));
        let clipped: String = text.chars().take(width.saturating_sub(2)).collect();
        if selected {
            let pad = width.saturating_sub(clipped.chars().count() + 2);
            let _ = write!(
                out,
                "{}",
                paint(color, &format!("{BG_SEL};{CYAN}"), &format!("▸ {clipped}{}", " ".repeat(pad)))
            );
        } else {
            let _ = write!(
                out,
                "  {} {}",
                paint(color, SLATE, &format!("{:<11}", cmd.name)),
                paint(color, DIM, tr(cmd.desc))
            );
        }
    }

    // Volver el cursor a la fila 2 (línea de entrada), columna `cursor_col`.
    let lines_below_input = 2 + shown_menu;
    let _ = write!(out, "\x1b[{lines_below_input}A\r\x1b[{cursor_col}C\x1b[?25h");
    let _ = out.flush();
    *drawn = true;
}

fn clear_composer(drawn: &mut bool) {
    if *drawn {
        let mut out = std::io::stdout();
        let _ = write!(out, "\x1b[2A\r\x1b[0J\x1b[?25h");
        let _ = out.flush();
        *drawn = false;
    }
}

fn read_composer(chat: &mut Chat, history: &[String]) -> PromptEvent {
    let Some(raw) = RawConsole::enter() else {
        // Modo no interactivo (pipe/redirección).
        print!("\n{} ", paint(chat.color, &format!("1;{CYAN}"), "❯"));
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
            return PromptEvent::Exit;
        }
        if line.contains('\x03') || line.contains('\x04') {
            return PromptEvent::Exit;
        }
        return PromptEvent::Submit(line.trim().to_string());
    };

    let mut buf = String::new();
    let mut cursor: usize = 0; // índice en chars
    let mut hist_idx: Option<usize> = None;
    let mut saved_draft = String::new();
    let mut menu_sel: usize = 0;
    let mut ctrl_c_armed = false;
    let mut drawn = false;

    loop {
        let matches = slash_matches(&buf);
        if !matches.is_empty() && menu_sel >= matches.len().min(6) {
            menu_sel = 0;
        }
        draw_composer(chat, &buf, cursor, menu_sel, ctrl_c_armed, &mut drawn);

        match raw.read_key() {
            Key::CtrlC => {
                if !buf.is_empty() {
                    buf.clear();
                    cursor = 0;
                    menu_sel = 0;
                    ctrl_c_armed = true;
                } else {
                    clear_composer(&mut drawn);
                    return PromptEvent::Exit;
                }
            }
            Key::CtrlD => {
                if buf.is_empty() {
                    clear_composer(&mut drawn);
                    return PromptEvent::Exit;
                }
            }
            Key::CtrlL => {
                clear_composer(&mut drawn);
                return PromptEvent::ClearScreen;
            }
            Key::CtrlU => {
                buf.clear();
                cursor = 0;
                ctrl_c_armed = false;
            }
            Key::CtrlW => {
                if cursor > 0 {
                    let chars: Vec<char> = buf.chars().collect();
                    let mut i = cursor;
                    while i > 0 && chars[i - 1].is_whitespace() {
                        i -= 1;
                    }
                    while i > 0 && !chars[i - 1].is_whitespace() {
                        i -= 1;
                    }
                    let a = char_to_byte(&buf, i);
                    let b = char_to_byte(&buf, cursor);
                    buf.replace_range(a..b, "");
                    cursor = i;
                }
                ctrl_c_armed = false;
            }
            Key::ShiftTab => {
                chat.settings.edit = !chat.settings.edit;
                ctrl_c_armed = false;
            }
            Key::Tab => {
                if !matches.is_empty() {
                    let cmd = matches[menu_sel.min(matches.len().min(6) - 1)];
                    buf = if cmd.needs_arg { format!("{} ", cmd.name) } else { cmd.name.to_string() };
                    cursor = buf.chars().count();
                    menu_sel = 0;
                }
                ctrl_c_armed = false;
            }
            Key::Esc => {
                if !buf.is_empty() {
                    buf.clear();
                    cursor = 0;
                    menu_sel = 0;
                }
                ctrl_c_armed = false;
            }
            Key::Enter => {
                if !matches.is_empty() {
                    let cmd = matches[menu_sel.min(matches.len().min(6) - 1)];
                    if cmd.needs_arg && buf.trim() != cmd.name {
                        buf = format!("{} ", cmd.name);
                        cursor = buf.chars().count();
                        menu_sel = 0;
                        continue;
                    }
                    if !cmd.needs_arg {
                        buf = cmd.name.to_string();
                    }
                }
                let submitted = buf.trim().to_string();
                if submitted.is_empty() {
                    ctrl_c_armed = false;
                    continue;
                }
                clear_composer(&mut drawn);
                return PromptEvent::Submit(submitted);
            }
            Key::Backspace => {
                if cursor > 0 {
                    let a = char_to_byte(&buf, cursor - 1);
                    let b = char_to_byte(&buf, cursor);
                    buf.replace_range(a..b, "");
                    cursor -= 1;
                }
                ctrl_c_armed = false;
            }
            Key::Delete => {
                let len = buf.chars().count();
                if cursor < len {
                    let a = char_to_byte(&buf, cursor);
                    let b = char_to_byte(&buf, cursor + 1);
                    buf.replace_range(a..b, "");
                }
                ctrl_c_armed = false;
            }
            Key::Left => {
                cursor = cursor.saturating_sub(1);
                ctrl_c_armed = false;
            }
            Key::Right => {
                let len = buf.chars().count();
                if cursor < len {
                    cursor += 1;
                }
                ctrl_c_armed = false;
            }
            Key::Home => {
                cursor = 0;
                ctrl_c_armed = false;
            }
            Key::End => {
                cursor = buf.chars().count();
                ctrl_c_armed = false;
            }
            Key::Up => {
                ctrl_c_armed = false;
                if !matches.is_empty() {
                    let max = matches.len().min(6);
                    menu_sel = if menu_sel == 0 { max - 1 } else { menu_sel - 1 };
                } else if !history.is_empty() {
                    let next = match hist_idx {
                        None => {
                            saved_draft = buf.clone();
                            history.len() - 1
                        }
                        Some(0) => 0,
                        Some(i) => i - 1,
                    };
                    hist_idx = Some(next);
                    buf = history[next].clone();
                    cursor = buf.chars().count();
                }
            }
            Key::Down => {
                ctrl_c_armed = false;
                if !matches.is_empty() {
                    let max = matches.len().min(6);
                    menu_sel = (menu_sel + 1) % max;
                } else if let Some(i) = hist_idx {
                    if i + 1 < history.len() {
                        hist_idx = Some(i + 1);
                        buf = history[i + 1].clone();
                    } else {
                        hist_idx = None;
                        buf = std::mem::take(&mut saved_draft);
                    }
                    cursor = buf.chars().count();
                }
            }
            Key::Char(ch) => {
                let b = char_to_byte(&buf, cursor);
                buf.insert(b, ch);
                cursor += 1;
                menu_sel = 0;
                ctrl_c_armed = false;
            }
            Key::None => {}
        }
    }
}

fn repl(settings: Settings) {
    let color = use_color();
    let mut chat = Chat { settings, session: None, color };
    if color {
        print!("\x1b[2J\x1b[H");
    }
    print_header(&chat);
    let mut history: Vec<String> = Vec::new();

    loop {
        let line = match read_composer(&mut chat, &history) {
            PromptEvent::Exit => {
                println!("\n  {} {}\n", paint(color, CYAN, "◈"), paint(color, DIM, tr("Sesión de Pulso CLI cerrada.")));
                break;
            }
            PromptEvent::ClearScreen => {
                if color {
                    print!("\x1b[2J\x1b[H");
                }
                print_header(&chat);
                continue;
            }
            PromptEvent::Submit(s) => s,
        };

        if line.is_empty() {
            continue;
        }
        if history.last().map(|s| s.as_str()) != Some(line.as_str()) {
            history.push(line.clone());
        }

        if let Some(cmd) = line.strip_prefix('/') {
            let (name, arg) = cmd.split_once(' ').map(|(a, b)| (a, b.trim())).unwrap_or((cmd, ""));
            let note = |icon: &str, tone: &str, m: &str| {
                println!("  {} {}", paint(color, tone, icon), paint(color, SLATE, m));
            };
            match name {
                "exit" | "quit" | "salir" => {
                    println!("  {} {}\n", paint(color, CYAN, "◈"), paint(color, DIM, tr("Sesión de Pulso CLI cerrada.")));
                    break;
                }
                "clear" | "limpiar" => {
                    if color {
                        print!("\x1b[2J\x1b[H");
                    }
                    print_header(&chat);
                }
                "help" | "ayuda" => {
                    println!();
                    for l in tr(HELP).lines() {
                        println!("  {}", paint(color, SLATE, l));
                    }
                }
                "new" | "nuevo" => {
                    chat.session = None;
                    note("✦", CYAN, tr("Conversación nueva iniciada."));
                }
                "edit" => {
                    chat.settings.edit = true;
                    note("⚡", AMBER, tr("Modo edición activado para esta carpeta."));
                }
                "read" => {
                    chat.settings.edit = false;
                    note("●", CYAN, "Modo solo lectura activado.");
                }
                "model" => {
                    chat.settings.model = (!arg.is_empty()).then(|| arg.to_string());
                    note("◈", CYAN, &format!("Modelo: {}", if arg.is_empty() { "predeterminado" } else { arg }));
                }
                "effort" => {
                    chat.settings.effort = (!arg.is_empty()).then(|| arg.to_string());
                    note("◐", CYAN, &format!("Esfuerzo: {}", if arg.is_empty() { "normal" } else { arg }));
                }
                "provider" => match normalize_provider(arg) {
                    Some(p) => {
                        chat.settings.provider = p.into();
                        chat.settings.model = None;
                        chat.session = None;
                        note("✦", provider_color(p), &trf("Proveedor cambiado a {provider} (conversación nueva).", &[("provider", &provider_label(p))]));
                    }
                    None => note("▸", AMBER, "Usa: /provider claude | codex | antigravity"),
                },
                _ => note("✗", ROSE, "Comando desconocido. Escribe / o /help."),
            }
            continue;
        }

        let bar_col = if chat.settings.edit { AMBER } else { CYAN };
        println!("\n  {} {} {}", paint(color, bar_col, "┃"), paint(color, &format!("1;{bar_col}"), "❯"), paint(color, BRIGHT, &line));
        chat.turn(&line);
    }
}

// ---------- Consola interactiva de bajo nivel (Windows Win32 + fallback) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Char(char),
    Enter,
    Backspace,
    Delete,
    Tab,
    ShiftTab,
    Esc,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    CtrlC,
    CtrlD,
    CtrlL,
    CtrlU,
    CtrlW,
    None,
}

#[cfg(windows)]
mod console {
    use super::Key;
    use std::ffi::c_void;
    use std::io::IsTerminal;

    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6;
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5;
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4;

    const ENABLE_PROCESSED_INPUT: u32 = 0x0001;
    const ENABLE_LINE_INPUT: u32 = 0x0002;
    const ENABLE_ECHO_INPUT: u32 = 0x0004;
    const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;

    const KEY_EVENT: u16 = 0x0001;
    const RIGHT_ALT_PRESSED: u32 = 0x0001;
    const LEFT_ALT_PRESSED: u32 = 0x0002;
    const RIGHT_CTRL_PRESSED: u32 = 0x0004;
    const LEFT_CTRL_PRESSED: u32 = 0x0008;
    const SHIFT_PRESSED: u32 = 0x0010;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Coord {
        x: i16,
        y: i16,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SmallRect {
        left: i16,
        top: i16,
        right: i16,
        bottom: i16,
    }

    #[repr(C)]
    struct ConsoleScreenBufferInfo {
        dw_size: Coord,
        dw_cursor_position: Coord,
        w_attributes: u16,
        sr_window: SmallRect,
        dw_maximum_window_size: Coord,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyEventRecord {
        b_key_down: i32,
        w_repeat_count: u16,
        w_virtual_key_code: u16,
        w_virtual_scan_code: u16,
        unicode_char: u16,
        dw_control_key_state: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InputRecord {
        event_type: u16,
        _pad: u16,
        key: KeyEventRecord,
    }

    extern "system" {
        fn GetStdHandle(n: u32) -> *mut c_void;
        fn GetConsoleMode(h: *mut c_void, m: *mut u32) -> i32;
        fn SetConsoleMode(h: *mut c_void, m: u32) -> i32;
        fn GetConsoleScreenBufferInfo(h: *mut c_void, info: *mut ConsoleScreenBufferInfo) -> i32;
        fn ReadConsoleInputW(h: *mut c_void, buf: *mut InputRecord, len: u32, read: *mut u32) -> i32;
        fn GetNumberOfConsoleInputEvents(h: *mut c_void, num: *mut u32) -> i32;
    }

    pub fn enable_ansi() {
        for id in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            unsafe {
                let h = GetStdHandle(id);
                let mut m = 0u32;
                if !h.is_null() && GetConsoleMode(h, &mut m) != 0 {
                    SetConsoleMode(h, m | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
                }
            }
        }
    }

    pub fn term_width() -> usize {
        unsafe {
            let h = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut info: ConsoleScreenBufferInfo = std::mem::zeroed();
            if !h.is_null() && GetConsoleScreenBufferInfo(h, &mut info) != 0 {
                let w = (info.sr_window.right - info.sr_window.left + 1) as isize;
                if w >= 40 {
                    return (w as usize).min(180);
                }
            }
        }
        90
    }

    pub struct RawConsole {
        handle: *mut c_void,
        orig_mode: u32,
    }

    impl RawConsole {
        pub fn enter() -> Option<Self> {
            if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
                return None;
            }
            unsafe {
                let handle = GetStdHandle(STD_INPUT_HANDLE);
                if handle.is_null() {
                    return None;
                }
                let mut orig_mode = 0u32;
                if GetConsoleMode(handle, &mut orig_mode) == 0 {
                    return None;
                }
                let raw = orig_mode & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT);
                if SetConsoleMode(handle, raw) == 0 {
                    return None;
                }
                Some(Self { handle, orig_mode })
            }
        }

        pub fn read_key(&self) -> Key {
            let mut rec: InputRecord = unsafe { std::mem::zeroed() };
            let mut read = 0u32;
            loop {
                let ok = unsafe { ReadConsoleInputW(self.handle, &mut rec, 1, &mut read) };
                if ok == 0 || read == 0 {
                    return Key::None;
                }
                if rec.event_type != KEY_EVENT || rec.key.b_key_down == 0 {
                    continue;
                }
                let k = decode_key(rec.key);
                if k != Key::None {
                    return k;
                }
            }
        }

        pub fn poll_ctrl_c(&self) -> bool {
            let mut count = 0u32;
            unsafe {
                if GetNumberOfConsoleInputEvents(self.handle, &mut count) == 0 || count == 0 {
                    return false;
                }
            }
            let mut rec: InputRecord = unsafe { std::mem::zeroed() };
            let mut read = 0u32;
            for _ in 0..count {
                let ok = unsafe { ReadConsoleInputW(self.handle, &mut rec, 1, &mut read) };
                if ok == 0 || read == 0 {
                    break;
                }
                if rec.event_type == KEY_EVENT && rec.key.b_key_down != 0 && decode_key(rec.key) == Key::CtrlC {
                    return true;
                }
            }
            false
        }
    }

    impl Drop for RawConsole {
        fn drop(&mut self) {
            unsafe {
                SetConsoleMode(self.handle, self.orig_mode);
            }
        }
    }

    fn decode_key(k: KeyEventRecord) -> Key {
        let ctrl = (k.dw_control_key_state & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED)) != 0;
        let alt = (k.dw_control_key_state & (LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED)) != 0;
        let shift = (k.dw_control_key_state & SHIFT_PRESSED) != 0;
        let vk = k.w_virtual_key_code;
        let u = k.unicode_char;

        if ctrl && !alt {
            match vk {
                0x43 => return Key::CtrlC, // C
                0x44 => return Key::CtrlD, // D
                0x4C => return Key::CtrlL, // L
                0x55 => return Key::CtrlU, // U
                0x57 => return Key::CtrlW, // W
                _ => {}
            }
            if u == 3 {
                return Key::CtrlC;
            }
            if u == 4 {
                return Key::CtrlD;
            }
        }

        match vk {
            0x0D => return Key::Enter,
            0x08 => return Key::Backspace,
            0x2E => return Key::Delete,
            0x09 => return if shift { Key::ShiftTab } else { Key::Tab },
            0x1B => return Key::Esc,
            0x25 => return Key::Left,
            0x27 => return Key::Right,
            0x26 => return Key::Up,
            0x28 => return Key::Down,
            0x24 => return Key::Home,
            0x23 => return Key::End,
            _ => {}
        }

        if u >= 0x20 {
            if let Some(ch) = char::from_u32(u as u32) {
                return Key::Char(ch);
            }
        }
        Key::None
    }
}

#[cfg(not(windows))]
mod console {
    use super::Key;
    use std::io::Read;

    pub fn enable_ansi() {}

    pub fn term_width() -> usize {
        unsafe {
            let mut ws: libc::winsize = std::mem::zeroed();
            if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
                return ws.ws_col as usize;
            }
        }
        90
    }

    pub fn decode_unix_seq(bytes: &[u8]) -> Key {
        match bytes {
            [0x03] => Key::CtrlC,
            [0x04] => Key::CtrlD,
            [0x0c] => Key::CtrlL,
            [0x15] => Key::CtrlU,
            [0x17] => Key::CtrlW,
            [b'\r'] | [b'\n'] => Key::Enter,
            [0x7f] | [0x08] => Key::Backspace,
            [b'\t'] => Key::Tab,
            [0x1b] => Key::Esc,
            [0x1b, b'[', b'Z'] => Key::ShiftTab,
            [0x1b, b'[', b'A'] => Key::Up,
            [0x1b, b'[', b'B'] => Key::Down,
            [0x1b, b'[', b'C'] => Key::Right,
            [0x1b, b'[', b'D'] => Key::Left,
            [0x1b, b'[', b'H'] | [0x1b, b'O', b'H'] => Key::Home,
            [0x1b, b'[', b'F'] | [0x1b, b'O', b'F'] => Key::End,
            [0x1b, b'[', b'3', b'~'] => Key::Delete,
            _ => {
                if let Ok(s) = std::str::from_utf8(bytes) {
                    if let Some(ch) = s.chars().next() {
                        if !ch.is_control() {
                            return Key::Char(ch);
                        }
                    }
                }
                Key::None
            }
        }
    }

    pub struct RawConsole {
        orig: libc::termios,
    }

    impl RawConsole {
        pub fn enter() -> Option<Self> {
            unsafe {
                if libc::isatty(libc::STDIN_FILENO) == 0 {
                    return None;
                }
                let mut orig: libc::termios = std::mem::zeroed();
                if libc::tcgetattr(libc::STDIN_FILENO, &mut orig) != 0 {
                    return None;
                }
                let mut raw = orig;
                raw.c_lflag &= !(libc::ICANON | libc::ECHO | libc::ISIG | libc::IEXTEN);
                raw.c_iflag &= !(libc::IXON | libc::ICRNL);
                raw.c_cc[libc::VMIN] = 1;
                raw.c_cc[libc::VTIME] = 0;
                if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) != 0 {
                    return None;
                }
                Some(Self { orig })
            }
        }

        fn read_byte_timeout(ms: i32) -> Option<u8> {
            unsafe {
                let mut pfd = libc::pollfd {
                    fd: libc::STDIN_FILENO,
                    events: libc::POLLIN,
                    revents: 0,
                };
                if libc::poll(&mut pfd, 1, ms) > 0 && (pfd.revents & libc::POLLIN) != 0 {
                    let mut b = [0u8; 1];
                    if std::io::stdin().read(&mut b).ok()? == 1 {
                        return Some(b[0]);
                    }
                }
            }
            None
        }

        pub fn read_key(&self) -> Key {
            let mut b = [0u8; 1];
            if std::io::stdin().read(&mut b).ok().unwrap_or(0) == 0 {
                return Key::CtrlD;
            }
            let first = b[0];
            if first == 0x1b {
                let mut seq = vec![0x1b];
                if let Some(b2) = Self::read_byte_timeout(20) {
                    seq.push(b2);
                    if b2 == b'[' || b2 == b'O' {
                        if let Some(b3) = Self::read_byte_timeout(20) {
                            seq.push(b3);
                            if b3.is_ascii_digit() {
                                if let Some(b4) = Self::read_byte_timeout(20) {
                                    seq.push(b4);
                                }
                            }
                        }
                    }
                }
                return decode_unix_seq(&seq);
            }
            // Caracteres UTF-8 multibyte.
            let expected = if first & 0x80 == 0 {
                1
            } else if first & 0xE0 == 0xC0 {
                2
            } else if first & 0xF0 == 0xE0 {
                3
            } else if first & 0xF8 == 0xF0 {
                4
            } else {
                1
            };
            let mut buf = vec![first];
            for _ in 1..expected {
                if let Some(next) = Self::read_byte_timeout(20) {
                    buf.push(next);
                }
            }
            decode_unix_seq(&buf)
        }

        pub fn poll_ctrl_c(&self) -> bool {
            while let Some(b) = Self::read_byte_timeout(0) {
                if b == 0x03 {
                    return true;
                }
            }
            false
        }
    }

    impl Drop for RawConsole {
        fn drop(&mut self) {
            unsafe {
                let _ = libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.orig);
            }
        }
    }
}

use console::{enable_ansi, term_width, RawConsole};

#[cfg(all(test, not(windows)))]
mod unix_cli_tests {
    use super::{console::decode_unix_seq, Key};

    #[test]
    fn decodifica_atajos_y_flechas_ansi_en_unix() {
        assert_eq!(decode_unix_seq(&[0x03]), Key::CtrlC);
        assert_eq!(decode_unix_seq(&[0x04]), Key::CtrlD);
        assert_eq!(decode_unix_seq(&[b'\r']), Key::Enter);
        assert_eq!(decode_unix_seq(&[0x7f]), Key::Backspace);
        assert_eq!(decode_unix_seq(b"\x1b[Z"), Key::ShiftTab);
        assert_eq!(decode_unix_seq(b"\x1b[A"), Key::Up);
        assert_eq!(decode_unix_seq(b"\x1b[B"), Key::Down);
        assert_eq!(decode_unix_seq(b"\x1b[3~"), Key::Delete);
        assert_eq!(decode_unix_seq("ñ".as_bytes()), Key::Char('ñ'));
    }
}
