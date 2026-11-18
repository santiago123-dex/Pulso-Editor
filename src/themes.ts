import * as monaco from "monaco-editor";

export interface SyntaxColors {
  comment: string; keyword: string; string: string; number: string; type: string;
  fn: string; variable: string; tag: string; attr: string; constant: string;
  operator: string; regexp: string;
}

/** Un tema completo: interfaz, acento y colores del código. */
export interface Theme {
  label: string;
  base: "vs" | "vs-dark";
  bg: string; editor: string; sidebar: string; activity: string;
  border: string; hover: string; selected: string; fg: string; muted: string;
  accent: string;
  syntax: SyntaxColors;
  custom?: boolean;
}

type Ui = [bg: string, editor: string, sidebar: string, activity: string, border: string, hover: string, selected: string, fg: string, muted: string, accent: string];

const S = (comment: string, keyword: string, string: string, number: string, type: string, fn: string, variable: string, tag: string, attr: string, constant: string, operator: string, regexp: string): SyntaxColors =>
  ({ comment, keyword, string, number, type, fn, variable, tag, attr, constant, operator, regexp });

function T(label: string, base: Theme["base"], u: Ui, syntax: SyntaxColors): Theme {
  const [bg, editor, sidebar, activity, border, hover, selected, fg, muted, accent] = u;
  return { label, base, bg, editor, sidebar, activity, border, hover, selected, fg, muted, accent, syntax };
}

