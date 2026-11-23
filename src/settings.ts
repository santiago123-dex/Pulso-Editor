import * as monaco from "monaco-editor";
import { readJsonStorage, writeJsonStorage } from "./core/storage";
import { setIconMode } from "./icons";
import { THEMES, tokenRules, type Theme } from "./themes";

export interface Settings {
  /** Versión del formato; sirve para migrar configuraciones antiguas. */
  v: number;
  /** Idioma de la interfaz: "auto" sigue al sistema. Lo lee i18n.ts al arrancar. */
  language: "auto" | "es" | "en";
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
  /** Formatea el documento con el servidor de lenguaje al guardar a mano (no en el autoguardado). */
  formatOnSave: boolean;
  /** Autocompletado de IA en línea (texto fantasma con Tab) usando Ollama local. */
  inlineAiEnabled: boolean;
  /** Modelo de Ollama para autocompletado en línea; vacío = automático. */
  inlineAiModel: string;
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
  /** Etiqueta de GitHub que coloca una issue en la columna «En curso» del tablero. */
  boardProgressLabel: string;
  /** Atajos personalizados: id de comando -> combinación ("" = sin atajo). */
  keybindings: Record<string, string>;
  /** Temas importados de VS Code. */
  customThemes: Record<string, Theme>;
}

export const DEFAULTS: Settings = {
  v: 2,
  language: "auto",
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
  formatOnSave: false,
  inlineAiEnabled: true,
  inlineAiModel: "",
  terminalShell: "",
  terminalFont: "",
  terminalFontSize: 0,
  terminalScheme: "",
  terminalCursor: "block",
  terminalAdapted: false,
  boardProgressLabel: "in progress",
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

export const ACCENTS = ["#5b9cf5", "#7c3aed", "#4c9aff", "#3ddc97", "#ff5a3c", "#ffcc33", "#ff6ac1"];

const KEY = "pulso.settings";

export function loadSettings(): Settings {
  try {
    const saved = readJsonStorage<Record<string, unknown>>(KEY, {});
    if (saved.v !== DEFAULTS.v) {
      // Antes el tema y el acento eran independientes; ahora cada tema define su acento.
      delete saved.theme; delete saved.accent; delete saved.syntaxTheme;
    }
    // El acento morado era el de fábrica del tema Pulso; quien no lo cambió pasa al nuevo (azul). Uno elegido a propósito se respeta.
    if ((saved.theme ?? DEFAULTS.theme) === "pulso-dark" && String(saved.accent).toLowerCase() === "#7c3aed") delete saved.accent;
    return {
      ...DEFAULTS, ...saved, v: DEFAULTS.v,
      keybindings: { ...((saved.keybindings as Record<string, string>) ?? {}) },
      customThemes: { ...((saved.customThemes as Record<string, Theme>) ?? {}) },
    };
  } catch {
    return { ...DEFAULTS, keybindings: {}, customThemes: {} };
  }
}

export const saveSettings = (s: Settings) => { writeJsonStorage(KEY, s); };

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

/** Luminancia relativa WCAG de un color #rrggbb. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Texto blanco o negro, el que tenga más contraste sobre el color (así un acento claro lleva texto oscuro). */
export function readableOn(hex: string): string {
  const L = luminance(hex);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? "#ffffff" : "#111111";
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
  if (!previewId) writeJsonStorage("pulso.themeVars", vars);
  root.setProperty("--mono", s.fontFamily);
  root.colorScheme = light ? "light" : "dark";
  // El marco y la luz de las hojas cambian con el tono del tema (ver «Profundidad» en styles.css).
  document.documentElement.dataset.tone = light ? "light" : "dark";
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
