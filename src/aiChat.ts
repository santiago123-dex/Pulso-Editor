import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseInline, parseMarkdown } from "./aiMarkdown";
import { buildPrompt, chipLabels, type EditorContext } from "./aiContext";
import { emptyConversation, exitEvent, isAuthError, percent, planLabel, reduce, resetIn, toolSummary, userEvent, type AiEvent, type Block, type Conversation, type Turn } from "./aiModel";
import { chatsFor, deleteChat, loadChats, newChatId, saveChat, titleFrom, type SavedChat } from "./aiStore";
import { checkExternal } from "./docs";
import { refreshTree } from "./explorer";
import { activePath, focusedEditor } from "./groups";
import { agoFrom, relativeToTop } from "./historyModel";
import { refreshScm } from "./scm";
import { runInTerminal } from "./terminal";
import { setStatus, showDialog } from "./ui";
import { $, h, norm } from "./util";
import { ws } from "./workspace";
import { openExternal } from "./external";
import "./aiChat.css";

/**
 * Asistente de IA: conversa con Claude Code (la herramienta oficial) en la carpeta del proyecto. La herramienta usa la sesión de la
 * persona (su suscripción); Pulso solo le pasa el mensaje y pinta lo que va respondiendo. Ver docs/CHAT-IA.md.
 */
interface AiTool { installed: boolean; version: string; logged_in: boolean; auth_method: string; plan: string; error: string }
interface Live { id: string; convo: Conversation; cwd: string; title: string; /** La persona pulsó «Parar»: el proceso termina con error, pero no es un fallo. */ stopping?: boolean }

const MODELS: { value: string; label: string; hint: string }[] = [
  { value: "", label: "Predeterminado", hint: "El modelo que Claude Code usa por defecto en tu cuenta" },
  { value: "sonnet", label: "Sonnet", hint: "Equilibrado: rápido y capaz" },
  { value: "opus", label: "Opus", hint: "El más capaz; gasta más del límite de tu plan" },
  { value: "haiku", label: "Haiku", hint: "El más rápido y ligero" },
];

const lives = new Map<string, Live>();
let current: Live | null = null;
let tool: AiTool | null = null;
let toolAt = 0;
let shown = false;
let historyOpen = false;
let model = localStorage.getItem("pulso.ai.model") ?? "";
let mode: "read" | "edit" = localStorage.getItem("pulso.ai.mode") === "edit" ? "edit" : "read";
let useFile = true;
let useSel = true;
let lastFile = "";
let usage: Conversation["usage"] = (() => { try { return JSON.parse(localStorage.getItem("pulso.ai.usage") ?? "{}"); } catch { return {}; } })();

const FULL_KEY = "pulso.aiFull";
const isFull = () => localStorage.getItem(FULL_KEY) === "1";
const viewEl = () => $("view-ai");
const q = <T extends HTMLElement>(sel: string) => viewEl().querySelector<T>(sel);

const ICON_EXPAND = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_SHRINK = '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';

const iconBtn = (svg: string, title: string, cls = ""): HTMLButtonElement => {
  const b = h("button", `icon-btn ${cls}`.trim());
  b.type = "button"; b.title = title; b.setAttribute("aria-label", title); b.innerHTML = svg;
  return b;
};

// ---------- Conversaciones ----------
function fromSaved(c: SavedChat): Live {
  return { id: c.id, cwd: c.cwd, title: c.title, convo: { ...emptyConversation(), messages: c.messages, sessionId: c.sessionId, model: c.model, usage } };
}

function newLive(): Live {
  const live: Live = { id: newChatId(), convo: { ...emptyConversation(), usage }, cwd: ws.root ?? "", title: "Conversación nueva" };
  lives.set(live.id, live);
  return live;
}

function persist(live: Live) {
  if (!live.convo.messages.length) return;
  live.title = titleFrom(live.convo.messages);
  saveChat({ id: live.id, title: live.title, cwd: live.cwd, sessionId: live.convo.sessionId, model: live.convo.model, updatedAt: Date.now(), messages: live.convo.messages });
}

// ---------- Eventos de la herramienta ----------
let diskTimer = 0;
function refreshDisk() {
  window.clearTimeout(diskTimer);
  diskTimer = window.setTimeout(() => { void checkExternal(); void refreshTree(); void refreshScm(); }, 500);
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued || !shown) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; renderBody(); });
}

