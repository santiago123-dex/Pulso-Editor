import { t as tr } from "./i18n";
import { allThemes, applyTheme, commit, setTheme, state } from "./settings";
import { importFromFile, importInstalled } from "./themeImport";
import type { SyntaxColors, Theme } from "./themes";
import { hooks, setStatus, trackOverlay } from "./ui";
import { h } from "./util";

type Filter = "all" | "dark" | "light" | "custom";

/** Líneas de código de ejemplo: cada bloque usa el color de un rol de la sintaxis del tema. */
const SAMPLE: [keyof SyntaxColors, number][][] = [
  [["keyword", 14], ["variable", 26], ["operator", 5], ["string", 36]],
  [["keyword", 14], ["fn", 30], ["operator", 5], ["number", 14]],
  [["comment", 66]],
  [["tag", 12], ["attr", 24], ["operator", 5], ["string", 30]],
  [["type", 22], ["variable", 18], ["operator", 5], ["constant", 18]],
  [["keyword", 12], ["fn", 26], ["variable", 16]],
];

const box = (style: Partial<CSSStyleDeclaration>, cls = "") => {
  const d = h("div", cls);
  Object.assign(d.style, style);
  return d;
};

/** Miniatura del editor con los colores reales del tema. */
function mock(t: Theme): HTMLElement {
  const root = box({ background: t.bg }, "tg-mock");

  const act = box({ background: t.activity }, "tg-act");
  for (let i = 0; i < 3; i++) act.append(box({ background: i === 0 ? t.fg : t.muted, opacity: i === 0 ? "1" : ".5" }, "tg-dot"));

  const side = box({ background: t.sidebar, borderRight: `1px solid ${t.border}` }, "tg-side");
  [70, 52, 62, 44].forEach((w, i) => {
    const row = box({ background: i === 1 ? t.selected : "transparent" }, "tg-srow");
    row.append(box({ background: t.muted, width: `${w}%`, opacity: ".55" }, "tg-sline"));
    side.append(row);
  });

  const main = box({ background: t.editor }, "tg-main");
  const tabs = box({ background: t.sidebar }, "tg-tabs");
  const tab = box({ background: t.editor, borderTop: `2px solid ${t.accent}` }, "tg-tab");
  tab.append(box({ background: t.fg, opacity: ".7" }, "tg-tabline"));
  tabs.append(tab, box({ background: t.muted, opacity: ".35" }, "tg-tabline2"));
  main.append(tabs);
  const code = box({}, "tg-code");
  SAMPLE.forEach((line, i) => {
    const row = box({ marginLeft: i === 1 || i === 4 ? "10px" : "0" }, "tg-line");
    for (const [role, w] of line) row.append(box({ background: `#${t.syntax[role]}`, width: `${w}%` }, "tg-tok"));
    code.append(row);
  });
  main.append(code);

  root.append(act, side, main, box({ background: t.accent }, "tg-status"));
  return root;
}

