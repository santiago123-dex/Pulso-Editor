import * as monaco from "monaco-editor";
import { setIconMode } from "./icons";
import { THEMES, tokenRules, type Theme } from "./themes";

export interface Settings {
  /** Versión del formato; sirve para migrar configuraciones antiguas. */
  v: number;
  theme: string;
  accent: string;
  fontSize: number;
  fontFamily: string;
  ligatures: boolean;
  minimap: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  tabSize: number;
  whitespace: boolean;
  smoothCaret: boolean;
  /** "auto" = los colores de código del propio tema; o el id de otro tema para mezclar. */
  syntaxTheme: string;
  autoSave: boolean;
  /** Shell de la terminal integrada (id); vacío = la recomendada. */
  terminalShell: string;
  /** Fuente de la terminal; vacío = Nerd Fonts habituales y luego la del editor. */
  terminalFont: string;
  /** Tamaño de fuente de la terminal; 0 = automático (el del editor menos uno). */
  terminalFontSize: number;
  /** Colores: "" = los del tema; "wt" = los de Windows Terminal; "builtin:<id>" = uno incluido. */
  terminalScheme: string;
  terminalCursor: "block" | "bar" | "underline";
  /** Ya se ofreció adaptar la terminal a la configuración que el usuario tiene. */
  terminalAdapted: boolean;
  /** Atajos personalizados: id de comando -> combinación ("" = sin atajo). */
  keybindings: Record<string, string>;
  /** Temas importados de VS Code. */
  customThemes: Record<string, Theme>;
}

export const DEFAULTS: Settings = {
  v: 2,
  theme: "pulso-dark",
  accent: THEMES["pulso-dark"].accent,
  fontSize: 14,
  fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
  ligatures: true,
  minimap: true,
  wordWrap: false,
  lineNumbers: true,
  tabSize: 2,
  whitespace: false,
  smoothCaret: true,
  syntaxTheme: "auto",
  autoSave: false,
  terminalShell: "",
  terminalFont: "",
  terminalFontSize: 0,
  terminalScheme: "",
  terminalCursor: "block",
  terminalAdapted: false,
  keybindings: {},
  customThemes: {},
};

export const FONTS: Record<string, string> = {
  "Cascadia Code": '"Cascadia Code", Consolas, monospace',
  "JetBrains Mono": '"JetBrains Mono", Consolas, monospace',
  "Fira Code": '"Fira Code", Consolas, monospace',
  Consolas: "Consolas, monospace",
  "Courier New": '"Courier New", monospace',
};

export const ACCENTS = ["#7c3aed", "#4c9aff", "#3ddc97", "#ff5a3c", "#ffcc33", "#ff6ac1"];

const KEY = "pulso.settings";

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (saved.v !== DEFAULTS.v) {
      // Antes el tema y el acento eran independientes; ahora cada tema define su acento.
      delete saved.theme; delete saved.accent; delete saved.syntaxTheme;
    }
    return {
      ...DEFAULTS, ...saved, v: DEFAULTS.v,
      keybindings: { ...(saved.keybindings ?? {}) },
      customThemes: { ...(saved.customThemes ?? {}) },
    };
  } catch {
    return { ...DEFAULTS, keybindings: {}, customThemes: {} };
  }
}

export const saveSettings = (s: Settings) => localStorage.setItem(KEY, JSON.stringify(s));

/** Estado compartido de la configuración actual. */
export const state = { settings: loadSettings() };

export const allThemes = (): Record<string, Theme> => ({ ...THEMES, ...state.settings.customThemes });
export const currentTheme = (): Theme => allThemes()[state.settings.theme] ?? THEMES["pulso-dark"];

const kindOf = (t: Theme) => (t.base === "vs" ? "light" : "dark");

/** Temas cuyos colores de código se pueden usar con el tema actual (mismo tipo, claro u oscuro). */
export function syntaxOptionsFor(themeId: string): [string, string][] {
  const all = allThemes();
  const kind = kindOf(all[themeId] ?? THEMES["pulso-dark"]);
  return Object.entries(all).filter(([id, t]) => kindOf(t) === kind && id !== themeId).map(([id, t]) => [id, t.label]);
}

function syntaxFor(s: Settings, theme: Theme) {
  const other = s.syntaxTheme !== "auto" ? allThemes()[s.syntaxTheme] : undefined;
  return other && kindOf(other) === kindOf(theme) ? other.syntax : theme.syntax;
}

