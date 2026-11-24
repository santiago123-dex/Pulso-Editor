/** Pintado de los turnos de la conversación: herramientas, tarjeta de actividad y mensajes. */

import { type Block, type Turn, activitySummary, elapsedLabel, splitAssistantTurn, stepSummary, toolSummary } from "../aiModel";
import { openFile } from "../groups";
import { t as tr } from "../i18n";
import { h, norm } from "../util";
import { ws } from "../workspace";
import { ctl, isFull } from "./chatState";
import { PULSE_SVG } from "./icons";
import { openImageLightbox } from "./lightbox";
import { markdown } from "./markdownView";

// ---------- Pintado ----------
export function resolveToolFile(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const p = norm(raw.trim());
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith("/")) return p;
  return ws.root ? `${ws.root}/${p.replace(/^\.\//, "")}` : null;
}

export function toolRow(b: Extract<Block, { kind: "tool" }>): HTMLElement {
  const d = h("details", `ai-tool${b.error ? " err" : ""}`);
  const s = h("summary", "");
  const state = b.result === undefined ? "run" : b.error ? "bad" : "ok";
  s.append(h("span", `ai-tool-dot ${state}`), h("span", "ai-tool-text", toolSummary(b)));
  // Un subagente trabajando: en la línea se ve lo último que hizo, y al desplegar la tarjeta, todos sus pasos.
  const last = b.steps?.[b.steps.length - 1];
  if (last && state === "run") s.append(h("span", "ai-tool-live", `· ${stepSummary(last)}`));
  const filePath = resolveToolFile(b.input.file_path ?? b.input.notebook_path ?? b.input.path ?? b.input.Path ?? b.input.TargetFile);
  if (filePath && ["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"].includes(b.name)) {
    const open = h("button", "ai-tool-open", tr("Abrir"));
    open.type = "button";
    open.title = tr("Abrir {path}", { path: filePath });
    open.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFull()) ctl.setFull(false);
      void openFile(filePath);
    };
    s.append(open);
  }
  const chev = h("span", "ai-tool-chev");
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  s.append(chev);
  d.append(s);
  const detail = h("div", "ai-tool-detail");
  if (b.steps?.length) {
    const list = h("ol", "ai-subagent-steps");
    list.setAttribute("aria-label", tr("Pasos del subagente"));
    for (const st of b.steps) {
      const li = h("li", st.error ? "err" : "");
      li.append(h("span", `ai-step-dot ${st.error ? "bad" : "ok"}`), h("span", "", stepSummary(st)));
      list.append(li);
    }
    detail.append(list);
  }
  const input = Object.entries(b.input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  if (input) detail.append(h("pre", "", input.length > 1500 ? `${input.slice(0, 1500)}…` : input));
  if (b.result) detail.append(h("pre", "ai-tool-result", b.result.length > 1200 ? `${b.result.slice(0, 1200)}…` : b.result));
  d.append(detail);
  return d;
}

/** Tarjetas de actividad que la persona desplegó: se conservan al volver a pintar la conversación. */
export const openTraces = new Set<string>();
/** Cuándo empezó y terminó cada turno del asistente en esta sesión de Pulso (para «Trabajando · 12 s» y «Trabajó 40 s»). */
export const turnStartedAt = new Map<string, number>();
export const turnEndedAt = new Map<string, number>();
export let activityTimer = 0;
/** Momento del envío: la tarjeta de espera lo fija y la tarjeta real del turno lo hereda, para contar desde que la persona envió. */
export let waitingSince = 0;

/** Traza del pulso (el mismo gesto del logotipo): late mientras la IA trabaja y queda quieta al terminar. */

/** Mantiene vivo el contador de segundos de las tarjetas en curso sin volver a pintar la conversación. */
export function tickActivityClocks() {
  const live = document.querySelectorAll<HTMLElement>(".ai-activity.running .ai-act-time[data-start]");
  if (!live.length) {
    window.clearInterval(activityTimer);
    activityTimer = 0;
    return;
  }
  live.forEach((el) => {
    el.textContent = elapsedLabel(Date.now() - Number(el.dataset.start));
  });
}

