//! Parte visual y de seguridad de `pulso` en la terminal: qué carpetas se aceptan, en cuáles ya se confió,
//! y cómo se ve la respuesta (markdown sencillo, recuadros). Todo puro y probado; sin entrada ni salida.
use crate::i18n::{tr};
use std::path::Path;

// Paleta oficial de Pulso (grafito neutro + púrpura de marca #7c3aed/#a78bfa + acento azul #5b9cf5).
pub const ACCENT: &str = "38;2;167;139;250";
pub const CYAN: &str = "38;2;91;156;245";
pub const INDIGO: &str = "38;2;124;58;237";
pub const VIOLET: &str = "38;2;167;139;250";
pub const LAVENDER: &str = "38;2;196;181;253";
pub const SHADOW: &str = "38;2;76;29;149";
pub const MINT: &str = "38;2;52;211;153";
pub const AMBER: &str = "38;2;233;188;67";
pub const CORAL: &str = "38;2;249;115;22";
pub const ROSE: &str = "38;2;244;63;94";
pub const BRIGHT: &str = "1;38;2;244;244;245";
pub const SLATE: &str = "38;2;212;212;216";
pub const DIM: &str = "38;2;138;138;146";
pub const RULE: &str = "38;2;58;58;66";
pub const BG_SEL: &str = "48;2;43;29;74";
pub const BG_CODE: &str = "48;2;20;20;27";
pub const BG_INLINE: &str = "48;2;32;32;42";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCmd {
    pub name: &'static str,
    pub desc: &'static str,
    pub needs_arg: bool,
}

pub const SLASH_COMMANDS: &[SlashCmd] = &[
    SlashCmd { name: "/provider", desc: "Elegir o cambiar IA (claude | codex | antigravity)", needs_arg: false },
    SlashCmd { name: "/model", desc: "Elegir modelo del proveedor activo", needs_arg: false },
    SlashCmd { name: "/effort", desc: "Nivel de razonamiento (low | medium | high | max)", needs_arg: false },
    SlashCmd { name: "/plan", desc: "Planificar una tarea en solo lectura sin tocar archivos", needs_arg: true },
    SlashCmd { name: "/steps", desc: "Desplegar los pasos del último turno de la IA", needs_arg: false },
    SlashCmd { name: "/status", desc: "Ver estado actual de la sesión y proyecto", needs_arg: false },
    SlashCmd { name: "/edit", desc: "Activar edición de archivos en esta carpeta", needs_arg: false },
    SlashCmd { name: "/read", desc: "Volver a modo solo lectura", needs_arg: false },
    SlashCmd { name: "/doctor", desc: "Comprobar proveedores instalados y entorno", needs_arg: false },
    SlashCmd { name: "/new", desc: "Iniciar una conversación nueva", needs_arg: false },
    SlashCmd { name: "/clear", desc: "Limpiar la pantalla", needs_arg: false },
    SlashCmd { name: "/help", desc: "Mostrar ayuda y atajos", needs_arg: false },
    SlashCmd { name: "/exit", desc: "Salir de Pulso CLI", needs_arg: false },
];

/// Filtra comandos `/` que coinciden con el prefijo escrito en el compositor.
pub fn slash_matches(input: &str) -> Vec<&'static SlashCmd> {
    let t = input.trim_start();
    if !t.starts_with('/') || t.contains(' ') {
        return Vec::new();
    }
    let q = t.to_ascii_lowercase();
    SLASH_COMMANDS.iter().filter(|c| c.name.starts_with(&q)).collect()
}

/// Acorta la carpeta personal a `~` para mostrar rutas limpias en la cabecera.
pub fn short_path(dir: &Path, home: Option<&Path>) -> String {
    let raw = dir.display().to_string();
    let Some(h) = home else { return raw };
    let d_norm = norm_path(dir);
    let h_norm = norm_path(h);
    if d_norm == h_norm {
        return "~".into();
    }
    let prefix = format!("{}/", h_norm.trim_end_matches('/'));
    if d_norm.starts_with(&prefix) {
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let stripped_raw = raw.strip_prefix(r"\\?\").or_else(|| raw.strip_prefix("//?/")).unwrap_or(&raw);
        let h_count = h_norm.trim_end_matches('/').split('/').filter(|s| !s.is_empty()).count();
        let tail: Vec<&str> = stripped_raw
            .split(['/', '\\'])
            .filter(|s| !s.is_empty())
            .skip(h_count)
            .collect();
        if tail.is_empty() {
            return "~".into();
        }
        return format!("~{sep}{}", tail.join(&sep.to_string()));
    }
    raw
}

/// Lee la rama Git actual recorriendo `.git/HEAD` sin lanzar subprocesos.
pub fn git_branch(dir: &Path) -> Option<String> {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        let dot_git = d.join(".git");
        let head_path = if dot_git.is_dir() {
            Some(dot_git.join("HEAD"))
        } else if dot_git.is_file() {
            let txt = std::fs::read_to_string(&dot_git).ok()?;
            let rel = txt.trim().strip_prefix("gitdir:")?.trim();
            let p = Path::new(rel);
            Some(if p.is_absolute() { p.join("HEAD") } else { d.join(p).join("HEAD") })
        } else {
            None
        };
        if let Some(hp) = head_path {
            if let Ok(head) = std::fs::read_to_string(hp) {
                let head = head.trim();
                if let Some(r) = head.strip_prefix("ref: refs/heads/") {
                    return Some(r.to_string());
                }
                if head.chars().count() >= 7 {
                    return Some(head.chars().take(7).collect());
                }
            }
            return None;
        }
        cur = d.parent();
    }
    None
}

pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "codex" => "Codex",
        "antigravity" => "Antigravity",
        _ => "Claude",
    }
}

pub fn provider_color(provider: &str) -> &'static str {
    match provider {
        "codex" => MINT,
        "antigravity" => VIOLET,
        _ => CORAL,
    }
}

pub fn rule(width: usize, color: bool) -> String {
    paint(color, RULE, &"─".repeat(width.max(20)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    Read,
    Edit,
    Command,
    Search,
    Other,
}

/// Filtra eventos internos ruidosos y traduce nombres técnicos de herramientas a acciones legibles.
pub fn describe_tool(raw: &str) -> Option<(ActivityKind, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (name, rest) = trimmed.split_once(' ').map(|(a, b)| (a, b.trim())).unwrap_or((trimmed, ""));
    let low = name.to_ascii_lowercase();
    if matches!(
        low.as_str(),
        "system_message" | "manage_task" | "update_focus" | "update_steps" | "planner_response" | "thought" | "thinking"
    ) {
        return None;
    }
    let short_arg = if rest.is_empty() {
        String::new()
    } else if rest.contains('/') || rest.contains('\\') {
        let parts: Vec<&str> = rest.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
        if parts.len() > 2 {
            format!("…/{}", parts[parts.len() - 2..].join("/"))
        } else {
            rest.to_string()
        }
    } else {
        clip_text(rest, 48)
    };
    let (kind, verb) = if low.starts_with("read") || low.starts_with("view") || low.starts_with("list") {
        (ActivityKind::Read, "Leyendo")
    } else if low.starts_with("edit") || low.starts_with("write") || low.starts_with("replace") || low.starts_with("multi") {
        (ActivityKind::Edit, "Editando")
    } else if low.starts_with("run_command") || low.starts_with("command") || low.starts_with("bash") || low.starts_with("exec") {
        (ActivityKind::Command, "Ejecutando comando")
    } else if low.starts_with("grep") || low.starts_with("glob") || low.starts_with("search") || low.starts_with("find") {
        (ActivityKind::Search, "Buscando")
    } else if low.starts_with("web") {
        (ActivityKind::Search, "Consultando web")
    } else {
        (ActivityKind::Other, name)
    };
    let label = if short_arg.is_empty() {
        verb.to_string()
    } else if kind == ActivityKind::Command {
        format!("Ejecutando `{short_arg}`")
    } else {
        format!("{verb} {short_arg}")
    };
    Some((kind, label))
}

/// Construye el resumen compacto al estilo Pulso Editor: «Trabajó 18.4 s · 4 lecturas · 2 comandos».
pub fn format_activity_summary(
    secs: f32,
    reads: usize,
    edits: usize,
    commands: usize,
    searches: usize,
    other: usize,
) -> String {
    let mut parts = vec![format!("Trabajó {secs:.1} s")];
    if reads > 0 {
        parts.push(format!("{reads} {}", if reads == 1 { "lectura" } else { "lecturas" }));
    }
    if edits > 0 {
        parts.push(format!("{edits} {}", if edits == 1 { "edición" } else { "ediciones" }));
    }
    if commands > 0 {
        parts.push(format!("{commands} {}", if commands == 1 { "comando" } else { "comandos" }));
    }
    if searches > 0 {
        parts.push(format!("{searches} {}", if searches == 1 { "búsqueda" } else { "búsquedas" }));
    }
    if other > 0 {
        parts.push(format!("{other} {}", if other == 1 { "acción" } else { "acciones" }));
    }
    parts.join(" · ")
}

/// Formatea una acción de herramienta como línea de timeline con icono semántico (1 columna).
pub fn tool_badge(tool: &str, color: bool) -> String {
    let lower = tool.to_ascii_lowercase();
    let (icon, tone) = if lower.starts_with("read") || lower.starts_with("view") || lower.starts_with("glob") || lower.starts_with("grep") || lower.starts_with("list") || lower.starts_with("leyendo") || lower.starts_with("buscando") {
        ("◈", CYAN)
    } else if lower.starts_with("edit") || lower.starts_with("write") || lower.starts_with("replace") || lower.starts_with("editando") {
        ("✦", AMBER)
    } else if lower.starts_with("command") || lower.starts_with("bash") || lower.starts_with("run") || lower.starts_with("ejecutando") {
        ("◆", VIOLET)
    } else {
        ("▸", SLATE)
    };
    format!("  {} {} {}", paint(color, RULE, "├─"), paint(color, tone, icon), paint(color, SLATE, tool))
}

/// Ancho visual aproximado en columnas de consola (trata emojis y CJK como 2 columnas, pero símbolos geométricos como ✦ en 1).
pub fn char_width(c: char) -> usize {
    let cp = c as u32;
    if matches!(cp, 0x26A0..=0x26A1 | 0x1F300..=0x1FAFF | 0x2E80..=0x9FFF | 0xF900..=0xFAFF | 0xFF01..=0xFF60) {
        2
    } else {
        1
    }
}

pub fn display_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

pub fn clip_text(text: &str, max_cols: usize) -> String {
    if max_cols == 0 {
        return String::new();
    }
    if display_width(text) <= max_cols {
        return text.to_string();
    }
    if max_cols == 1 {
        return "…".into();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for c in text.chars() {
        let cw = char_width(c);
        if used + cw + 1 > max_cols {
            break;
        }
        out.push(c);
        used += cw;
    }
    out.push('…');
    out
}

/// Colorea una línea de pixel-art 3D: bloques `█` en el color principal y trazos de sombra en púrpura oscuro.
fn color_pixel_row(line: &str, main_color: &str, color: bool) -> String {
    if !color {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() * 2);
    let mut cur: Option<&str> = None;
    for c in line.chars() {
        let tone = match c {
            '█' | '▀' | '▄' => Some(main_color),
            '╗' | '╔' | '═' | '║' | '╝' | '╚' => Some(SHADOW),
            _ => None,
        };
        if tone != cur {
            if cur.is_some() {
                out.push_str("\x1b[0m");
            }
            if let Some(t) = tone {
                out.push_str(&format!("\x1b[{t}m"));
            }
            cur = tone;
        }
        out.push(c);
    }
    if cur.is_some() {
        out.push_str("\x1b[0m");
    }
    out
}

/// Cabecera oficial de Pulso CLI: pixel-art 3D `PULSO` + tarjeta compacta y responsiva al ancho de la terminal.
#[allow(clippy::too_many_arguments)]
pub fn header_banner(
    version: &str,
    provider: &str,
    model: Option<&str>,
    effort: Option<&str>,
    edit: bool,
    dir: &Path,
    home: Option<&Path>,
    branch: Option<&str>,
    width: usize,
    color: bool,
) -> String {
    let w = width.saturating_sub(1).max(32);
    let p_label = provider_label(provider);
    let p_col = provider_color(provider);
    let model_txt = model.unwrap_or("predeterminado");
    let effort_txt = effort.unwrap_or("normal");
    let path_txt = short_path(dir, home);

    // Modo compacto para terminales estrechas (< 64 cols) para que nunca se rompa el diseño.
    if w < 64 {
        let mode_short = if edit { paint(color, AMBER, "◆ edit") } else { paint(color, CYAN, "● read") };
        let path_clip = clip_text(&path_txt, w.saturating_sub(4));
        let top = format!(
            "  {} {} · {} · {}",
            paint(color, &format!("1;{VIOLET}"), "◈ PULSO"),
            paint(color, DIM, &format!("v{version}")),
            paint(color, p_col, p_label),
            mode_short,
        );
        let sub = format!("  {}", paint(color, DIM, &path_clip));
        return format!("\n{top}\n{sub}\n");
    }

    // Wordmark pixel-art 3D `PULSO` con degradado vertical púrpura → lavanda → azul Pulso + sombra 3D.
    let art: [(&str, &str); 6] = [
        ("██████╗ ██╗   ██╗██╗     ███████╗ ██████╗ ", INDIGO),
        ("██╔══██╗██║   ██║██║     ██╔════╝██╔═══██╗", VIOLET),
        ("██████╔╝██║   ██║██║     ███████╗██║   ██║", VIOLET),
        ("██╔═══╝ ██║   ██║██║     ╚════██║██║   ██║", LAVENDER),
        ("██║     ╚██████╔╝███████╗███████║╚██████╔╝", CYAN),
        ("╚═╝      ╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ", CYAN),
    ];
    let mut logo_lines = String::new();
    for (idx, (row, tone)) in art.iter().enumerate() {
        let colored = color_pixel_row(row, tone, color);
        if idx == 2 && w >= 66 {
            logo_lines.push_str(&format!(
                "  {colored}  {} {} {}\n",
                paint(color, VIOLET, "──╱╲──"),
                paint(color, BRIGHT, "CLI"),
                paint(color, DIM, &format!("v{version}")),
            ));
        } else if idx == 3 && w >= 66 {
            logo_lines.push_str(&format!(
                "  {colored}  {}\n",
                paint(color, DIM, "Pulso Terminal Agent"),
            ));
        } else {
            logo_lines.push_str(&format!("  {colored}\n"));
        }
    }

    // Tarjeta de sesión con ancho controlado (máx. 84 cols, siempre cabe en la ventana).
    let card_w = w.saturating_sub(4).min(84);
    let inner = card_w.saturating_sub(4);
    let val_max = inner.saturating_sub(12);

    let prov_plain = format!("✦ {p_label} · {model_txt} · {effort_txt}");
    let prov_clip = clip_text(&prov_plain, val_max);
    let prov_styled = if prov_clip == prov_plain {
        format!(
            "{} {} {} {} {}",
            paint(color, &format!("1;{p_col}"), &format!("✦ {p_label}")),
            paint(color, RULE, "·"),
            paint(color, SLATE, model_txt),
            paint(color, RULE, "·"),
            paint(color, DIM, effort_txt),
        )
    } else {
        paint(color, p_col, &prov_clip)
    };

    let proj_plain = match branch {
        Some(b) => format!("{path_txt} · git:{b}"),
        None => path_txt.clone(),
    };
    let proj_clip = clip_text(&proj_plain, val_max);
    let proj_styled = if proj_clip == proj_plain {
        match branch {
            Some(b) => format!(
                "{} {} {}",
                paint(color, SLATE, &path_txt),
                paint(color, RULE, "·"),
                paint(color, VIOLET, &format!("git:{b}")),
            ),
            None => paint(color, SLATE, &path_txt),
        }
    } else {
        paint(color, SLATE, &proj_clip)
    };

    let (mode_plain, mode_styled) = if edit {
        let p = "◆ edición activa  (Shift+Tab solo lectura)";
        let c = clip_text(p, val_max);
        let s = if c == p {
            format!("{}  {}", paint(color, AMBER, "◆ edición activa"), paint(color, DIM, "(Shift+Tab solo lectura)"))
        } else {
            paint(color, AMBER, &c)
        };
        (c, s)
    } else {
        let p = "● solo lectura  (Shift+Tab editar)";
        let c = clip_text(p, val_max);
        let s = if c == p {
            format!("{}  {}", paint(color, CYAN, "● solo lectura"), paint(color, DIM, "(Shift+Tab editar)"))
        } else {
            paint(color, CYAN, &c)
        };
        (c, s)
    };

    let make_row = |label: &str, plain_val: &str, styled_val: &str| -> String {
        let lbl_pad = format!("{label:<11} ");
        let used = 12 + display_width(plain_val);
        let pad = inner.saturating_sub(used);
        format!(
            "  {} {}{}{} {}",
            paint(color, RULE, "│"),
            paint(color, DIM, &lbl_pad),
            styled_val,
            " ".repeat(pad),
            paint(color, RULE, "│"),
        )
    };

    let title_tag = " Sesión ";
    let top_fill = card_w.saturating_sub(3 + display_width(title_tag));
    let top_border = format!(
        "  {}{}{}{}",
        paint(color, RULE, "╭─"),
        paint(color, LAVENDER, title_tag),
        paint(color, RULE, &"─".repeat(top_fill)),
        paint(color, RULE, "╮"),
    );
    let bot_border = format!(
        "  {}{}{}",
        paint(color, RULE, "╰"),
        paint(color, RULE, &"─".repeat(card_w.saturating_sub(2))),
        paint(color, RULE, "╯"),
    );

    let r1 = make_row("Proveedor", &prov_clip, &prov_styled);
    let r2 = make_row("Proyecto", &proj_clip, &proj_styled);
    let r3 = make_row("Modo", &mode_plain, &mode_styled);

    format!("\n{logo_lines}\n{top_border}\n{r1}\n{r2}\n{r3}\n{bot_border}\n")
}

/// Tarjeta de confirmación de carpeta de proyecto.
pub fn trust_card(dir: &Path, home: Option<&Path>, color: bool) -> String {
    let shown = short_path(dir, home);
    boxed(&[
        (tr("◈ Pulso CLI · Seguridad del espacio de trabajo").into(), paint(color, &format!("1;{CYAN}"), tr("◈ Pulso CLI · Seguridad del espacio de trabajo"))),
        (String::new(), String::new()),
        (format!("Carpeta: {shown}"), format!("{} {}", paint(color, DIM, "Carpeta:"), paint(color, BRIGHT, &shown))),
        (tr("La IA podrá leer archivos aquí y modificarlos solo si activas /edit o Shift+Tab.").into(), paint(color, SLATE, tr("La IA podrá leer archivos aquí y modificarlos solo si activas /edit o Shift+Tab."))),
    ], color)
}

// ---------- Carpetas: límites y confianza ----------

fn norm_path(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('\\', "/");
    if let Some(r) = s.strip_prefix("//?/") {
        s = r.to_string();
    }
    while s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.pop();
    }
    s.to_lowercase()
}

/// ¿Es una carpeta demasiado amplia para dársela a una IA? Devuelve el motivo.
pub fn broad_dir_reason(dir: &Path, home: Option<&Path>) -> Option<&'static str> {
    let d = norm_path(dir);
    let is_root = d == "/" || (d.len() == 3 && d.ends_with(":/")) || (d.len() == 2 && d.ends_with(':'));
    if is_root {
        return Some(tr("es la raíz de una unidad"));
    }
    if let Some(h) = home {
        let h = norm_path(h);
        if d == h {
            return Some(tr("es tu carpeta personal"));
        }
        for sub in ["desktop", "documents", "downloads", "escritorio", "documentos", "descargas"] {
            if d == format!("{h}/{sub}") {
                return Some(tr("mezcla todos tus proyectos y archivos"));
            }
        }
    }
    let on_drive = d.len() > 3 && d.as_bytes().get(1) == Some(&b':') && d.as_bytes().get(2) == Some(&b'/');
    let rest = if on_drive { &d[3..] } else { d.trim_start_matches('/') };
    let first = rest.split('/').next().unwrap_or("");
    let top_level = if on_drive { !rest.contains('/') } else { d.starts_with('/') && !rest.contains('/') };
    if top_level && ["windows", "program files", "program files (x86)", "programdata", "users", "etc", "usr", "bin", "sbin", "var", "system", "library", "applications"].contains(&rest) {
        return Some(tr("es una carpeta del sistema"));
    }
    if (d.starts_with('/') && ["etc", "usr", "bin", "sbin", "system"].contains(&first))
        || (on_drive && (rest == "windows/system32" || rest.starts_with("windows/system32/") || rest == "windows/syswow64" || rest.starts_with("windows/syswow64/")))
    {
        return Some(tr("es una carpeta del sistema"));
    }
    None
}

/// Carpetas en las que la persona ya confió (JSON: lista de rutas).
pub fn trusted_list(text: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(text).unwrap_or_default()
}

/// Confiar en una carpeta incluye a sus subcarpetas.
pub fn is_trusted(list: &[String], dir: &Path) -> bool {
    let d = norm_path(dir);
    list.iter().any(|t| {
        let t = norm_path(Path::new(t));
        d == t || d.starts_with(&format!("{}/", t.trim_end_matches('/')))
    })
}

pub fn add_trusted(text: &str, dir: &Path) -> String {
    let mut l = trusted_list(text);
    if !is_trusted(&l, dir) {
        l.push(dir.to_string_lossy().replace('\\', "/"));
    }
    serde_json::to_string_pretty(&l).unwrap_or_else(|_| "[]".into())
}

// ---------- Presentación ----------

pub fn paint(on: bool, code: &str, text: &str) -> String {
    if on { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_string() }
}

/// Estiliza `**negrita**`, `` `código` `` (píldora oscura) y `[enlaces](url)` (hipervínculo OSC 8 clickeable).
fn inline(line: &str, color: bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        // Enlaces Markdown `[etiqueta](url)`.
        if chars[i] == '[' {
            if let Some(close_br) = chars[i + 1..].iter().position(|c| *c == ']') {
                let after_br = i + 1 + close_br + 1;
                if chars.get(after_br) == Some(&'(') {
                    if let Some(close_par) = chars[after_br + 1..].iter().position(|c| *c == ')') {
                        let label: String = chars[i + 1..i + 1 + close_br].iter().collect();
                        let url: String = chars[after_br + 1..after_br + 1 + close_par].iter().collect();
                        if !label.is_empty() && !url.is_empty() {
                            if color {
                                out.push_str(&format!(
                                    "\x1b]8;;{url}\x1b\\\x1b[4;{CYAN}m{label}\x1b[0m\x1b]8;;\x1b\\"
                                ));
                            } else {
                                out.push_str(&label);
                            }
                            i = after_br + 1 + close_par + 1;
                            continue;
                        }
                    }
                }
            }
        }
        // Código en línea `` `code` ``.
        if chars[i] == '`' {
            if let Some(end) = chars[i + 1..].iter().position(|c| *c == '`') {
                let code: String = chars[i + 1..i + 1 + end].iter().collect();
                if color {
                    out.push_str(&paint(true, &format!("{BG_INLINE};{LAVENDER}"), &format!(" {code} ")));
                } else {
                    out.push_str(&code);
                }
                i += end + 2;
                continue;
            }
        }
        // Negrita `**texto**` (también soporta `` `código` `` dentro).
        if chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            let rest: String = chars[i + 2..].iter().collect();
            if let Some(end) = rest.find("**") {
                if end > 0 {
                    let bold = &rest[..end];
                    if bold.contains('`') {
                        let mut bi = 0;
                        let bchars: Vec<char> = bold.chars().collect();
                        while bi < bchars.len() {
                            if bchars[bi] == '`' {
                                if let Some(bend) = bchars[bi + 1..].iter().position(|c| *c == '`') {
                                    let code: String = bchars[bi + 1..bi + 1 + bend].iter().collect();
                                    if color {
                                        out.push_str(&paint(true, &format!("{BG_INLINE};{LAVENDER}"), &format!(" {code} ")));
                                    } else {
                                        out.push_str(&code);
                                    }
                                    bi += bend + 2;
                                    continue;
                                }
                            }
                            let start = bi;
                            while bi < bchars.len() && bchars[bi] != '`' {
                                bi += 1;
                            }
                            let seg: String = bchars[start..bi].iter().collect();
                            out.push_str(&paint(color, BRIGHT, &seg));
                        }
                    } else {
                        out.push_str(&paint(color, BRIGHT, bold));
                    }
                    i += 2 + bold.chars().count() + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Longitud visual aproximada de una cadena Markdown antes de aplicar estilos (enlaces `[a](url)` cuentan solo `a`).
fn markdown_visible_len(s: &str) -> usize {
    let chars: Vec<char> = s.chars().collect();
    let mut len = 0usize;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(cb) = chars[i + 1..].iter().position(|c| *c == ']') {
                let ab = i + 1 + cb + 1;
                if chars.get(ab) == Some(&'(') {
                    if let Some(cp) = chars[ab + 1..].iter().position(|c| *c == ')') {
                        len += cb;
                        i = ab + 1 + cp + 1;
                        continue;
                    }
                }
            }
        }
        if chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            continue;
        }
        if chars[i] == '`' {
            len += 1; // margen de píldora
            i += 1;
            continue;
        }
        len += char_width(chars[i]);
        i += 1;
    }
    len
}

/// Divide un texto por palabras respetando un ancho máximo visible sin cortar palabras a la mitad.
fn wrap_words(text: &str, max_width: usize) -> Vec<String> {
    let max_w = max_width.max(24);
    if markdown_visible_len(text) <= max_w {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut cur_w = 0usize;
    for word in text.split_whitespace() {
        let ww = markdown_visible_len(word);
        if cur.is_empty() {
            cur.push_str(word);
            cur_w = ww;
        } else if cur_w + 1 + ww <= max_w {
            cur.push(' ');
            cur.push_str(word);
            cur_w += 1 + ww;
        } else {
            lines.push(std::mem::take(&mut cur));
            cur.push_str(word);
            cur_w = ww;
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

/// Versión con ajuste limpio por palabras para respuestas largas en terminal (evita cortar palabras y píldoras).
pub fn render_lines_wrapped(line: &str, in_code: &mut bool, max_width: usize, color: bool) -> Vec<String> {
    let t = line.trim_end();
    if *in_code || t.trim_start().starts_with("```") {
        return vec![render_line(t, in_code, color)];
    }
    let trimmed = t.trim_start();
    if trimmed.is_empty() {
        return vec![String::new()];
    }
    let indent = &t[..t.len() - trimmed.len()];
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        return vec![render_line(t, in_code, color)];
    }
    if color && (trimmed == "---" || trimmed == "***" || trimmed == "___") {
        return vec![render_line(t, in_code, color)];
    }

    let col_max = max_width.clamp(32, 96);
    if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
        let prefix_w = indent.chars().count() + 2;
        let wrapped = wrap_words(rest, col_max.saturating_sub(prefix_w));
        let cont = " ".repeat(prefix_w);
        return wrapped
            .into_iter()
            .enumerate()
            .map(|(i, seg)| {
                if i == 0 {
                    format!("{indent}{} {}", paint(color, VIOLET, "•"), inline(&seg, color))
                } else {
                    format!("{cont}{}", inline(&seg, color))
                }
            })
            .collect();
    }
    if let Some(rest) = trimmed.strip_prefix("> ") {
        let wrapped = wrap_words(rest, col_max.saturating_sub(2));
        return wrapped
            .into_iter()
            .map(|seg| format!("{} {}", paint(color, INDIGO, "▎"), paint(color, &format!("3;{SLATE}"), &inline(&seg, false))))
            .collect();
    }
    // Listas numeradas (`1. texto`).
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && trimmed[digits..].starts_with(". ") {
        let num_prefix = &trimmed[..digits + 2];
        let rest = &trimmed[digits + 2..];
        let prefix_w = indent.chars().count() + num_prefix.chars().count();
        let wrapped = wrap_words(rest, col_max.saturating_sub(prefix_w));
        let cont = " ".repeat(prefix_w);
        return wrapped
            .into_iter()
            .enumerate()
            .map(|(i, seg)| {
                if i == 0 {
                    format!("{indent}{}{}", paint(color, LAVENDER, num_prefix), inline(&seg, color))
                } else {
                    format!("{cont}{}", inline(&seg, color))
                }
            })
            .collect();
    }

    let prefix_w = indent.chars().count();
    let wrapped = wrap_words(trimmed, col_max.saturating_sub(prefix_w));
    wrapped
        .into_iter()
        .map(|seg| format!("{indent}{}", inline(&seg, color)))
        .collect()
}

fn is_keyword(w: &str) -> bool {
    matches!(
        w,
        "fn" | "pub" | "let" | "mut" | "const" | "struct" | "enum" | "impl" | "trait" | "match"
            | "if" | "else" | "for" | "while" | "loop" | "return" | "use" | "mod" | "async"
            | "await" | "import" | "export" | "from" | "function" | "class" | "interface" | "type"
            | "def" | "try" | "catch" | "throw" | "new" | "true" | "false" | "null" | "None"
            | "Some" | "Ok" | "Err" | "self" | "Self" | "this" | "var" | "in" | "of" | "as"
            | "where" | "static" | "ref" | "move" | "break" | "continue" | "default" | "case"
            | "switch" | "extends" | "implements" | "private" | "public" | "readonly" | "void"
    )
}

/// Resaltado de sintaxis ligero estilo OpenCode para bloques de código en la terminal.
fn highlight_code_line(line: &str) -> String {
    let trimmed = line.trim_start();
    // Líneas de diff (+ / - / @@).
    if trimmed.starts_with("@@") && trimmed.contains("@@") {
        return format!("\x1b[{BG_CODE};{VIOLET}m{line}\x1b[0m");
    }
    if line.starts_with('+') && !line.starts_with("+++") {
        return format!("\x1b[{BG_CODE};{MINT}m{line}\x1b[0m");
    }
    if line.starts_with('-') && !line.starts_with("---") {
        return format!("\x1b[{BG_CODE};{ROSE}m{line}\x1b[0m");
    }
    // Comentarios de línea completa (`//` o `#` sin `#!`/`#[`).
    if trimmed.starts_with("//") || (trimmed.starts_with('#') && !trimmed.starts_with("#[") && !trimmed.starts_with("#!")) {
        return format!("\x1b[{BG_CODE};3;{DIM}m{line}\x1b[0m");
    }

    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len() * 2);
    out.push_str(&format!("\x1b[{BG_CODE};{SLATE}m"));
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Comentario al final de la línea (`//`).
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            let rest: String = chars[i..].iter().collect();
            out.push_str(&format!("\x1b[{BG_CODE};3;{DIM}m{rest}"));
            break;
        }
        // Cadenas (`"..."`, `'...'`, `` `...` ``).
        if matches!(c, '"' | '\'' | '`') {
            let quote = c;
            let start = i;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 2;
                    continue;
                }
                if chars[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            let s: String = chars[start..i].iter().collect();
            out.push_str(&format!("\x1b[{BG_CODE};{MINT}m{s}\x1b[{BG_CODE};{SLATE}m"));
            continue;
        }
        // Números.
        if c.is_ascii_digit() && (i == 0 || !chars[i - 1].is_alphanumeric() && chars[i - 1] != '_') {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '.' | '_')) {
                i += 1;
            }
            let num: String = chars[start..i].iter().collect();
            out.push_str(&format!("\x1b[{BG_CODE};{AMBER}m{num}\x1b[{BG_CODE};{SLATE}m"));
            continue;
        }
        // Identificadores: palabras clave, tipos (PascalCase) o macros (`foo!`).
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let is_macro = chars.get(i) == Some(&'!');
            if is_macro {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let next_is_call = chars.get(i) == Some(&'(');
            if is_keyword(&word) {
                out.push_str(&format!("\x1b[{BG_CODE};{LAVENDER}m{word}\x1b[{BG_CODE};{SLATE}m"));
            } else if is_macro || next_is_call || word.chars().next().is_some_and(|ch| ch.is_ascii_uppercase()) {
                out.push_str(&format!("\x1b[{BG_CODE};{CYAN}m{word}\x1b[{BG_CODE};{SLATE}m"));
            } else {
                out.push_str(&word);
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out.push_str("\x1b[0m");
    out
}

/// Da formato a una línea de la respuesta (markdown estilo OpenCode). `in_code` recuerda si va dentro de un bloque de código.
pub fn render_line(line: &str, in_code: &mut bool, color: bool) -> String {
    let t = line.trim_end();
    if let Some(lang) = t.trim_start().strip_prefix("```") {
        *in_code = !*in_code;
        let lang = lang.trim();
        if !color {
            return if *in_code { format!("╭─ {lang}").trim_end().to_string() } else { "╰─".to_string() };
        }
        if *in_code {
            let tag = if lang.is_empty() { "code" } else { lang };
            let bar = "─".repeat(48usize.saturating_sub(tag.chars().count()));
            return format!(
                "{} {} {}",
                paint(true, INDIGO, "╭─"),
                paint(true, &format!("1;{LAVENDER}"), tag),
                paint(true, RULE, &bar),
            );
        } else {
            return format!(
                "{}{}",
                paint(true, INDIGO, "╰"),
                paint(true, RULE, &"─".repeat(51)),
            );
        }
    }
    if *in_code {
        if !color {
            return format!("│ {t}");
        }
        let bar = paint(true, INDIGO, "▎");
        let highlighted = highlight_code_line(t);
        return format!("{bar}\x1b[{BG_CODE}m \x1b[0m{highlighted}\x1b[{BG_CODE}m \x1b[0m");
    }
    let trimmed = t.trim_start();
    let indent = &t[..t.len() - trimmed.len()];
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        let heading = trimmed[hashes..].trim();
        if !color {
            return heading.to_string();
        }
        return match hashes {
            1 => format!("{} {}", paint(true, VIOLET, "◈"), paint(true, BRIGHT, heading)),
            2 => paint(true, &format!("1;{LAVENDER}"), heading),
            _ => paint(true, &format!("1;{CYAN}"), heading),
        };
    }
    if let Some(r) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
        return format!("{indent}{} {}", paint(color, VIOLET, "•"), inline(r, color));
    }
    if let Some(r) = trimmed.strip_prefix("> ") {
        return format!("{} {}", paint(color, INDIGO, "▎"), paint(color, &format!("3;{SLATE}"), &inline(r, false)));
    }
    // Separadores horizontales (`---`, `***`).
    if color && (trimmed == "---" || trimmed == "***" || trimmed == "___") {
        return paint(true, RULE, &"─".repeat(48));
    }
    inline(t, color)
}

