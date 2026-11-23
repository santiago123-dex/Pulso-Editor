import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, keyOf } from "./commands";
import { t } from "./i18n";
import { $, h } from "./util";

/** Entrada de un menú: un comando registrado, una acción propia o un separador. */
export type MenuEntry =
  | { cmd: string; label: string }
  | { label: string; run: () => void | Promise<void>; hint?: string }
  | "sep";

export interface MenuDef { label: string; items: MenuEntry[] }

const inTauri = "__TAURI_INTERNALS__" in window;

interface Resolved { label: string; hint?: string; run: () => void; disabled?: boolean }

function resolve(e: Exclude<MenuEntry, "sep">): Resolved {
  if ("cmd" in e) {
    const c = commands.find((x) => x.id === e.cmd);
    return { label: e.label, hint: c ? keyOf(c) : "", run: () => { void c?.run(); }, disabled: !c };
  }
  return { label: e.label, hint: e.hint, run: () => { void e.run(); } };
}

/** Nombre del proyecto que se muestra en el centro de la barra. */
export function setTitleLabel(text: string) {
  $("tb-label").textContent = text;
}

/** Punto junto al nombre cuando hay archivos sin guardar. */
export function setUnsaved(count: number) {
  const dot = $("tb-dirty");
  dot.hidden = count === 0;
  dot.title = count === 1 ? "1 archivo sin guardar" : `${count} archivos sin guardar`;
  $("tb-title").classList.toggle("unsaved", count > 0);
}

/** Habilita o atenúa las flechas de atrás y adelante. */
export function setNavState(canBack: boolean, canForward: boolean) {
  ($("nav-back") as HTMLButtonElement).disabled = !canBack;
  ($("nav-fwd") as HTMLButtonElement).disabled = !canForward;
}

let beatTimer = 0;
/** Un destello de luz recorre la barra: confirmación discreta de que se guardó. */
export function beat() {
  const tb = $("titlebar");
  tb.classList.remove("beat");
  void tb.offsetWidth; // reinicia la animación aunque se repita enseguida
  tb.classList.add("beat");
  clearTimeout(beatTimer);
  beatTimer = window.setTimeout(() => tb.classList.remove("beat"), 1100);
}

export function initTitlebar(opts: {
  menus: MenuDef[];
  onTitleClick: () => void;
  onBack: () => void;
  onForward: () => void;
}) {
  // ---------- Menú de hamburguesa: categorías a la izquierda, opciones a la derecha ----------
  const burger = $("tb-burger");
  let panel: HTMLElement | null = null;
  let teardown = () => {};

  const closePanel = () => { teardown(); };

  const openPanel = () => {
    closePanel();
    const root = h("div", "hmenu");
    const cats = h("div", "hm-cats");
    const fly = h("div", "hm-fly");
    root.append(cats, fly);
    const rows: HTMLElement[] = [];

    const show = (i: number) => {
      rows.forEach((r, j) => r.classList.toggle("on", j === i));
      fly.replaceChildren();
      for (const e of opts.menus[i].items) {
        if (e === "sep") { fly.append(h("div", "ctx-sep")); continue; }
        const it = resolve(e);
        const row = h("div", "ctx-item" + (it.disabled ? " disabled" : ""));
        row.append(h("span", "", it.label));
        if (it.hint) row.append(h("kbd", "", it.hint));
        if (!it.disabled) row.onclick = () => { closePanel(); it.run(); };
        fly.append(row);
      }
    };

    opts.menus.forEach((m, i) => {
      const row = h("div", "hm-cat");
      row.append(h("span", "", m.label), h("span", "hm-chev", "›"));
      row.onmouseenter = () => show(i);
      row.onclick = () => show(i);
      rows.push(row);
      cats.append(row);
    });

    document.body.append(root);
    const r = burger.getBoundingClientRect();
    root.style.left = `${Math.max(6, r.left)}px`;
    root.style.top = `${r.bottom + 6}px`;
    burger.classList.add("open");
    panel = root;
    show(0);

    const onDown = (e: MouseEvent) => {
      if (!root.contains(e.target as Node) && !burger.contains(e.target as Node)) closePanel();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePanel(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", closePanel);
    teardown = () => {
      root.remove();
      burger.classList.remove("open");
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", closePanel);
      panel = null;
      teardown = () => {};
    };
  };

  burger.onclick = () => { if (panel) closePanel(); else openPanel(); };

  // ---------- Nombre del proyecto y navegación ----------
  $("tb-title").onclick = opts.onTitleClick;
  $("nav-back").onclick = opts.onBack;
  $("nav-fwd").onclick = opts.onForward;
  setNavState(false, false);
  setUnsaved(0);

  // ---------- Controles de ventana ----------
  const controls = $("win-controls");
  if (!inTauri) { controls.hidden = true; return; }
  const win = getCurrentWindow();
  const syncMax = async () => {
    try {
      const max = await win.isMaximized();
      $("win-max").classList.toggle("restored", max);
      $("win-max").title = max ? t("Restaurar") : t("Maximizar");
    } catch { /* sin permiso o sin ventana */ }
  };
  $("win-min").onclick = () => void win.minimize();
  $("win-max").onclick = () => void win.toggleMaximize().then(syncMax);
  $("win-close").onclick = () => void win.close();
  void win.onResized(() => void syncMax());
  void syncMax();

  // La barra se atenúa cuando la ventana pierde el foco.
  const tb = $("titlebar");
  window.addEventListener("blur", () => tb.classList.add("inactive"));
  window.addEventListener("focus", () => tb.classList.remove("inactive"));
}