export const THEMES: Record<string, Theme> = {
  "pulso-dark": T("Pulso Oscuro", "vs-dark",
    ["#0e0e0f", "#151515", "#191919", "#111111", "#2a2a2a", "#232323", "#2d2d2d", "#e8e8e8", "#8a8a8a", "#5b9cf5"],
    S("6b7280", "b794f6", "9ad77b", "f2b36b", "5ec4ff", "e6c07b", "d9d8e4", "ff8a8a", "e6c07b", "f2b36b", "9aa0b4", "4ec9b0")),
  dracula: T("Drácula", "vs-dark",
    ["#191a21", "#282a36", "#21222c", "#191a21", "#343746", "#2f3140", "#44475a", "#f8f8f2", "#8c93b8", "#bd93f9"],
    S("6272a4", "ff79c6", "f1fa8c", "bd93f9", "8be9fd", "50fa7b", "f8f8f2", "ff79c6", "50fa7b", "bd93f9", "ff79c6", "ffb86c")),
  "one-dark": T("One Dark Pro", "vs-dark",
    ["#1b1d23", "#282c34", "#21252b", "#1b1d23", "#181a1f", "#2c313a", "#3a3f4b", "#abb2bf", "#7f848e", "#61afef"],
    S("5c6370", "c678dd", "98c379", "d19a66", "e5c07b", "61afef", "e06c75", "e06c75", "d19a66", "d19a66", "56b6c2", "56b6c2")),
  monokai: T("Monokai", "vs-dark",
    ["#171814", "#272822", "#1e1f1c", "#171814", "#1a1a17", "#3e3d32", "#49483e", "#f8f8f2", "#90908a", "#a6e22e"],
    S("75715e", "f92672", "e6db74", "ae81ff", "66d9ef", "a6e22e", "f8f8f2", "f92672", "a6e22e", "ae81ff", "f92672", "e6db74")),
  "tokyo-night": T("Tokyo Night", "vs-dark",
    ["#13131a", "#1a1b26", "#16161e", "#13131a", "#101014", "#202335", "#292e42", "#a9b1d6", "#565f89", "#7aa2f7"],
    S("565f89", "bb9af7", "9ece6a", "ff9e64", "2ac3de", "7aa2f7", "c0caf5", "f7768e", "bb9af7", "ff9e64", "89ddff", "b4f9f8")),
  nord: T("Nord", "vs-dark",
    ["#242933", "#2e3440", "#292e39", "#242933", "#3b4252", "#3b4252", "#434c5e", "#d8dee9", "#7b88a1", "#88c0d0"],
    S("616e88", "81a1c1", "a3be8c", "b48ead", "8fbcbb", "88c0d0", "d8dee9", "81a1c1", "8fbcbb", "b48ead", "81a1c1", "ebcb8b")),
  catppuccin: T("Catppuccin Mocha", "vs-dark",
    ["#11111b", "#1e1e2e", "#181825", "#11111b", "#313244", "#313244", "#45475a", "#cdd6f4", "#7f849c", "#cba6f7"],
    S("6c7086", "cba6f7", "a6e3a1", "fab387", "f9e2af", "89b4fa", "cdd6f4", "f38ba8", "f9e2af", "fab387", "89dceb", "f5c2e7")),
  "night-owl": T("Night Owl", "vs-dark",
    ["#010b14", "#011627", "#010e1a", "#010b14", "#122d42", "#0b2942", "#1d3b53", "#d6deeb", "#5f7e97", "#82aaff"],
    S("637777", "c792ea", "ecc48d", "f78c6c", "ffcb8b", "82aaff", "d6deeb", "7fdbca", "addb67", "82aaff", "c792ea", "5ca7e4")),
  gruvbox: T("Gruvbox Oscuro", "vs-dark",
    ["#181a1b", "#282828", "#1d2021", "#181a1b", "#3c3836", "#32302f", "#504945", "#ebdbb2", "#928374", "#fe8019"],
    S("928374", "fb4934", "b8bb26", "d3869b", "fabd2f", "b8bb26", "ebdbb2", "8ec07c", "fabd2f", "d3869b", "fe8019", "8ec07c")),
  "github-dark": T("GitHub Oscuro", "vs-dark",
    ["#010409", "#0d1117", "#010409", "#010409", "#30363d", "#161b22", "#21262d", "#c9d1d9", "#8b949e", "#388bfd"],
    S("8b949e", "ff7b72", "a5d6ff", "79c0ff", "ffa657", "d2a8ff", "ffa657", "7ee787", "79c0ff", "79c0ff", "ff7b72", "7ee787")),
  "solarized-dark": T("Solarized Oscuro", "vs-dark",
    ["#001e26", "#002b36", "#00212b", "#001e26", "#073642", "#073642", "#0a4452", "#93a1a1", "#657b83", "#268bd2"],
    S("586e75", "859900", "2aa198", "d33682", "b58900", "268bd2", "93a1a1", "268bd2", "b58900", "cb4b16", "93a1a1", "dc322f")),

  "pulso-light": T("Pulso Claro", "vs",
    ["#efeef5", "#ffffff", "#f4f3fa", "#e6e4f0", "#dcdae8", "#e9e7f3", "#d9d5ec", "#26253a", "#6d6c85", "#6d28d9"],
    S("8a8a9c", "7c3aed", "2a8a3e", "b45f06", "0b72b5", "8a5a00", "26253a", "c2410c", "8a5a00", "b45f06", "6b6b7b", "0f7c6b")),
  "github-light": T("GitHub Claro", "vs",
    ["#f0f3f6", "#ffffff", "#f6f8fa", "#f0f3f6", "#d0d7de", "#eaeef2", "#d8dee4", "#24292f", "#57606a", "#0969da"],
    S("6e7781", "cf222e", "0a3069", "0550ae", "953800", "8250df", "953800", "116329", "0550ae", "0550ae", "cf222e", "116329")),
  "solarized-light": T("Solarized Claro", "vs",
    ["#e6dfc8", "#fdf6e3", "#eee8d5", "#e6dfc8", "#ddd6c1", "#e8e1cb", "#d9d2bc", "#657b83", "#93a1a1", "#268bd2"],
    S("93a1a1", "859900", "2aa198", "d33682", "b58900", "268bd2", "657b83", "268bd2", "b58900", "cb4b16", "657b83", "dc322f")),
  "one-light": T("One Light", "vs",
    ["#e8e8e8", "#fafafa", "#f0f0f0", "#e8e8e8", "#dbdbdc", "#e5e5e6", "#d4d4d6", "#383a42", "#a0a1a7", "#4078f2"],
    S("a0a1a7", "a626a4", "50a14f", "986801", "c18401", "4078f2", "e45649", "e45649", "986801", "986801", "0184bc", "0184bc")),
};