/// Recuadro redondeado alrededor de unas líneas `(texto sin colores, texto con colores)`; el ancho se mide sobre el primero.
pub fn boxed(lines: &[(String, String)], color: bool) -> String {
    let width = lines.iter().map(|(plain, _)| plain.chars().count()).max().unwrap_or(0);
    let bar = "─".repeat(width + 2);
    let side = paint(color, ACCENT, "│");
    let mut out = format!("{}\n", paint(color, ACCENT, &format!("╭{bar}╮")));
    for (plain, styled) in lines {
        let pad = " ".repeat(width - plain.chars().count());
        out.push_str(&format!("{side} {styled}{pad} {side}\n"));
    }
    out.push_str(&paint(color, ACCENT, &format!("╰{bar}╯")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carpetas_demasiado_amplias() {
        let home = Path::new("C:/Users/ana");
        for p in ["C:/", "C:\\", "C:/Users/ana", "C:/Users/ana/Documents", "C:/Windows", "C:/Windows/System32", "C:/Program Files", "/", "/etc", "/etc/ssh"] {
            assert!(broad_dir_reason(Path::new(p), Some(home)).is_some(), "{p}");
        }
        for p in ["C:/Users/ana/proyectos/web", "C:/Users/ana/Documents/Pulso Editor", "D:/trabajo", "/home/ana/app", "C:/Windows/Temp/x"] {
            assert!(broad_dir_reason(Path::new(p), Some(home)).is_none(), "{p}");
        }
    }

    #[test]
    fn la_confianza_cubre_subcarpetas_y_no_hermanas() {
        let json = add_trusted("", Path::new("C:\\Dev\\App"));
        let l = trusted_list(&json);
        assert!(is_trusted(&l, Path::new("c:/dev/app")));
        assert!(is_trusted(&l, Path::new("C:/Dev/App/src/x")));
        assert!(!is_trusted(&l, Path::new("C:/Dev/App2")));
        assert!(!is_trusted(&l, Path::new("C:/Dev")));
        assert_eq!(trusted_list(&add_trusted(&json, Path::new("C:/Dev/App/sub"))).len(), 1);
        assert!(trusted_list("no es json").is_empty());
    }

    #[test]
    fn da_formato_al_markdown_sin_colores() {
        let mut code = false;
        assert_eq!(render_line("# Título", &mut code, false), "Título");
        assert_eq!(render_line("- uno **dos** `tres`", &mut code, false), "• uno dos tres");
        assert_eq!(render_line("```rust", &mut code, false), "╭─ rust");
        assert_eq!(render_line("let x = **1**;", &mut code, false), "│ let x = **1**;");
        assert_eq!(render_line("```", &mut code, false), "╰─");
        assert!(!code);
        assert_eq!(render_line("2 * 3 * 4 y ** sueltos", &mut code, false), "2 * 3 * 4 y ** sueltos");
        assert!(render_line("`a`", &mut code, true).contains("\x1b["));
        assert_eq!(render_line("Ver [aiChat.ts](file:///C:/src/aiChat.ts) y **versión `0.2.0`**", &mut code, false), "Ver aiChat.ts y versión 0.2.0");
        let wrapped = render_lines_wrapped("- Uno dos tres cuatro cinco seis siete ocho nueve diez", &mut code, 34, false);
        assert!(wrapped.len() >= 2);
        assert!(wrapped[0].starts_with("• "));
        assert!(wrapped[1].starts_with("  "));
    }

    #[test]
    fn el_recuadro_alinea_los_lados() {
        let b = boxed(&[("ab".into(), "ab".into()), ("abcd".into(), "abcd".into())], false);
        let widths: Vec<usize> = b.lines().map(|l| l.chars().count()).collect();
        assert!(widths.iter().all(|w| *w == widths[0]), "{widths:?}");
    }

    #[test]
    fn acorta_rutas_dentro_de_home() {
        let home = Path::new("C:\\Users\\ASUS");
        let proj = Path::new("C:\\Users\\ASUS\\Documents\\pulso");
        assert!(short_path(proj, Some(home)).starts_with('~'));
        assert!(short_path(proj, Some(home)).ends_with("pulso"));
        assert_eq!(short_path(home, Some(home)), "~");
        assert_eq!(short_path(Path::new("D:\\repo"), Some(home)), "D:\\repo");
        // Caracteres Unicode cuyo case-folding cambia la longitud en bytes (p. ej. 'İ') no deben producir pánico.
        let uni_home = Path::new("/home/İsmail");
        let uni_proj = Path::new("/home/İsmail/proyectos/pulso");
        assert!(short_path(uni_proj, Some(uni_home)).ends_with("pulso"));
    }

    #[test]
    fn filtra_comandos_slash() {
        assert_eq!(slash_matches("/").len(), SLASH_COMMANDS.len());
        let p = slash_matches("/pr");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].name, "/provider");
        assert!(slash_matches("/provider codex").is_empty());
        assert!(slash_matches("hola").is_empty());
    }

    #[test]
    fn cabecera_y_herramientas_se_renderizan_sin_panico() {
        let h = header_banner("0.1.0", "antigravity", Some("gemini-4-hydrogen-high"), Some("high"), true, Path::new("C:\\Users\\ASUS\\Documents\\pulso"), Some(Path::new("C:\\Users\\ASUS")), Some("main"), 80, false);
        assert!(h.contains("CLI v0.1.0"));
        assert!(h.contains("Antigravity"));
        assert!(h.contains("edición activa"));
        assert!(h.contains("git:main"));
        // Modo compacto en terminal estrecha: ninguna línea excede el ancho.
        let narrow = header_banner("0.1.0", "claude", None, None, false, Path::new("C:\\Users\\ASUS\\Documents\\Pulso Editor"), Some(Path::new("C:\\Users\\ASUS")), Some("feat/pulso-cli"), 48, false);
        assert!(narrow.contains("PULSO"));
        assert!(narrow.lines().all(|l| l.chars().count() <= 48));
        assert!(tool_badge("Read src/main.ts", false).contains("Read src/main.ts"));
        assert!(trust_card(Path::new("C:\\Users\\ASUS\\Documents\\pulso"), Some(Path::new("C:\\Users\\ASUS")), false).contains("Pulso CLI"));
    }
}
