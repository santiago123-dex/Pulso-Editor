/** Iconos SVG del asistente de IA y el botón de icono. */
import { h } from "../util";

export const ICON_EXPAND = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
export const ICON_SHRINK = '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
export const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
export const ICON_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>';
export const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';
export const ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
export const ICON_IMAGE =
  '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/></svg>';
export const PULSE_SVG =
  '<svg viewBox="0 0 44 14" aria-hidden="true"><path class="ai-pulse-base" d="M0 7h44"/><path class="ai-pulse-beat" d="M0 7h12l2.5-5 3.5 10 3-12 3 12 2.5-5H44"/></svg>';
export const ICON_GAUGE = '<svg viewBox="0 0 24 24"><path d="M12 14l4-4M4.93 17a9 9 0 1 1 14.14 0"/><path d="M7 17h10"/></svg>';
export const ICON_PALETTE =
  '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.7 1.8-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1a1.5 1.5 0 0 1 1.5-1.5h2A4.5 4.5 0 0 0 21 11.3C21 6.7 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/></svg>';

export const iconBtn = (svg: string, title: string, cls = ""): HTMLButtonElement => {
  const b = h("button", `icon-btn ${cls}`.trim());
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg;
  return b;
};