export const tokenRules = (c: SyntaxColors): monaco.editor.ITokenThemeRule[] => [
  { token: "comment", foreground: c.comment, fontStyle: "italic" },
  { token: "keyword", foreground: c.keyword },
  { token: "string", foreground: c.string },
  { token: "string.key.json", foreground: c.attr },
  { token: "string.value.json", foreground: c.string },
  { token: "number", foreground: c.number },
  { token: "type", foreground: c.type },
  { token: "type.identifier", foreground: c.type },
  { token: "annotation", foreground: c.type },
  { token: "predefined", foreground: c.fn },
  { token: "function", foreground: c.fn },
  { token: "variable", foreground: c.variable },
  { token: "constant", foreground: c.constant },
  { token: "tag", foreground: c.tag },
  { token: "metatag", foreground: c.tag },
  { token: "attribute.name", foreground: c.attr },
  { token: "attribute.value", foreground: c.string },
  { token: "operator", foreground: c.operator },
  { token: "delimiter", foreground: c.operator },
  { token: "regexp", foreground: c.regexp },
];

// ---------- Importar temas de VS Code ----------
const hex6 = (c: unknown): string | null => (typeof c === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? c.slice(0, 7).toLowerCase() : null);

function rgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
const toHex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** Mezcla `a` con `b`: t=0 da a, t=1 da b. */
export const mix = (a: string, b: string, t: number) => {
  const x = rgb(a), y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};
const luminance = (h: string) => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

/** Convierte un color con transparencia (#RRGGBBAA) a uno opaco sobre `over`. */
function flatten(c: unknown, over: string): string | null {
  if (typeof c !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return null;
  const solid = c.slice(0, 7).toLowerCase();
  if (c.length === 9) return mix(over, solid, parseInt(c.slice(7), 16) / 255);
  return solid;
}

/** Interpreta JSON con comentarios y comas finales, como los temas de VS Code. */
export function parseJsonc(src: string): any {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/^﻿/, "").replace(/,(\s*[}\]])/g, "$1"));
}

interface TokenRule { scope?: string | string[]; settings?: { foreground?: string } }

const ROLE_SCOPES: Record<keyof SyntaxColors, string[]> = {
  comment: ["comment"],
  keyword: ["keyword.control", "keyword", "storage.modifier", "storage"],
  string: ["string.quoted", "string"],
  number: ["constant.numeric", "constant.numeric.decimal"],
  type: ["entity.name.type", "entity.name.class", "support.type", "support.class", "storage.type"],
  fn: ["entity.name.function", "support.function", "meta.function-call"],
  variable: ["variable", "variable.other"],
  tag: ["entity.name.tag", "meta.tag"],
  attr: ["entity.other.attribute-name", "support.type.property-name"],
  constant: ["constant.language", "constant.character", "constant"],
  operator: ["keyword.operator", "punctuation"],
  regexp: ["string.regexp"],
};

function tokenColor(rules: TokenRule[], prefixes: string[]): string | null {
  const scopesOf = (r: TokenRule) => (Array.isArray(r.scope) ? r.scope : typeof r.scope === "string" ? r.scope.split(",") : []).map((s) => s.trim());
  // Primero coincidencia exacta (p. ej. "string"); solo después subámbitos ("string.quoted.double").
  for (const exact of [true, false]) {
    for (const prefix of prefixes) {
      let found: string | null = null;
      for (const r of rules) {
        const fg = hex6(r.settings?.foreground);
        if (!fg) continue;
        const hit = scopesOf(r).some((s) => (exact ? s === prefix : s.startsWith(prefix + ".") && !/docstring|comment/.test(s)));
        if (hit) found = fg;
      }
      if (found) return found;
    }
  }
  return null;
}