export function openThemeGallery() {
  const original = state.settings.theme;
  const end = trackOverlay();
  let filter: Filter = "all";
  let index = 0;
  let query = "";
  let hoverTimer = 0;
  let entries: [string, Theme][] = [];

  const back = h("div", "tg-back");
  const dlg = h("div", "tg-box");
  const head = h("div", "tg-head");
  const title = h("div", "tg-title", tr("Tema de color"));
  const input = h("input", "tg-search");
  input.type = "text";
  input.placeholder = tr("Buscar tema…");
  input.spellcheck = false;
  input.autocomplete = "off";
  const chips = h("div", "tg-chips");
  head.append(title, input, chips);

  const grid = h("div", "tg-grid");
  const foot = h("div", "tg-foot");
  const hint = h("span", "tg-hint", tr("Flechas para recorrer · Enter para aplicar · Esc para cancelar"));
  const importBtn = h("button", "mbtn", tr("Importar de VS Code…"));
  const fileBtn = h("button", "mbtn", tr("Archivo…"));
  const count = h("span", "tg-count");
  foot.append(hint, count, importBtn, fileBtn);
  dlg.append(head, grid, foot);
  back.append(dlg);
  document.body.append(back);

  const close = (revert: boolean) => {
    clearTimeout(hoverTimer);
    if (revert) applyTheme(state.settings);
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    end();
    hooks.focusEditor();
  };

  const preview = (id: string) => {
    clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => applyTheme(state.settings, id), 90);
  };

  const apply = (id: string) => {
    clearTimeout(hoverTimer);
    setTheme(id);
    close(false);
    setStatus(tr("Tema «{theme}» aplicado", { theme: allThemes()[id]?.label ?? id }));
  };

  const refreshEntries = () => {
    const q = query.trim().toLowerCase();
    entries = Object.entries(allThemes()).filter(([, t]) => {
      if (filter === "dark" && (t.base === "vs" || t.custom)) return false;
      if (filter === "light" && (t.base !== "vs" || t.custom)) return false;
      if (filter === "custom" && !t.custom) return false;
      return !q || t.label.toLowerCase().includes(q);
    });
  };

  const paintChips = () => {
    chips.replaceChildren();
    const hasCustom = Object.values(allThemes()).some((t) => t.custom);
    const defs: [Filter, string][] = [["all", tr("Todos")], ["dark", tr("Oscuros")], ["light", tr("Claros")]];
    if (hasCustom) defs.push(["custom", tr("Importados")]);
    for (const [f, label] of defs) {
      const c = h("button", "tg-chip" + (filter === f ? " on" : ""), label);
      c.onmousedown = (e) => e.preventDefault();
      c.onclick = () => { filter = f; index = 0; paint(); input.focus(); };
      chips.append(c);
    }
  };

  const paintGrid = () => {
    grid.replaceChildren();
    if (!entries.length) { grid.append(h("div", "tg-empty", tr("No hay temas que coincidan"))); return; }
    entries.forEach(([id, t], i) => {
      const card = h("div", "tg-card" + (i === index ? " on" : "") + (id === original ? " current" : ""));
      card.setAttribute("role", "option");
      card.append(mock(t));
      const meta = h("div", "tg-meta");
      meta.append(h("span", "tg-name", t.label));
      meta.append(h("span", "tg-kind", t.custom ? tr("Importado") : t.base === "vs" ? tr("Claro") : tr("Oscuro")));
      if (id === original) meta.append(h("span", "tg-check", "✓"));
      card.append(meta);
      if (t.custom) {
        const del = h("button", "tg-del", "×");
        del.title = tr("Quitar este tema importado");
        del.onmousedown = (e) => e.preventDefault();
        del.onclick = (e) => {
          e.stopPropagation();
          delete state.settings.customThemes[id];
          if (state.settings.theme === id) setTheme("pulso-dark"); else commit();
          paint();
        };
        card.append(del);
      }
      card.onmousedown = (e) => e.preventDefault();
      card.onclick = () => apply(id);
      card.onmouseenter = () => { index = i; markOn(); preview(id); };
      grid.append(card);
    });
    grid.onmouseleave = () => { clearTimeout(hoverTimer); applyTheme(state.settings); };
  };

  const markOn = () => {
    grid.querySelectorAll(".tg-card").forEach((c, i) => c.classList.toggle("on", i === index));
  };

  const paint = () => {
    refreshEntries();
    index = Math.min(index, Math.max(0, entries.length - 1));
    paintChips();
    paintGrid();
    count.textContent = entries.length === 1 ? tr("1 tema") : tr("{count} temas", { count: entries.length });
  };

  const move = (to: number) => {
    if (!entries.length) return;
    index = Math.max(0, Math.min(entries.length - 1, to));
    markOn();
    grid.querySelectorAll(".tg-card")[index]?.scrollIntoView({ block: "nearest" });
    preview(entries[index][0]);
  };

  const columns = () => {
    const cards = Array.from(grid.querySelectorAll<HTMLElement>(".tg-card"));
    if (!cards.length) return 1;
    return Math.max(1, cards.filter((c) => c.offsetTop === cards[0].offsetTop).length);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "ArrowRight") { e.preventDefault(); move(index + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(index - 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(index + columns()); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(index - columns()); }
    else if (e.key === "Enter") { e.preventDefault(); if (entries[index]) apply(entries[index][0]); }
  };
  document.addEventListener("keydown", onKey, true);

  input.oninput = () => { query = input.value; index = 0; paint(); };
  back.onmousedown = (e) => { if (e.target === back) close(true); };
  importBtn.onclick = () => { close(true); importInstalled(); };
  fileBtn.onclick = () => { close(true); void importFromFile(); };

  // Empieza resaltando el tema en uso.
  refreshEntries();
  index = Math.max(0, entries.findIndex(([id]) => id === original));
  paint();
  input.focus();
  grid.querySelectorAll(".tg-card")[index]?.scrollIntoView({ block: "center" });
}
