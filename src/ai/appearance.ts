import { readJsonStorage, writeJsonStorage } from "../core/storage";
import { applyTheme, state } from "../settings";
import { h } from "../util";

export const BG_KEY = "pulso.ai.appearance";

export interface AiAppearance {
  bg: string;
  pattern: "dots" | "solid";
  scope: "assistant" | "global";
}

export const BG_PRESETS: { name: string; color: string; swatch: string }[] = [
  { name: "Tema actual", color: "", swatch: "var(--bg)" },
  { name: "Negro puro", color: "#050507", swatch: "#050507" },
  { name: "Azul noche", color: "#071022", swatch: "#071022" },
  { name: "Pizarra", color: "#0d141c", swatch: "#0d141c" },
  { name: "Índigo", color: "#0e0b1a", swatch: "#0e0b1a" },
  { name: "Bosque", color: "#071410", swatch: "#071410" },
];

export const THEME_VARS = [
  "--bg", "--editor", "--sidebar", "--activity", "--hover", "--selected", "--border", "--fg", "--muted",
] as const;

export function loadAppearance(): AiAppearance {
  const raw = readJsonStorage<Partial<AiAppearance>>(BG_KEY, {});
  return {
    bg: typeof raw.bg === "string" && /^#[0-9a-f]{6}$/i.test(raw.bg) ? raw.bg : "",
    pattern: raw.pattern === "solid" ? "solid" : "dots",
    scope: raw.scope === "global" ? "global" : "assistant",
  };
}

export function isLightHex(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

export function applyAiAppearance(
  view: HTMLElement,
  cfg: AiAppearance = loadAppearance(),
  restoreTheme: () => void = () => applyTheme(state.settings),
) {
  const root = document.documentElement.style;
  view.classList.toggle("ai-bg-solid", cfg.pattern === "solid");
  const clearVars = (s: CSSStyleDeclaration) => THEME_VARS.forEach((v) => s.removeProperty(v));
  if (!cfg.bg) {
    clearVars(view.style);
    clearVars(root);
    restoreTheme();
    return;
  }
  const light = isLightHex(cfg.bg);
  const mix = light ? "#000000" : "#ffffff";
  const surface = `color-mix(in srgb, ${cfg.bg} ${light ? "93%" : "91%"}, ${mix})`;
  const hover = `color-mix(in srgb, ${cfg.bg} 84%, ${mix})`;
  const selected = `color-mix(in srgb, ${cfg.bg} 76%, ${mix})`;
  const border = `color-mix(in srgb, ${cfg.bg} ${light ? "82%" : "83%"}, ${mix})`;
  const fg = light ? "#191b22" : "#eceef4";
  const muted = light ? "#5e6473" : "#8b93a7";
  const target = cfg.scope === "global" ? root : view.style;
  if (cfg.scope === "global") {
    clearVars(view.style);
  } else {
    clearVars(root);
    restoreTheme();
  }
  target.setProperty("--bg", cfg.bg);
  target.setProperty("--editor", cfg.bg);
  target.setProperty("--sidebar", surface);
  target.setProperty("--activity", cfg.bg);
  target.setProperty("--hover", hover);
  target.setProperty("--selected", selected);
  target.setProperty("--border", border);
  target.setProperty("--fg", fg);
  target.setProperty("--muted", muted);
}

export function saveAppearance(view: HTMLElement, cfg: AiAppearance) {
  writeJsonStorage(BG_KEY, cfg);
  applyAiAppearance(view, cfg);
}

export function buildAppearancePopover(
  view: HTMLElement,
): HTMLElement {
  const pop = h("div", "ai-popover ai-theme-pop");
  const render = () => {
    const cfg = loadAppearance();
    pop.replaceChildren();
    const head = h("div", "ai-usage-pop-head");
    head.append(h("span", "ai-usage-group", "Fondo y estilo"));
    if (cfg.bg || cfg.pattern !== "dots" || cfg.scope !== "assistant") {
      const rst = h("button", "ai-usage-sync", "Restablecer");
      rst.type = "button";
      rst.onclick = () => { saveAppearance(view, { bg: "", pattern: "dots", scope: "assistant" }); render(); };
      head.append(rst);
    }
    pop.append(head);

    const grid = h("div", "ai-swatch-grid");
    for (const p of BG_PRESETS) {
      const active = cfg.bg.toLowerCase() === p.color.toLowerCase();
      const b = h("button", `ai-swatch${active ? " active" : ""}`);
      b.type = "button";
      b.title = p.name;
      const dot = h("span", "ai-swatch-dot");
      dot.style.background = p.swatch;
      b.append(dot, h("span", "ai-swatch-name", p.name));
      b.onclick = () => { saveAppearance(view, { ...cfg, bg: p.color }); render(); };
      grid.append(b);
    }
    pop.append(grid);

    const customRow = h("label", "ai-color-custom");
    const picker = h("input");
    picker.type = "color";
    picker.value = cfg.bg || "#0e0e0f";
    const hexLbl = h("span", "ai-color-hex", cfg.bg ? cfg.bg.toUpperCase() : "Tema");
    picker.oninput = () => {
      hexLbl.textContent = picker.value.toUpperCase();
      saveAppearance(view, { ...cfg, bg: picker.value });
      grid.querySelectorAll(".ai-swatch").forEach((s) => s.classList.remove("active"));
    };
    customRow.append(h("span", "ai-pop-effort-lbl", "Color personalizado"), picker, hexLbl);
    pop.append(h("div", "ai-pop-sep"), customRow);

    const optRow = h("div", "ai-theme-opts");
    const makeToggle = (label: string, opts: [string, string, boolean, () => void][]) => {
      const row = h("div", "ai-pop-effort");
      row.append(h("span", "ai-pop-effort-lbl", label));
      const pills = h("div", "ai-effort-pills");
      for (const [, text, active, fn] of opts) {
        const b = h("button", `ai-effort-pill${active ? " active" : ""}`, text);
        b.type = "button";
        b.onclick = () => { fn(); render(); };
        pills.append(b);
      }
      row.append(pills);
      return row;
    };
    optRow.append(
      makeToggle("Textura", [
        ["dots", "Puntos", cfg.pattern === "dots", () => saveAppearance(view, { ...cfg, pattern: "dots" })],
        ["solid", "Liso", cfg.pattern === "solid", () => saveAppearance(view, { ...cfg, pattern: "solid" })],
      ]),
      makeToggle("Aplicar en", [
        ["assistant", "Asistente", cfg.scope === "assistant", () => saveAppearance(view, { ...cfg, scope: "assistant" })],
        ["global", "Todo Pulso", cfg.scope === "global", () => saveAppearance(view, { ...cfg, scope: "global" })],
      ]),
    );
    pop.append(h("div", "ai-pop-sep"), optRow);
  };
  render();
  return pop;
}