/** Convierte el contenido de un tema de VS Code (ya combinado con sus `include`) en un tema de Pulso. */
export function themeFromVSCode(raw: any, fallbackLabel: string): Theme {
  const colors: Record<string, string> = raw.colors ?? {};
  const editor = flatten(colors["editor.background"], "#000000") ?? (raw.type === "light" ? "#ffffff" : "#1e1e1e");
  const light = raw.type === "light" || raw.type === "hc-light" || (raw.type == null && luminance(editor) > 0.55);
  const fg = flatten(colors["editor.foreground"] ?? colors["foreground"], editor) ?? (light ? "#333333" : "#d4d4d4");
  const first = (...keys: string[]) => {
    for (const k of keys) { const v = flatten(colors[k], editor); if (v) return v; }
    return null;
  };
  const sidebar = first("sideBar.background", "editorGroupHeader.tabsBackground") ?? mix(editor, light ? "#000000" : "#000000", 0.12);
  const activity = first("activityBar.background", "titleBar.activeBackground") ?? mix(sidebar, "#000000", light ? 0.05 : 0.25);
  const border = first("sideBar.border", "panel.border", "editorGroup.border", "contrastBorder") ?? mix(editor, fg, 0.14);
  const hover = first("list.hoverBackground", "editor.lineHighlightBackground") ?? mix(editor, fg, 0.07);
  const selected = first("list.activeSelectionBackground", "list.inactiveSelectionBackground", "editor.selectionBackground") ?? mix(editor, fg, 0.16);
  const muted = first("descriptionForeground", "tab.inactiveForeground", "sideBarTitle.foreground") ?? mix(fg, editor, 0.45);
  // El acento suele ser un color vivo: probamos varios candidatos y descartamos grises o casi iguales al fondo.
  const vivid = (hex: string | null): hex is string => {
    if (!hex) return false;
    const [r, g, b] = rgb(hex);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = luminance(hex);
    return max > 0 && (max - min) / max > 0.3 && l > 0.18 && l < 0.9;
  };
  const candidates = ["activityBar.activeBorder", "tab.activeBorderTop", "tab.activeBorder", "activityBarBadge.background",
    "progressBar.background", "button.background", "statusBarItem.remoteBackground", "focusBorder", "statusBar.background", "textLink.foreground"];
  let accent: string | null = null;
  for (const k of candidates) { const v = hex6(colors[k]); if (vivid(v)) { accent = v; break; } }
  if (!accent) {
    const kw = tokenColor(Array.isArray(raw.tokenColors) ? raw.tokenColors : [], ROLE_SCOPES.keyword);
    accent = vivid(kw) ? kw : "#7c3aed";
  }

  const rules: TokenRule[] = Array.isArray(raw.tokenColors) ? raw.tokenColors : [];
  const base = light ? THEMES["pulso-light"].syntax : THEMES["pulso-dark"].syntax;
  const syntax = {} as SyntaxColors;
  for (const role of Object.keys(ROLE_SCOPES) as (keyof SyntaxColors)[]) {
    syntax[role] = (tokenColor(rules, ROLE_SCOPES[role]) ?? "#" + base[role]).replace("#", "");
  }
  if (!tokenColor(rules, ROLE_SCOPES.variable)) syntax.variable = fg.replace("#", "");
  return {
    label: String(raw.name ?? fallbackLabel),
    base: light ? "vs" : "vs-dark",
    bg: activity, editor, sidebar, activity, border, hover, selected, fg, muted, accent,
    syntax,
    custom: true,
  };
}

/** Colores de xterm.js a partir de un tema: el ANSI sale de la paleta de sintaxis para que combine. */
export function terminalTheme(t: Theme): Record<string, string> {
  const c = (k: keyof SyntaxColors) => "#" + t.syntax[k];
  const light = t.base === "vs";
  // Las variantes "brillantes" se acercan al blanco (tema oscuro) o al negro (claro).
  const bright = (hex: string) => mix(hex, light ? "#000000" : "#ffffff", 0.25);
  const black = light ? "#2b2b2b" : mix(t.editor, t.fg, 0.3);
  const base = {
    black, red: c("tag"), green: c("string"), yellow: c("type"),
    blue: c("fn"), magenta: c("keyword"), cyan: c("regexp"), white: light ? "#6b6b6b" : t.fg,
  };
  return {
    background: t.editor,
    foreground: t.fg,
    cursor: t.accent,
    cursorAccent: t.editor,
    selectionBackground: t.accent + "55",
    ...base,
    brightBlack: mix(t.editor, t.fg, 0.5),
    brightRed: bright(base.red),
    brightGreen: bright(base.green),
    brightYellow: bright(base.yellow),
    brightBlue: bright(base.blue),
    brightMagenta: bright(base.magenta),
    brightCyan: bright(base.cyan),
    brightWhite: light ? "#2b2b2b" : bright(t.fg),
  };
}
