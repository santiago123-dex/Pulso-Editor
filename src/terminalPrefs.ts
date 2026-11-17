/**
 * Adaptación de la terminal a lo que cada usuario ya tiene: la configuración de VS Code y de
 * Windows Terminal (fuente, tamaño, esquema de colores, shell) y las fuentes instaladas.
 */
import { invoke } from "@tauri-apps/api/core";
import { parseJsonc, terminalTheme, type Theme } from "./themes";

export interface ShellInfo { id: string; label: string; path: string; args: string[] }
export type Scheme = Record<string, string>;

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const COLOR_KEYS = ["background", "foreground", "cursor", "selectionBackground",
  ...ANSI, ...ANSI.map((c) => "bright" + c[0].toUpperCase() + c.slice(1))] as const;

const HEX = /^#[0-9a-f]{6}$/i;

// ---------- Esquemas incluidos (los de Windows Terminal y algunos clásicos) ----------
const S = (bg: string, fg: string, c: string[]): Scheme => {
  const names = [...ANSI, ...ANSI.map((a) => "bright" + a[0].toUpperCase() + a.slice(1))];
  const s: Scheme = { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: fg + "40" };
  names.forEach((n, i) => { s[n] = c[i]; });
  return s;
};

export const BUILTIN_SCHEMES: Record<string, { label: string; colors: Scheme }> = {
  campbell: { label: "Campbell (Windows)", colors: S("#0c0c0c", "#cccccc",
    ["#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc", "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"]) },
  "one-half-dark": { label: "One Half Dark", colors: S("#282c34", "#dcdfe4",
    ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4", "#5a6374", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4"]) },
  "one-half-light": { label: "One Half Light", colors: S("#fafafa", "#383a42",
    ["#383a42", "#e45649", "#50a14f", "#c18301", "#0184bc", "#a626a4", "#0997b3", "#fafafa", "#4f525d", "#df6c75", "#98c379", "#e4c07a", "#61afef", "#c577dd", "#56b5c1", "#ffffff"]) },
  "solarized-dark": { label: "Solarized Dark", colors: S("#002b36", "#839496",
    ["#002b36", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#073642", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]) },
  "tango-dark": { label: "Tango Dark", colors: S("#000000", "#d3d7cf",
    ["#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"]) },
  vintage: { label: "Vintage", colors: S("#000000", "#c0c0c0",
    ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]) },
  "vscode-dark": { label: "VS Code Dark+", colors: S("#1e1e1e", "#cccccc",
    ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"]) },
};

/** Convierte un esquema de Windows Terminal (purple, cursorColor…) a los nombres de xterm. */
export function schemeFromWt(raw: Record<string, unknown>): Scheme | null {
  const get = (k: string) => (typeof raw[k] === "string" && HEX.test(raw[k] as string) ? (raw[k] as string).toLowerCase() : undefined);
  const fallback = BUILTIN_SCHEMES.campbell.colors;
  if (!get("background") && !get("foreground")) return null;
  const out: Scheme = {};
  const alias: Record<string, string> = { magenta: "purple", brightMagenta: "brightPurple", cursor: "cursorColor" };
  for (const k of COLOR_KEYS) out[k] = get(alias[k] ?? k) ?? get(k) ?? fallback[k] ?? fallback.foreground;
  out.cursorAccent = out.background;
  if (!get("selectionBackground")) out.selectionBackground = out.foreground + "40";
  return out;
}

// ---------- Lectura de VS Code ----------
export interface VsPrefs { font?: string; size?: number; cursor?: "block" | "bar" | "underline"; profile?: string }

export function parseVsCodeSettings(text: string): VsPrefs {
  let s: Record<string, unknown>;
  try { s = parseJsonc(text); } catch { return {}; }
  const str = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() ? (s[k] as string).trim() : undefined);
  const num = (k: string) => (typeof s[k] === "number" && (s[k] as number) > 0 ? (s[k] as number) : undefined);
  const cursor = str("terminal.integrated.cursorStyle");
  return {
    // Sin fuente propia para la terminal, VS Code usa la del editor.
    font: str("terminal.integrated.fontFamily") ?? str("editor.fontFamily"),
    size: num("terminal.integrated.fontSize"),
    cursor: cursor === "line" ? "bar" : cursor === "block" || cursor === "underline" ? cursor : undefined,
    profile: str("terminal.integrated.defaultProfile.windows"),
  };
}

// ---------- Lectura de Windows Terminal ----------
export interface WtPrefs { font?: string; size?: number; schemeName?: string; scheme?: Scheme; profile?: string }

export function parseWtSettings(text: string): WtPrefs {
  let s: any;
  try { s = parseJsonc(text); } catch { return {}; }
  const profiles = s?.profiles;
  const list: any[] = Array.isArray(profiles?.list) ? profiles.list : Array.isArray(profiles) ? profiles : [];
  const defaults = (!Array.isArray(profiles) && profiles?.defaults) || {};
  const prof = list.find((p) => p?.guid === s?.defaultProfile) ?? {};
  const pick = <T>(f: (o: any) => T | undefined): T | undefined => f(prof) ?? f(defaults);

  const font = pick<string>((o) => o?.font?.face ?? o?.fontFace);
  const size = pick<number>((o) => o?.font?.size ?? o?.fontSize);
  let name = pick<unknown>((o) => o?.colorScheme);
  if (name && typeof name === "object") name = (name as any).dark ?? (name as any).light;
  const schemeName = typeof name === "string" ? name : "Campbell";

  const custom = Array.isArray(s?.schemes) ? s.schemes.find((x: any) => x?.name?.toLowerCase() === schemeName.toLowerCase()) : undefined;
  let scheme = custom ? schemeFromWt(custom) : null;
  if (!scheme) {
    const id = schemeName.toLowerCase().replace(/\s+/g, "-");
    scheme = (BUILTIN_SCHEMES[id] ?? (id.startsWith("campbell") ? BUILTIN_SCHEMES.campbell : undefined))?.colors ?? null;
  }
  const profile = [prof.source, prof.name, prof.commandline].filter((x) => typeof x === "string").join(" ");
  return {
    font: typeof font === "string" && font.trim() ? font.trim() : undefined,
    size: typeof size === "number" && size > 0 ? size : undefined,
    schemeName,
    scheme: scheme ?? undefined,
    profile: profile || undefined,
  };
}

// ---------- De nombre de perfil a shell instalada ----------
export function shellIdFor(profile: string | undefined, shells: ShellInfo[]): string | undefined {
  if (!profile) return undefined;
  const p = profile.toLowerCase();
  const has = (id: string) => shells.some((s) => s.id === id);
  if (/git/.test(p)) return has("gitbash") ? "gitbash" : undefined;
  if (/wsl|ubuntu|debian|linux/.test(p)) return has("wsl") ? "wsl" : undefined;
  if (/cmd|command prompt|símbolo del sistema/.test(p)) return has("cmd") ? "cmd" : undefined;
  if (/windows powershell/.test(p)) return has("powershell") ? "powershell" : has("pwsh") ? "pwsh" : undefined;
  // "PowerShell" a secas (VS Code) o "PowerShell Core/7" es PowerShell 7 si está instalado.
  if (/pwsh|powershell/.test(p)) return has("pwsh") ? "pwsh" : has("powershell") ? "powershell" : undefined;
  return undefined;
}

// ---------- Detección ----------
export interface Detected {
  vscode?: VsPrefs;
  wt?: WtPrefs;
  fonts: string[];
  nerd: string[];
}

export const isNerdFont = (name: string) => /nerd ?font|\bNFM?\b|\bNFP\b/i.test(name);

export function buildDetected(files: { kind: string; text: string }[], fonts: string[]): Detected {
  const d: Detected = { fonts, nerd: fonts.filter(isNerdFont) };
  const vs = files.find((f) => f.kind === "vscode");
  const wt = files.find((f) => f.kind === "wt");
  if (vs) d.vscode = parseVsCodeSettings(vs.text);
  if (wt) d.wt = parseWtSettings(wt.text);
  return d;
}

let cached: Promise<Detected> | null = null;

/** Lee (una sola vez) lo que el usuario ya tiene configurado en otras terminales. */
export function detectPrefs(): Promise<Detected> {
  if (!cached) {
    cached = (async () => {
      let files: { kind: string; text: string }[] = [];
      let fonts: string[] = [];
      try { files = await invoke("terminal_config_files"); } catch { /* sin archivos */ }
      try { fonts = await invoke("installed_fonts"); } catch { /* sin lista */ }
      return buildDetected(files, fonts);
    })();
  }
  return cached;
}

export const resetDetected = () => { cached = null; };

/** True si hay algo útil que ofrecer al usuario (fuente, esquema propio o shell). */
export function hasAnythingToAdapt(d: Detected, shells: ShellInfo[]): boolean {
  return !!(d.vscode?.font || d.vscode?.size || d.wt?.font || d.wt?.scheme || shellIdFor(d.wt?.profile ?? d.vscode?.profile, shells));
}

// ---------- Esquema de colores a usar ----------
/** "" = igual que el tema del editor; "builtin:<id>"; "wt" = el de Windows Terminal. */
export function resolveScheme(setting: string, det: Detected | null, editorTheme: Theme): Scheme {
  if (setting.startsWith("builtin:")) {
    const b = BUILTIN_SCHEMES[setting.slice(8)];
    if (b) return { ...b.colors };
  }
  if (setting === "wt" && det?.wt?.scheme) return { ...det.wt.scheme };
  return terminalTheme(editorTheme);
}

/** Lista para elegir en Configuración. */
export function schemeOptions(det: Detected | null): { value: string; label: string }[] {
  const opts = [{ value: "", label: "Igual que el tema del editor" }];
  if (det?.wt?.scheme) opts.push({ value: "wt", label: `El de Windows Terminal (${det.wt.schemeName ?? "actual"})` });
  for (const [id, s] of Object.entries(BUILTIN_SCHEMES)) opts.push({ value: "builtin:" + id, label: s.label });
  return opts;
}

/** Lo que se aplicaría al "adaptar a mi terminal". */
export interface Adaptation {
  font?: string;
  size?: number;
  scheme?: string;
  shell?: string;
  cursor?: "block" | "bar" | "underline";
  summary: string[];
}

export function planAdaptation(d: Detected, shells: ShellInfo[]): Adaptation {
  const summary: string[] = [];
  const font = d.wt?.font ?? d.vscode?.font;
  const size = d.wt?.size ?? d.vscode?.size;
  const scheme = d.wt?.scheme ? "wt" : undefined;
  const shell = shellIdFor(d.wt?.profile ?? d.vscode?.profile, shells);
  if (font) summary.push(`Fuente: ${font}`);
  if (size) summary.push(`Tamaño: ${size}`);
  if (scheme) summary.push(`Colores: ${d.wt?.schemeName ?? "Windows Terminal"}`);
  if (shell) summary.push(`Shell: ${shells.find((s) => s.id === shell)?.label ?? shell}`);
  return { font, size, scheme, shell, cursor: d.vscode?.cursor, summary };
}
