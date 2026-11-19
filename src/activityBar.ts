import {
  firstVisibleActivity,
  loadActivity,
  moveActivity,
  normalizeActivity,
  saveActivity,
  stepVisibleActivity,
  toggleActivityVisible,
  type ActivityConfig,
} from "./activityOrder";
import { quickPick, setStatus, showMenu, type MenuItem, type PickItem } from "./ui";
import { $ } from "./util";

const VIEW_LABELS: Record<string, string> = {
  explorer: "Explorador",
  search: "Buscar",
  git: "Control de código fuente",
  issues: "Issues de GitHub",
  ai: "Asistente de IA",
  prs: "Pull requests",
  chat: "Chat del equipo",
  problems: "Problemas",
};

interface Options {
  onSelect: (view: string) => void;
  activeView: () => string;
}

let barEl: HTMLElement | null = null;
let spacerEl: HTMLElement | null = null;
let defaults: string[] = [];
const buttons = new Map<string, HTMLElement>();
let cfg: ActivityConfig = { order: [], hidden: [] };
let opts: Options | null = null;

function labelOf(id: string): string {
  return VIEW_LABELS[id] ?? (buttons.get(id)?.getAttribute("aria-label") || buttons.get(id)?.title || id);
}

function visibleButtons(): HTMLElement[] {
  const hidden = new Set(cfg.hidden);
  return cfg.order
    .filter((id) => !hidden.has(id))
    .map((id) => buttons.get(id))
    .filter((b): b is HTMLElement => !!b);
}

function apply() {
  if (!barEl || !spacerEl) return;
  const hidden = new Set(cfg.hidden);
  for (const id of cfg.order) {
    const btn = buttons.get(id);
    if (!btn) continue;
    btn.hidden = hidden.has(id);
    barEl.insertBefore(btn, spacerEl);
  }
  const active = opts?.activeView();
  if (active && hidden.has(active)) {
    const fallback = firstVisibleActivity(cfg);
    if (fallback) opts?.onSelect(fallback);
  }
}

function commit(next: ActivityConfig) {
  cfg = normalizeActivity(next, defaults);
  saveActivity(cfg);
  apply();
}

function step(id: string, delta: -1 | 1) {
  const nextOrder = stepVisibleActivity(cfg, id, delta);
  if (nextOrder.every((x, i) => x === cfg.order[i])) return;
  commit({ ...cfg, order: nextOrder });
}

function openMenu(x: number, y: number, targetId: string | null) {
  const hidden = new Set(cfg.hidden);
  const vis = cfg.order.filter((id) => !hidden.has(id));
  const items: MenuItem[] = [];

  if (targetId && targetId !== "settings" && buttons.has(targetId)) {
    const pos = vis.indexOf(targetId);
    items.push(
      { label: "Mover arriba", hint: "Alt+↑", disabled: pos <= 0, run: () => step(targetId, -1) },
      { label: "Mover abajo", hint: "Alt+↓", disabled: pos < 0 || pos >= vis.length - 1, run: () => step(targetId, 1) },
      { label: "Ocultar de la barra", disabled: vis.length <= 1, run: () => commit(toggleActivityVisible(cfg, targetId)) },
      "sep",
    );
  }

  for (const id of cfg.order) {
    const isVis = !hidden.has(id);
    items.push({
      label: `${isVis ? "✓ " : "   "}${labelOf(id)}`,
      disabled: isVis && vis.length <= 1,
      run: () => commit(toggleActivityVisible(cfg, id)),
    });
  }

  items.push("sep", {
    label: "Restablecer orden predeterminado",
    run: () => resetActivityBar(),
  });

  showMenu(x, y, items);
}

