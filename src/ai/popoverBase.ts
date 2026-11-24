/** Base de los popovers del panel: abrir, cerrar y el anillo de uso. */

import { h } from "../util";
import { S } from "./chatState";

// ---------- Popovers (Modelo + Esfuerzo y Uso real del plan) ----------
export function usageRing(ratioLeft: number, size = 14): HTMLElement {
  const clamped = Math.max(0, Math.min(1, ratioLeft));
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const tone = clamped <= 0.1 ? "low" : clamped <= 0.3 ? "warn" : "ok";
  const wrap = h("span", `ai-ring ${tone}`);
  wrap.style.width = wrap.style.height = `${size}px`;
  wrap.innerHTML = `<svg viewBox="0 0 18 18"><circle class="ai-ring-bg" cx="9" cy="9" r="${r}"/><circle class="ai-ring-fg" cx="9" cy="9" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - clamped)).toFixed(2)}"/></svg>`;
  return wrap;
}

export function dismissPopover() {
  if (!S.closePopover) return;
  const fn = S.closePopover;
  S.closePopover = null;
  fn();
}

export function openPopover(anchor: HTMLElement, pop: HTMLElement, placement: "below" | "above" = "below") {
  dismissPopover();
  document.body.append(pop);
  const ar = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(ar.left, window.innerWidth - pr.width - 8));
  const top = placement === "above" ? Math.max(8, ar.top - pr.height - 6) : Math.min(window.innerHeight - pr.height - 8, ar.bottom + 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const onDown = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) dismissPopover();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissPopover();
    }
  };
  const onBlur = () => dismissPopover();
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onBlur);
  S.closePopover = () => {
    pop.remove();
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onBlur);
  };
}