function apply(live: Live, ev: AiEvent) {
  const before = live.convo.touched;
  live.convo = reduce(live.convo, ev);
  if (live.convo.usage.fiveHour || live.convo.usage.sevenDay) {
    usage = live.convo.usage;
    try { localStorage.setItem("pulso.ai.usage", JSON.stringify(usage)); } catch { /* sin espacio */ }
  }
  if (live.convo.touched > before) refreshDisk();
  if (ev.type === "result" || ev.type === "pulso_exit") {
    persist(live);
    if (live.convo.touched) refreshDisk();
  }
  if (current === live) schedulePaint();
}

// ---------- Contexto del editor ----------
function editorContext(): EditorContext {
  const ctx: EditorContext = {};
  const p = activePath();
  if (p && useFile) ctx.file = (ws.root && relativeToTop(norm(p), ws.root)) || norm(p);
  const ed = focusedEditor();
  const sel = ed?.getSelection();
  const model = ed?.getModel();
  if (useSel && ed && sel && model && !sel.isEmpty() && model.uri.scheme === "file") {
    ctx.selection = { text: model.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
  }
  return ctx;
}

function renderChips() {
  const box = q(".ai-chips");
  if (!box) return;
  const labels = chipLabels(editorContext());
  const chip = (text: string, title: string, off: () => void) => {
    const c = h("span", "ai-chip");
    c.title = title;
    c.append(h("span", "", text));
    const x = h("button", "ai-chip-x", "×");
    x.type = "button"; x.title = "No adjuntar esto"; x.setAttribute("aria-label", `Quitar ${text}`);
    x.onclick = () => { off(); renderChips(); };
    c.append(x);
    return c;
  };
  const nodes: HTMLElement[] = [];
  if (labels.file) nodes.push(chip(labels.file, "Archivo abierto: se le dice a la IA cuál es", () => { useFile = false; }));
  if (labels.selection) nodes.push(chip(labels.selection, "Tu selección se envía a la IA con el mensaje", () => { useSel = false; }));
  box.replaceChildren(...nodes);
  box.hidden = !nodes.length;
}

// ---------- Pintado ----------
function copy(text: string) { void navigator.clipboard.writeText(text).then(() => setStatus("Copiado", 2000), () => setStatus("No se pudo copiar")); }

function inline(parent: HTMLElement, text: string) {
  for (const p of parseInline(text)) {
    if (p.kind === "code") parent.append(h("code", "ai-icode", p.text));
    else if (p.kind === "bold") parent.append(h("strong", "", p.text));
    else parent.append(document.createTextNode(p.text));
  }
}

function markdown(text: string): HTMLElement[] {
  return parseMarkdown(text).map((b) => {
    if (b.type === "code") {
      const box = h("div", "ai-code");
      const head = h("div", "ai-code-head");
      head.append(h("span", "", b.lang || "código"));
      const c = h("button", "ai-code-copy", "Copiar");
      c.type = "button";
      c.onclick = () => copy(b.text);
      head.append(c);
      const pre = h("pre", "");
      pre.append(h("code", "", b.text));
      box.append(head, pre);
      return box;
    }
    if (b.type === "h") { const e = h("div", `ai-h ai-h${b.level}`); inline(e, b.text); return e; }
    if (b.type === "li") { const e = h("div", "ai-li"); e.append(h("span", "ai-li-m", b.marker)); const t = h("span", "ai-li-t"); inline(t, b.text); e.append(t); return e; }
    const p = h("p", "ai-p");
    inline(p, b.text);
    return p;
  });
}

function toolRow(b: Extract<Block, { kind: "tool" }>): HTMLElement {
  const d = h("details", `ai-tool${b.error ? " err" : ""}`);
  const s = h("summary", "");
  const state = b.result === undefined ? "run" : b.error ? "bad" : "ok";
  s.append(h("span", `ai-tool-dot ${state}`), h("span", "ai-tool-text", toolSummary(b)));
  d.append(s);
  const detail = h("div", "ai-tool-detail");
  const input = Object.entries(b.input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  if (input) detail.append(h("pre", "", input.length > 1500 ? `${input.slice(0, 1500)}…` : input));
  if (b.result) detail.append(h("pre", "ai-tool-result", b.result.length > 1200 ? `${b.result.slice(0, 1200)}…` : b.result));
  d.append(detail);
  return d;
}

function turnNodes(t: Turn): HTMLElement[] {
  if (t.role === "user") {
    const u = h("div", "ai-user");
    u.append(h("div", "ai-user-text", t.blocks[0]?.kind === "text" ? t.blocks[0].text : ""));
    return [u];
  }
  const out: HTMLElement[] = [];
  for (const b of t.blocks) {
    if (!b) continue;
    if (b.kind === "text") { if (b.text.trim()) { const wrap = h("div", "ai-assistant"); wrap.append(...markdown(b.text)); out.push(wrap); } }
    else if (b.kind === "thinking") {
      if (!b.text.trim()) continue;
      const d = h("details", "ai-think");
      d.append(h("summary", "", "Razonamiento"), h("div", "ai-think-text", b.text));
      out.push(d);
    } else out.push(toolRow(b));
  }
  return out;
}

function usageText(): string {
  const parts: string[] = [];
  if (tool?.plan) parts.push(`Plan ${planLabel(tool.plan)}`);
  if (usage.fiveHour) parts.push(`sesión de 5 h: ${percent(usage.fiveHour)}${resetIn(usage.fiveHour) ? ` (se reinicia ${resetIn(usage.fiveHour)})` : ""}`);
  if (usage.sevenDay) parts.push(`semana: ${percent(usage.sevenDay)}`);
  return parts.join(" · ");
}

function renderFoot() {
  const foot = q(".ai-foot");
  if (!foot) return;
  const text = usageText();
  foot.replaceChildren();
  if (!text || (!usage.fiveHour && !usage.sevenDay)) { foot.append(h("span", "ai-foot-text", `${text ? `${text} · ` : ""}Usa tu sesión de Claude Code: el consumo cuenta en el límite de tu plan.`)); return; }
  const bars = h("span", "ai-meters");
  for (const w of [usage.fiveHour, usage.sevenDay]) {
    if (!w) continue;
    const m = h("span", "ai-meter");
    const f = h("span", `ai-meter-fill${w.utilization >= 0.9 ? " high" : ""}`);
    f.style.width = `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)}%`;
    m.append(f);
    bars.append(m);
  }
  foot.append(bars, h("span", "ai-foot-text", text));
}

function setupMessage(text: string, ...extra: HTMLElement[]): HTMLElement {
  const box = h("div", "ai-setup");
  box.append(h("p", "", text), ...extra);
  return box;
}

const EXAMPLES = ["Explica qué hace este archivo", "Busca posibles errores en lo que tengo abierto", "Propón pruebas para la selección"];

function renderBody() {
  const body = q(".ai-body");
  const compose = q(".ai-compose");
  if (!body || !compose) return;
  const sub = q(".ai-sub");
  if (sub) sub.textContent = tool?.installed ? `Claude Code${tool.version ? ` ${tool.version.split(" ")[0]}` : ""}${tool.plan ? ` · plan ${planLabel(tool.plan)}` : ""}` : "";
  renderFoot();
  const recheck = () => { toolAt = 0; void detect(true); };
  const ready = !!tool?.installed && tool.logged_in && !!ws.root;
  compose.hidden = !ready || historyOpen;
  q<HTMLElement>(".ai-bar")!.hidden = !ready || historyOpen;
  if (!tool) { body.replaceChildren(setupMessage("Comprobando Claude Code…")); return; }
  if (!tool.installed) {
    const again = h("button", "foot-btn foot-btn-line", "Volver a comprobar"); again.type = "button"; again.onclick = recheck;
    const guide = h("button", "foot-btn", "Cómo instalarlo"); guide.type = "button"; guide.onclick = () => void openExternal("https://claude.com/claude-code");
    body.replaceChildren(setupMessage("No encontré Claude Code en este equipo. Instálalo, inicia sesión con tu cuenta y pulsa «Volver a comprobar». El asistente usa tu suscripción; Pulso no guarda ninguna clave.", guide, again));
    return;
  }
  if (!tool.logged_in) {
    const login = h("button", "foot-btn foot-btn-line", "Iniciar sesión en la terminal"); login.type = "button";
    login.onclick = () => void runInTerminal("claude auth login");
    const again = h("button", "foot-btn", "Ya inicié sesión: volver a comprobar"); again.type = "button"; again.onclick = recheck;
    body.replaceChildren(setupMessage("Claude Code está instalado pero no hay una sesión iniciada. Se abrirá la terminal para que inicies sesión con tu cuenta.", login, again));
    return;
  }
  if (!ws.root) { body.replaceChildren(setupMessage("Abre una carpeta de proyecto: el asistente trabaja dentro de ella.")); return; }
  if (historyOpen) { renderHistory(body); return; }

  const live = current ?? (current = newLive());
  const c = live.convo;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const nodes: HTMLElement[] = [];
  if (!c.messages.length) {
    const empty = h("div", "ai-empty");
    empty.append(h("p", "", "Pregunta sobre tu código o pide un cambio. El asistente ve la carpeta abierta, el archivo que tienes delante y tu selección si la adjuntas."));
    for (const ex of EXAMPLES) {
      const b = h("button", "ai-example", ex); b.type = "button";
      b.onclick = () => { const t = q<HTMLTextAreaElement>(".ai-input")!; t.value = ex; t.focus(); autosize(); };
      empty.append(b);
    }
    nodes.push(empty);
  }
  for (const t of c.messages) nodes.push(...turnNodes(t));
  const last = c.messages[c.messages.length - 1];
  if (c.running && (!last || last.role === "user" || !last.done)) nodes.push(h("div", "ai-working", "Trabajando…"));
  if (c.error) {
    const e = h("div", "ai-error");
    e.append(h("div", "", c.error));
    if (isAuthError(c.error)) {
      const b = h("button", "foot-btn foot-btn-line", "Iniciar sesión en la terminal"); b.type = "button";
      b.onclick = () => void runInTerminal("claude auth login");
      e.append(b);
    }
    nodes.push(e);
  } else if (c.outcome?.ok && !c.running) {
    const secs = c.outcome.durationMs ? ` · ${(c.outcome.durationMs / 1000).toFixed(1).replace(".", ",")} s` : "";
    const o = h("div", "ai-outcome", `Listo${secs}`);
    if (c.outcome.denials) o.append(` · ${c.outcome.denials} acción${c.outcome.denials === 1 ? "" : "es"} no permitida${c.outcome.denials === 1 ? "" : "s"}${mode === "read" ? ": cambia a «Puede editar» si quieres que modifique archivos" : ""}`);
    nodes.push(o);
  }
  body.replaceChildren(...nodes);
  if (atBottom) body.scrollTop = body.scrollHeight;
  const send = q<HTMLButtonElement>(".ai-send")!;
  send.innerHTML = c.running ? ICON_STOP : ICON_SEND;
  send.title = c.running ? "Parar" : "Enviar (Enter)";
  send.setAttribute("aria-label", send.title);
  send.classList.toggle("stop", c.running);
  renderChips();
}

function renderHistory(body: HTMLElement) {
  const saved = chatsFor(loadChats(), ws.root ?? "");
  const rows: { id: string; title: string; when: number; running: boolean }[] = [];
  for (const l of lives.values()) if (l.convo.messages.length && l.cwd === ws.root) rows.push({ id: l.id, title: titleFrom(l.convo.messages), when: Date.now(), running: l.convo.running });
  for (const c of saved) if (!rows.some((r) => r.id === c.id)) rows.push({ id: c.id, title: c.title, when: c.updatedAt, running: false });
  rows.sort((a, b) => b.when - a.when);
  const nodes: HTMLElement[] = [h("div", "ai-hist-title", "Conversaciones de este proyecto")];
  if (!rows.length) nodes.push(h("div", "ai-hist-empty", "Aún no hay conversaciones guardadas."));
  for (const r of rows) {
    const row = h("div", "ai-hist-row");
    const open = h("button", "ai-hist-open"); open.type = "button";
    open.append(h("span", "ai-hist-name", r.title), h("span", "ai-hist-when", r.running ? "respondiendo…" : agoFrom(r.when)));
    open.onclick = () => {
      current = lives.get(r.id) ?? (() => { const l = fromSaved(saved.find((c) => c.id === r.id)!); lives.set(l.id, l); return l; })();
      historyOpen = false; renderBody();
    };
    const del = iconBtn('<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>', "Eliminar esta conversación", "ai-hist-del");
    del.onclick = () => { deleteChat(r.id); if (lives.get(r.id)?.convo.running) { void invoke("ai_stop", { id: r.id }); } lives.delete(r.id); if (current?.id === r.id) current = null; renderBody(); };
    row.append(open, del);
    nodes.push(row);
  }
  body.replaceChildren(...nodes);
}

// ---------- Acciones ----------
async function detect(force = false) {
  if (!force && tool && Date.now() - toolAt < 60_000) { renderBody(); return; }
  tool = null; renderBody();
  try { tool = await invoke<AiTool>("ai_detect"); }
  catch (e) { tool = { installed: false, version: "", logged_in: false, auth_method: "", plan: "", error: String(e) }; }
  toolAt = Date.now();
  if (shown) renderBody();
}

function autosize() {
  const t = q<HTMLTextAreaElement>(".ai-input");
  if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }
}

async function send() {
  const live = current;
  const input = q<HTMLTextAreaElement>(".ai-input");
  if (!live || !input || !ws.root) return;
  if (live.convo.running) { live.stopping = true; await invoke("ai_stop", { id: live.id }).catch(() => {}); return; }
  const text = input.value.trim();
  if (!text) return;
  const prompt = buildPrompt(text, editorContext());
  input.value = ""; autosize();
  live.cwd = ws.root;
  live.stopping = false;
  apply(live, userEvent(text));
  try {
    await invoke("ai_send", { id: live.id, cwd: ws.root, prompt, session: live.convo.sessionId || null, model: model || null, mode });
  } catch (e) {
    apply(live, exitEvent(1, String(e)));
  }
}

function newConversation() {
  if (current && !current.convo.messages.length) { historyOpen = false; renderBody(); return; }
  current = newLive();
  historyOpen = false;
  renderBody();
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

function applyMode() {
  const v = viewEl();
  v.classList.toggle("ai-full", isFull());
  v.classList.toggle("ai-docked", !isFull());
  const expand = q<HTMLElement>(".ai-expand");
  if (expand) { expand.title = isFull() ? "Volver a la barra lateral (Esc)" : "Pantalla completa"; expand.setAttribute("aria-label", expand.title); expand.innerHTML = isFull() ? ICON_SHRINK : ICON_EXPAND; }
}

function setFull(full: boolean) {
  localStorage.setItem(FULL_KEY, full ? "1" : "0");
  if (full) window.dispatchEvent(new CustomEvent("pulso-overlay", { detail: "ai" }));
  applyMode();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && isFull() && !document.querySelector(".modal")) { e.preventDefault(); e.stopPropagation(); setFull(false); }
}

async function chooseMode(next: "read" | "edit") {
  if (next === mode) return;
  if (next === "edit" && localStorage.getItem("pulso.ai.editOk") !== "1") {
    const r = await showDialog({
      title: "Permitir que la IA edite archivos",
      message: "Con «Puede editar», Claude Code podrá modificar y crear archivos de tu proyecto sin preguntar cada vez. Verás los cambios en el panel de Git y podrás descartarlos. Nunca se le permite ejecutar comandos desde aquí.",
      buttons: [{ label: "Cancelar", value: "cancel" }, { label: "Permitir editar", value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    localStorage.setItem("pulso.ai.editOk", "1");
  }
  mode = next;
  localStorage.setItem("pulso.ai.mode", mode);
  build();
}

// ---------- Construcción de la vista ----------
function build() {
  const root = viewEl();
  const keep = q<HTMLTextAreaElement>(".ai-input")?.value ?? "";
  const shell = h("div", "ai-shell");
  const head = h("div", "ai-head");
  const titles = h("div", "ai-titles");
  titles.append(h("span", "ai-title", "Asistente"), h("span", "ai-sub", ""));
  const tools = h("div", "ai-tools");
  const add = iconBtn(ICON_PLUS, "Nueva conversación"); add.onclick = newConversation;
  const hist = iconBtn(ICON_CLOCK, "Conversaciones anteriores"); hist.onclick = () => { historyOpen = !historyOpen; renderBody(); };
  const expand = iconBtn(ICON_EXPAND, "Pantalla completa", "ai-expand"); expand.onclick = () => setFull(!isFull());
  tools.append(add, hist, expand);
  head.append(titles, h("span", "grow"), tools);

  const bar = h("div", "ai-bar");
  const select = h("select", "ai-model");
  select.title = "Modelo";
  select.setAttribute("aria-label", "Modelo");
  for (const m of MODELS) { const o = h("option", "", m.label); o.value = m.value; o.title = m.hint; select.append(o); }
  select.value = model;
  select.onchange = () => { model = select.value; localStorage.setItem("pulso.ai.model", model); };
  const seg = h("div", "seg ai-mode");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", "Permisos");
  for (const [value, label, hint] of [["read", "Solo leer", "La IA puede leer y buscar en tu proyecto, pero no modificarlo"], ["edit", "Puede editar", "La IA puede editar y crear archivos sin preguntar. Nunca ejecuta comandos"]] as const) {
    const b = h("button", "", label); b.type = "button"; b.title = hint; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(mode === value));
    b.onclick = () => void chooseMode(value);
    seg.append(b);
  }
  bar.append(select, seg);

  const body = h("div", "ai-body");
  body.tabIndex = 0;
  body.setAttribute("role", "log");
  body.setAttribute("aria-label", "Conversación con la IA");

  const compose = h("form", "ai-compose");
  const chips = h("div", "ai-chips"); chips.hidden = true;
  const field = h("div", "ai-field");
  const input = h("textarea", "ai-input");
  input.rows = 1; input.placeholder = "Escribe tu mensaje…"; input.setAttribute("aria-label", "Mensaje para la IA"); input.value = keep;
  const sendBtn = h("button", "ai-send"); sendBtn.type = "submit"; sendBtn.innerHTML = ICON_SEND; sendBtn.title = "Enviar (Enter)"; sendBtn.setAttribute("aria-label", "Enviar");
  field.append(input, sendBtn);
  compose.append(chips, field);
  compose.onsubmit = (e) => { e.preventDefault(); void send(); };
  input.oninput = autosize;
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } };
  const foot = h("div", "ai-foot");
  shell.append(head, bar, body, compose, foot);
  root.replaceChildren(shell);
  applyMode();
  renderBody();
  autosize();
}

/** Lo llama el selector de vistas de la barra lateral. */
export function setAiVisible(visible: boolean) {
  shown = visible;
  window.removeEventListener("keydown", onKey, true);
  if (!visible) return;
  window.addEventListener("keydown", onKey, true);
  if (isFull()) window.dispatchEvent(new CustomEvent("pulso-overlay", { detail: "ai" }));
  if (!q(".ai-shell")) build(); else { applyMode(); renderBody(); }
  void detect();
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

export function initAi() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void listen<{ id: string; line: string }>("ai-line", (e) => {
    const live = lives.get(e.payload.id);
    if (!live) return;
    try { apply(live, JSON.parse(e.payload.line) as AiEvent); } catch { /* línea que no es JSON: se ignora */ }
  });
  void listen<{ id: string; code: number | null; stderr: string }>("ai-exit", (e) => {
    const live = lives.get(e.payload.id);
    if (live) apply(live, exitEvent(live.stopping ? null : e.payload.code, e.payload.stderr));
  });
  // El contexto adjunto sigue al editor: archivo y selección actuales.
  const attach = (ed: monaco.editor.ICodeEditor) => {
    ed.onDidChangeCursorSelection(() => { if (shown && ed === focusedEditor()) { useSel = true; renderChips(); } });
    ed.onDidFocusEditorText(() => { const p = activePath() ?? ""; if (p !== lastFile) { lastFile = p; useFile = true; } if (shown) renderChips(); });
  };
  monaco.editor.getEditors().forEach(attach);
  monaco.editor.onDidCreateEditor(attach);
  window.addEventListener("pulso-overlay", (e) => { if ((e as CustomEvent).detail === "board" && isFull()) setFull(false); });
}

/** «IA: Nueva conversación» desde la paleta. */
export const startNewConversation = () => { historyOpen = false; newConversation(); };
