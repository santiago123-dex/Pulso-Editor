//! Línea de comandos de Pulso: `pulso archivo`, `pulso carpeta`, `pulso -g archivo:línea:columna`.
//! El análisis es una función pura (recibe los argumentos y la carpeta actual) para poder probarlo sin abrir la ventana.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTarget {
    pub path: String,
    /// `file`, `dir` o `missing` (la ruta no existe todavía; el editor avisará).
    pub kind: &'static str,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

/// Separa `ruta:línea:columna` sin confundir la `C:` de una unidad de Windows con un número de línea.
fn split_position(arg: &str) -> (&str, Option<u32>, Option<u32>) {
    let mut rest = arg;
    let mut nums: Vec<u32> = Vec::new();
    while nums.len() < 2 {
        let Some(i) = rest.rfind(':') else { break };
        match rest[i + 1..].parse::<u32>() {
            Ok(n) if i > 1 || !rest[..i].chars().all(|c| c.is_ascii_alphabetic()) => {
                nums.push(n);
                rest = &rest[..i];
            }
            _ => break,
        }
    }
    nums.reverse();
    (rest, nums.first().copied(), nums.get(1).copied())
}

fn resolve(raw: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(raw);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    // Se quitan los `.` y `..` sin exigir que exista.
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Interpreta los argumentos (sin el nombre del programa). Ignora las opciones desconocidas.
pub fn parse_args(args: &[String], cwd: &Path) -> Vec<CliTarget> {
    let mut targets = Vec::new();
    let mut goto_next = false;
    let mut only_paths = false;
    for a in args {
        if !only_paths {
            match a.as_str() {
                "--" => {
                    only_paths = true;
                    continue;
                }
                "-g" | "--goto" => {
                    goto_next = true;
                    continue;
                }
                s if s.starts_with('-') && s.len() > 1 => continue,
                _ => {}
            }
        }
        let _ = goto_next;
        goto_next = false;
        let whole = resolve(a, cwd);
        // Una ruta que existe tal cual manda sobre la interpretación `archivo:número`.
        let (path, line, col) = if whole.exists() {
            (whole, None, None)
        } else {
            let (p, l, c) = split_position(a);
            (resolve(p, cwd), l, c)
        };
        let kind = if path.is_dir() {
            "dir"
        } else if path.exists() {
            "file"
        } else {
            "missing"
        };
        targets.push(CliTarget { path: path.to_string_lossy().replace('\\', "/"), kind, line, col });
    }
    targets
}

/// Argumentos de este proceso, para el arranque en frío.
pub fn startup_targets() -> Vec<CliTarget> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    parse_args(&args, &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pulso-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn separa_linea_y_columna_sin_romper_la_unidad() {
        assert_eq!(split_position("a.ts:12:3"), ("a.ts", Some(12), Some(3)));
        assert_eq!(split_position("a.ts:12"), ("a.ts", Some(12), None));
        assert_eq!(split_position("a.ts"), ("a.ts", None, None));
        assert_eq!(split_position(r"C:\x\a.ts:7"), (r"C:\x\a.ts", Some(7), None));
        assert_eq!(split_position("C:5"), ("C:5", None, None));
    }

    #[test]
    fn resuelve_rutas_relativas_y_clasifica() {
        let d = tmp("rel");
        std::fs::write(d.join("a.ts"), "x").unwrap();
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let args: Vec<String> = ["a.ts:4:2", "sub", "nuevo.md", "-n", "--reuse-window", "sub/../a.ts"].map(String::from).to_vec();
        let t = parse_args(&args, &d);
        assert_eq!(t.len(), 4);
        assert_eq!((t[0].kind, t[0].line, t[0].col), ("file", Some(4), Some(2)));
        assert_eq!(t[1].kind, "dir");
        assert_eq!(t[2].kind, "missing");
        assert!(t[3].path.ends_with("/a.ts") && !t[3].path.contains(".."));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_archivo_con_dos_puntos_que_existe_no_se_parte() {
        let d = tmp("colon");
        let t = parse_args(&["a.ts".into(), "-g".into(), "a.ts:9".into(), "--".into(), "-raro".into()], &d);
        assert_eq!(t[0].kind, "missing");
        assert_eq!(t[1].line, Some(9));
        assert_eq!(t[2].path.rsplit('/').next(), Some("-raro"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
