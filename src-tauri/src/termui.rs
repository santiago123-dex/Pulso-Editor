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

/// Formatea una acción de herramienta como línea de timeline con icono semántico.
pub fn tool_badge(tool: &str, color: bool) -> String {
    let lower = tool.to_ascii_lowercase();
    let (icon, tone) = if lower.starts_with("read") || lower.starts_with("view") || lower.starts_with("glob") || lower.starts_with("grep") || lower.starts_with("list") {
        ("◈", CYAN)
    } else if lower.starts_with("edit") || lower.starts_with("write") || lower.starts_with("replace") {
        ("✦", AMBER)
    } else if lower.starts_with("command") || lower.starts_with("bash") || lower.starts_with("run") {
        ("⚡", VIOLET)
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

/// Aplica **negrita** y `código` dentro de una línea de texto.
fn inline(line: &str, color: bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            if let Some(end) = chars[i + 1..].iter().position(|c| *c == '`') {
                let code: String = chars[i + 1..i + 1 + end].iter().collect();
                out.push_str(&paint(color, AMBER, &code));
                i += end + 2;
                continue;
            }
        }
        if chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            let rest: String = chars[i + 2..].iter().collect();
            if let Some(end) = rest.find("**") {
                if end > 0 {
                    let bold = &rest[..end];
                    out.push_str(&paint(color, "1", bold));
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

/// Da formato a una línea de la respuesta (markdown sencillo). `in_code` recuerda si va dentro de un bloque de código.
pub fn render_line(line: &str, in_code: &mut bool, color: bool) -> String {
    let t = line.trim_end();
    if let Some(lang) = t.trim_start().strip_prefix("```") {
        *in_code = !*in_code;
        let text = if *in_code { format!("╭─ {}", lang.trim()).trim_end().to_string() } else { "╰─".to_string() };
        return paint(color, "2", &text);
    }
    if *in_code {
        return format!("{} {}", paint(color, "2", "│"), t);
    }
    let trimmed = t.trim_start();
    let indent = &t[..t.len() - trimmed.len()];
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        return paint(color, &format!("1;{ACCENT}"), trimmed[hashes..].trim());
    }
    if let Some(r) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
        return format!("{indent}{} {}", paint(color, ACCENT, "•"), inline(r, color));
    }
    if let Some(r) = trimmed.strip_prefix("> ") {
        return format!("{} {}", paint(color, "2", "▎"), paint(color, "3", &inline(r, false)));
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