/** Inicia la barra de actividad con arrastre, reordenación por teclado y menú contextual. */
export function initActivityBar(options: Options) {
  opts = options;
  barEl = $("activitybar");
  spacerEl = barEl.querySelector<HTMLElement>(".spacer");
  defaults = [];
  buttons.clear();

  const all = Array.from(barEl.querySelectorAll<HTMLElement>(".act[data-view]"));
  for (const btn of all) {
    const id = btn.dataset.view!;
    btn.draggable = false;
    btn.ondragstart = (e) => e.preventDefault();

    if (id === "settings") {
      btn.onclick = () => opts?.onSelect(id);
      continue;
    }

    defaults.push(id);
    buttons.set(id, btn);

    let justDragged = false;
    btn.onclick = () => {
      if (justDragged) { justDragged = false; return; }
      opts?.onSelect(id);
    };

    btn.onkeydown = (e) => {
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        step(id, e.key === "ArrowUp" ? -1 : 1);
        btn.focus();
      }
    };

    btn.onpointerdown = (down) => {
      if (down.button !== 0) return;
      const startY = down.clientY;
      let dragging = false;
      let dropTarget: { id: string; after: boolean; el: HTMLElement } | null = null;

      const clearMarkers = () => {
        for (const el of buttons.values()) el.classList.remove("drop-before", "drop-after");
      };

      const updateDrop = (clientY: number) => {
        clearMarkers();
        dropTarget = null;
        const vis = visibleButtons();
        for (const el of vis) {
          const r = el.getBoundingClientRect();
          if (clientY >= r.top && clientY <= r.bottom) {
            const after = clientY > r.top + r.height / 2;
            const tid = el.dataset.view!;
            if (tid !== id) {
              el.classList.add(after ? "drop-after" : "drop-before");
              dropTarget = { id: tid, after, el };
            }
            return;
          }
        }
        if (vis.length) {
          const first = vis[0];
          const last = vis[vis.length - 1];
          if (clientY < first.getBoundingClientRect().top && first.dataset.view !== id) {
            first.classList.add("drop-before");
            dropTarget = { id: first.dataset.view!, after: false, el: first };
          } else if (clientY > last.getBoundingClientRect().bottom && last.dataset.view !== id) {
            last.classList.add("drop-after");
            dropTarget = { id: last.dataset.view!, after: true, el: last };
          }
        }
      };

      const finish = (applyDrop: boolean) => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("keydown", onEsc, true);
        clearMarkers();
        btn.classList.remove("dragging");
        barEl?.classList.remove("act-reordering");
        if (dragging) {
          justDragged = true;
          window.setTimeout(() => { justDragged = false; }, 0);
          if (applyDrop && dropTarget) {
            const fromIdx = cfg.order.indexOf(id);
            let toIdx = cfg.order.indexOf(dropTarget.id) + (dropTarget.after ? 1 : 0);
            if (fromIdx >= 0 && fromIdx < toIdx) toIdx--;
            commit({ ...cfg, order: moveActivity(cfg.order, id, toIdx) });
          }
        }
      };

      const onMove = (e: PointerEvent) => {
        if (!dragging) {
          if (Math.abs(e.clientY - startY) < 6) return;
          dragging = true;
          btn.classList.add("dragging");
          barEl?.classList.add("act-reordering");
        }
        updateDrop(e.clientY);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onEsc = (e: KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("keydown", onEsc, true);
    };
  }

  barEl.oncontextmenu = (e) => {
    e.preventDefault();
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(".act[data-view]")?.dataset.view ?? null;
    openMenu(e.clientX, e.clientY, target);
  };

  cfg = loadActivity(defaults);
  apply();
}

export function resetActivityBar() {
  commit({ order: [...defaults], hidden: [] });
  setStatus("Barra lateral restablecida al orden predeterminado", 3000);
}

/** Selector rápido para mostrar/ocultar o restablecer botones desde la paleta de comandos. */
export function customizeActivityBar() {
  quickPick({
    placeholder: "Mostrar u ocultar un botón de la barra lateral (también puedes arrastrarlos)…",
    load: (): PickItem[] => {
      const hidden = new Set(cfg.hidden);
      const visCount = cfg.order.filter((id) => !hidden.has(id)).length;
      const items: PickItem[] = cfg.order.map((id) => {
        const isVis = !hidden.has(id);
        return {
          label: `${isVis ? "✓ " : "   "}${labelOf(id)}`,
          detail: isVis ? (visCount <= 1 ? "Visible (obligatorio)" : "Visible — clic para ocultar") : "Oculto — clic para mostrar",
          run: () => { commit(toggleActivityVisible(cfg, id)); },
        };
      });
      items.push({
        label: "Restablecer orden y visibilidad predeterminados",
        detail: "Vuelve al orden original",
        run: () => resetActivityBar(),
      });
      return items;
    },
  });
}
