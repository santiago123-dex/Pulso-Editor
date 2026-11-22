//! Lectura de la configuración de terminal que el usuario ya tiene (VS Code, Windows Terminal)
//! y de las fuentes instaladas, para que la terminal de Pulso se adapte a cada persona.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
#[cfg(not(windows))]
use std::process::Command;

#[derive(Serialize, Debug, PartialEq)]
pub struct ConfigFile {
    pub kind: String,
    pub path: String,
    pub text: String,
}

fn read_small(p: &Path) -> Option<String> {
    let m = fs::metadata(p).ok()?;
    if !m.is_file() || m.len() > 1_000_000 {
        return None;
    }
    fs::read_to_string(p).ok().map(|t| t.trim_start_matches('\u{feff}').to_string())
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Archivos de configuración que pueden existir, en orden de preferencia.
fn candidates() -> Vec<(&'static str, PathBuf)> {
    let mut v: Vec<(&'static str, PathBuf)> = Vec::new();
    if let Some(app) = env_path("APPDATA") {
        for dir in ["Code", "Code - Insiders", "VSCodium", "Cursor"] {
            v.push(("vscode", app.join(dir).join("User").join("settings.json")));
        }
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        for pkg in ["Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"] {
            v.push(("wt", local.join("Packages").join(pkg).join("LocalState").join("settings.json")));
        }
        v.push(("wt", local.join("Microsoft").join("Windows Terminal").join("settings.json")));
    }
    if let Some(home) = env_path("HOME") {
        v.push(("vscode", home.join(".config").join("Code").join("User").join("settings.json")));
        v.push(("vscode", home.join("Library").join("Application Support").join("Code").join("User").join("settings.json")));
    }
    v
}

pub fn find_configs(candidates: &[(&'static str, PathBuf)]) -> Vec<ConfigFile> {
    let mut out: Vec<ConfigFile> = Vec::new();
    for (kind, path) in candidates {
        // Solo la primera de cada tipo: es la que el usuario usa de verdad.
        if out.iter().any(|c| c.kind == *kind) {
            continue;
        }
        if let Some(text) = read_small(path) {
            out.push(ConfigFile { kind: kind.to_string(), path: path.to_string_lossy().replace('\\', "/"), text });
        }
    }
    out
}

/// Configuración de VS Code y de Windows Terminal, si existen.
#[tauri::command]
pub async fn terminal_config_files() -> Vec<ConfigFile> {
    tauri::async_runtime::spawn_blocking(|| find_configs(&candidates()))
        .await
        .unwrap_or_default()
}

// ---------- Fuentes instaladas ----------
const STYLE_WORDS: [&str; 20] = [
    "Regular", "Bold", "Italic", "Oblique", "Light", "SemiLight", "ExtraLight", "SemiBold", "ExtraBold", "Medium",
    "Thin", "Black", "Heavy", "Retina", "Book", "Demi", "DemiBold", "UltraLight", "Condensed", "Roman",
];

/// "CaskaydiaCove Nerd Font Mono SemiBold Italic" -> "CaskaydiaCove Nerd Font Mono".
pub fn family_of(name: &str) -> String {
    let mut words: Vec<&str> = name.split_whitespace().collect();
    while words.len() > 1 && STYLE_WORDS.contains(words.last().unwrap()) {
        words.pop();
    }
    words.join(" ")
}

/// Interpreta la salida de `reg query ...\Fonts`: "    Nombre (TrueType)    REG_SZ    archivo.ttf".
pub fn parse_reg_fonts(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(idx) = line.find("REG_") else { continue };
        let name = line[..idx].trim();
        // Varias fuentes pueden venir juntas: "A Bold & A Bold Italic (TrueType)".
        let name = name.rsplit_once(" (").map(|(n, _)| n).unwrap_or(name);
        for part in name.split(" & ") {
            let fam = family_of(part.trim());
            if !fam.is_empty() && seen.insert(fam.clone()) {
                out.push(fam);
            }
        }
    }
    out
}

fn query_fonts() -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        for key in [
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
            r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts",
        ] {
            if let Ok(out) = crate::background_command("reg").args(["query", key]).output() {
                for f in parse_reg_fonts(&String::from_utf8_lossy(&out.stdout)) {
                    if seen.insert(f.clone()) {
                        all.push(f);
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(out) = Command::new("fc-list").arg(":").arg("family").output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                for fam in line.split(',') {
                    let fam = fam.trim().to_string();
                    if !fam.is_empty() && seen.insert(fam.clone()) {
                        all.push(fam);
                    }
                }
            }
        }
    }
    all.sort_by_key(|f| f.to_lowercase());
    all
}

/// Familias de fuentes instaladas en el sistema.
#[tauri::command]
pub async fn installed_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(query_fonts).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_strips_style_words_only_at_the_end() {
        assert_eq!(family_of("CaskaydiaCove Nerd Font Mono SemiBold Italic"), "CaskaydiaCove Nerd Font Mono");
        assert_eq!(family_of("Segoe UI Bold"), "Segoe UI");
        assert_eq!(family_of("Arial Black"), "Arial", "Black se trata como un peso");
        assert_eq!(family_of("Roboto Mono Light"), "Roboto Mono");
        assert_eq!(family_of("Consolas"), "Consolas");
        assert_eq!(family_of("Bold"), "Bold", "un nombre de una sola palabra se respeta");
    }

    #[test]
    fn reg_output_is_parsed_into_unique_families() {
        let text = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\r\n\
            \x20   Cascadia Code (TrueType)    REG_SZ    CascadiaCode.ttf\r\n\
            \x20   Cascadia Code Bold (TrueType)    REG_SZ    CascadiaCodeBold.ttf\r\n\
            \x20   CaskaydiaCove Nerd Font Mono Regular (TrueType)    REG_SZ    CaskaydiaCoveNFM.ttf\r\n\
            \x20   Segoe UI Bold & Segoe UI Bold Italic (TrueType)    REG_SZ    segoeuib.ttf\r\n\
            \x20   Consolas (TrueType)    REG_SZ    consola.ttf\r\n";
        let fonts = parse_reg_fonts(text);
        assert_eq!(fonts, vec!["Cascadia Code", "CaskaydiaCove Nerd Font Mono", "Segoe UI", "Consolas"]);
    }

    #[test]
    fn reg_output_without_entries_is_empty() {
        assert!(parse_reg_fonts("").is_empty());
        assert!(parse_reg_fonts("ERROR: no se encuentra la clave").is_empty());
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pulso-userconf-{}-{}", std::process::id(), name));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_the_first_existing_file_of_each_kind() {
        let d = tmp("find");
        fs::write(d.join("a.json"), "{\"a\":1}").unwrap();
        fs::write(d.join("b.json"), "{\"b\":2}").unwrap();
        fs::write(d.join("wt.json"), "\u{feff}{\"w\":3}").unwrap();
        let cands = vec![
            ("vscode", d.join("no-existe.json")),
            ("vscode", d.join("a.json")),
            ("vscode", d.join("b.json")),
            ("wt", d.join("wt.json")),
        ];
        let found = find_configs(&cands);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].kind, "vscode");
        assert_eq!(found[0].text, "{\"a\":1}");
        assert_eq!(found[1].kind, "wt");
        assert_eq!(found[1].text, "{\"w\":3}", "se quita la marca BOM");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn ignores_missing_huge_and_non_files() {
        let d = tmp("skip");
        fs::write(d.join("grande.json"), vec![b'x'; 1_100_000]).unwrap();
        fs::create_dir_all(d.join("carpeta.json")).unwrap();
        let found = find_configs(&[("vscode", d.join("grande.json")), ("vscode", d.join("carpeta.json")), ("wt", d.join("nada.json"))]);
        assert!(found.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn this_machine_reports_fonts() {
        let fonts = query_fonts();
        assert!(!fonts.is_empty(), "Windows siempre tiene fuentes instaladas");
        assert!(fonts.iter().any(|f| f == "Consolas" || f == "Segoe UI"), "debe incluir fuentes del sistema");
        let mut sorted = fonts.clone();
        sorted.sort_by_key(|f| f.to_lowercase());
        assert_eq!(fonts, sorted, "ordenadas sin distinguir mayúsculas");
    }
}