export function activityItem(b: Block): HTMLElement {
  if (b.kind === "tool") {
    const row = h("div", "ai-act-item tool");
    row.append(toolRow(b));
    return row;
  }
  if (b.kind === "thinking") {
    const th = h("div", "ai-act-item thought");
    th.append(h("div", "ai-act-thought", b.text));
    return th;
  }
  if (b.kind === "image") return h("div", "ai-act-item note", b.name);
  const note = h("div", "ai-act-item note");
  note.append(...markdown(b.text));
  return note;
}

export function activityCard(turnId: string, items: Block[], running: boolean): HTMLElement {
  const started = turnStartedAt.get(turnId);
  if (running && !started) {
    const waiting = turnId.includes(":espera:");
    const since = waiting ? Date.now() : waitingSince || Date.now();
    turnStartedAt.set(turnId, since);
    waitingSince = waiting ? since : 0;
  }
  if (!running && started && !turnEndedAt.has(turnId)) turnEndedAt.set(turnId, Date.now());
  const t0 = turnStartedAt.get(turnId);
  const t1 = turnEndedAt.get(turnId);
  const { now, counts } = activitySummary(items, running);

  // Plegada por defecto: se ve que está trabajando, y el detalle solo si la persona lo despliega.
  const d = h("details", `ai-step-group ai-activity${running ? " running" : ""}`);
  if (openTraces.has(turnId)) d.open = true;
  d.ontoggle = () => {
    if (d.open) {
      if (openTraces.size >= 100) {
        const oldest = openTraces.values().next().value;
        if (oldest !== undefined) openTraces.delete(oldest);
      }
      openTraces.add(turnId);
    } else {
      openTraces.delete(turnId);
    }
  };

  const sum = h("summary", "ai-act-head");
  const pulse = h("span", "ai-act-pulse");
  pulse.innerHTML = PULSE_SVG;
  const title = h("span", "ai-act-title", running ? tr("Trabajando") : tr("Trabajó"));
  const time = h("span", "ai-act-time", "");
  if (running && t0) {
    time.dataset.start = String(t0);
    time.textContent = elapsedLabel(Date.now() - t0);
    if (!activityTimer) activityTimer = window.setInterval(tickActivityClocks, 1000);
  } else if (t0 && t1) {
    time.textContent = elapsedLabel(t1 - t0);
  }
  const detail = h("span", "ai-act-detail", running ? now : counts || `${items.length} pasos`);
  const more = h("span", "ai-act-more", items.length ? (d.open ? tr("Ocultar") : tr("Ver pasos")) : "");
  d.addEventListener("toggle", () => {
    more.textContent = items.length ? (d.open ? tr("Ocultar") : tr("Ver pasos")) : "";
  });
  sum.append(pulse, title, time, detail, more);
  if (!items.length) sum.classList.add("empty");
  d.append(sum);

  const body = h("div", "ai-act-body");
  for (const b of items) body.append(activityItem(b));
  d.append(body);
  return d;
}

export function turnNodes(t: Turn, _userNum = 0, isRunningTurn = false): HTMLElement[] {
  if (t.role === "user") {
    const u = h("div", "ai-user");
    const imgs = t.blocks.filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image");
    if (imgs.length) {
      const strip = h("div", "ai-user-images");
      for (const img of imgs) {
        const card = h("div", "ai-user-img");
        card.title = `${img.name} — ${tr("Clic para ampliar")}`;
        card.onclick = () => void openImageLightbox(img);
        if (img.preview) {
          const el = document.createElement("img");
          el.src = img.preview;
          el.alt = img.name;
          el.draggable = false;
          card.append(el);
        }
        card.append(h("span", "ai-user-img-name", img.name));
        strip.append(card);
      }
      u.append(strip);
    }
    const textBlock = t.blocks.find((b): b is Extract<Block, { kind: "text" }> => b.kind === "text");
    if (textBlock?.text) u.append(h("div", "ai-user-text", textBlock.text));
    return [u];
  }
  const { activity, final } = splitAssistantTurn(t.blocks);
  const out: HTMLElement[] = [];
  if (activity.length || isRunningTurn) out.push(activityCard(t.id, activity, isRunningTurn));
  if (final.trim()) {
    const wrap = h("div", "ai-assistant");
    wrap.append(...markdown(final));
    out.push(wrap);
  }
  return out;
}