const subs = new Set<() => void>();
export const onSettingsChange = (f: () => void) => { subs.add(f); };

/** Guarda, aplica el tema y avisa a quien dependa de la configuración. */
export function commit() {
  saveSettings(state.settings);
  applyTheme(state.settings);
  subs.forEach((f) => f());
}

/** Elige un tema completo: interfaz, acento y colores del código. */
export function setTheme(id: string) {
  const t = allThemes()[id];
  if (!t) return;
  state.settings.theme = id;
  state.settings.accent = t.accent;
  state.settings.syntaxTheme = "auto";
  commit();
}

/** Texto blanco o negro según la luminancia del color. */
function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

export function applyTheme(s: Settings, previewId?: string) {
  const all = allThemes();
  const id = previewId && all[previewId] ? previewId : s.theme;
  const p = all[id] ?? THEMES["pulso-dark"];
  const accent = previewId ? p.accent : s.accent;
  const light = p.base === "vs";
  const root = document.documentElement.style;
  const vars: Record<string, string> = {
    bg: p.bg, editor: p.editor, sidebar: p.sidebar, activity: p.activity,
    border: p.border, hover: p.hover, selected: p.selected, fg: p.fg, muted: p.muted,
    accent, status: accent, "on-accent": readableOn(accent),
    "git-modified": light ? "#895503" : "#e2c08d",
    "git-added": light ? "#2e7d32" : "#73c991",
    "git-deleted": light ? "#ad0707" : "#c74e39",
    "git-conflict": light ? "#ad0707" : "#e06c75",
  };
  for (const [k, v] of Object.entries(vars)) root.setProperty(`--${k}`, v);
  // Se recuerdan para que la próxima vez la pantalla de carga ya salga con los colores del tema.
  if (!previewId) { try { localStorage.setItem("pulso.themeVars", JSON.stringify(vars)); } catch { /* sin espacio */ } }
  root.setProperty("--mono", s.fontFamily);
  root.colorScheme = light ? "light" : "dark";
  setIconMode(light);

  const sx = previewId ? p.syntax : syntaxFor(s, p);
  monaco.editor.defineTheme("pulso-active", {
    base: p.base, inherit: true,
    rules: tokenRules(sx),
    colors: {
      "editor.background": p.editor, "editor.foreground": p.fg,
      "editorGutter.background": p.editor, "editor.lineHighlightBackground": p.hover,
      "editorLineNumber.foreground": p.muted, "editorLineNumber.activeForeground": p.fg,
      "editorIndentGuide.background1": p.border, "editorWidget.background": p.sidebar,
      "editorWidget.border": p.border,
      "editorSuggestWidget.background": p.sidebar, "editorSuggestWidget.border": p.border,
      "editorHoverWidget.background": p.sidebar, "editorHoverWidget.border": p.border,
      "minimap.background": p.editor,
      "editor.selectionBackground": accent + "44",
      "editor.inactiveSelectionBackground": accent + "22",
      "editorCursor.foreground": accent,
      "scrollbarSlider.background": p.selected + "aa",
      "scrollbarSlider.hoverBackground": p.muted + "88",
      "input.background": p.editor, "input.border": p.border,
      "list.hoverBackground": p.hover, "list.activeSelectionBackground": p.selected,
      "focusBorder": accent,
      "editorBracketHighlight.foreground1": "#" + sx.type,
      "editorBracketHighlight.foreground2": "#" + sx.keyword,
      "editorBracketHighlight.foreground3": "#" + sx.string,
      "editorBracketHighlight.foreground4": "#" + sx.fn,
      "editorBracketHighlight.foreground5": "#" + sx.number,
      "editorBracketHighlight.foreground6": "#" + sx.constant,
    },
  });
  monaco.editor.setTheme("pulso-active");
}

export function editorOptions(s: Settings): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontLigatures: s.ligatures,
    lineHeight: Math.round(s.fontSize * 1.55),
    minimap: { enabled: s.minimap },
    wordWrap: s.wordWrap ? "on" : "off",
    lineNumbers: s.lineNumbers ? "on" : "off",
    renderWhitespace: s.whitespace ? "all" : "selection",
    cursorSmoothCaretAnimation: s.smoothCaret ? "on" : "off",
  };
}
