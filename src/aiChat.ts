import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "./core/events";
import { readStorage, removeStorage } from "./core/storage";
import {
  EFFORTS, EXAMPLES, PROVIDERS, QUICK_PROMPTS,
  type AiModelInfo, type AiTool, type AllAiTools, type AntigravityBucket, type AntigravityUsage, type CodexQuota, type ExtraUsage, type ModelOption, type ProviderMeta, type WindowQuota,
} from "./ai/catalog";
import { applyAiAppearance, buildAppearancePopover } from "./ai/appearance";
import { parseInline, parseMarkdown } from "./aiMarkdown";
import { buildPrompt, chipLabels, type EditorContext } from "./aiContext";
import {
  createProviderNormalizer, emptyConversation, exitEvent, formatModelName, isAuthError, needsCommandPermission, parseUsageText, planLabel, pruneUsage,
  reduce, remainingPercent, remainingRatio, resetClockText, resetCountdown, resetIn, resetTimeFromIso, toolSummary, touchedFiles,
  userEvent, type AiEvent, type AiProvider, type Block, type Conversation, type DeniedAction, type Turn, type UsageWindow,
} from "./aiModel";
import { chatsFor, deleteChat, flushHistoryNow, initHistory, loadChats, newChatId, saveChat, titleFrom, type SavedChat } from "./aiStore";
import { checkExternal } from "./docs";
import { refreshTree } from "./explorer";
import { activePath, focusedEditor, openFile } from "./groups";
import { agoFrom, relativeToTop } from "./historyModel";
import { refreshScm } from "./scm";
import { state } from "./settings";
import { listShells, runInTerminal } from "./terminal";
import { promptText, quickPick, setStatus, showDialog, type PickItem } from "./ui";
import { $, baseName, dirName, h, norm } from "./util";
import { rel, ws } from "./workspace";
import { openExternal } from "./external";
import { extractProposedEdits } from "./workflow/issueWorkflowModel";
import { clearActiveIssueWork, createPrForActiveIssue, getActiveIssueWork, reviewProposedEdit } from "./workflow/issueWorkflow";
import "./aiChat.css";

/**
 * Asistente de IA: conversa en la carpeta del proyecto con Claude Code, ChatGPT/Codex (`codex app-server`) o Antigravity (`agy`).
 * Pulso nunca ve ni guarda credenciales; cada herramienta administra su propia sesión.
 */
interface Live { id: string; provider: AiProvider; normalize: (ev: AiEvent) => AiEvent[]; convo: Conversation; cwd: string; title: string; stopping?: boolean }

// v2: la clave anterior pudo quedar con cifras de pruebas; se ignora y se borra al arrancar.
const USAGE_KEY = "pulso.ai.usage.v2";
const USAGE_SIG_KEY = "pulso.ai.usageSig";
const FULL_KEY = "pulso.aiFull";

function readStoredUsage(): Conversation["usage"] {
  try {
    removeStorage("pulso.ai.usage");
    const raw = JSON.parse(readStorage(USAGE_KEY) ?? "{}");
    return pruneUsage(raw);
  } catch {
    return {};
  }
}

function savedProvider(): AiProvider {
  const p = readStorage("pulso.ai.provider");
  if (p === "codex") return "codex";
  if (p === "antigravity" || p === "gemini") return "antigravity";
  return "claude";
}

const lives = new Map<string, Live>();
let activeProvider: AiProvider = savedProvider();
let current: Live | null = null;
const tools: Record<AiProvider, AiTool | null> = { claude: null, codex: null, antigravity: null };
let tool: AiTool | null = null;
let toolAt = 0;
let detectInFlight: Promise<void> | null = null;
let usageInFlight: Promise<boolean> | null = null;
let usageSyncing = false;
let usageError = "";
let shown = false;
let historyOpen = false;
type AiMode = "read" | "edit" | "full";
function savedMode(): AiMode {
  const m = localStorage.getItem("pulso.ai.mode");
  if (m === "full" || m === "edit") return m;
  return "read";
}
let model = localStorage.getItem(PROVIDERS[activeProvider].modelKey) ?? "";
let effort = localStorage.getItem("pulso.ai.effort") ?? "";
let mode: AiMode = savedMode();
let useFile = true;
let useSel = true;
let extraFiles: string[] = [];
let lastFile = "";
let usage: Conversation["usage"] = readStoredUsage();
let closePopover: (() => void) | null = null;
let loginWatchTimer = 0;
let awaitingLogin = false;
let loginProvider: AiProvider = activeProvider;

function switchProvider(next: AiProvider) {
  if (activeProvider === next && tool === tools[next]) return;
  activeProvider = next;
  localStorage.setItem("pulso.ai.provider", next);
  model = localStorage.getItem(PROVIDERS[next].modelKey) ?? "";
  tool = tools[next];
  if (current) {
    if (!current.convo.messages.length) {
      current.provider = next;
      current.normalize = createProviderNormalizer(next, model);
    } else if (current.provider !== next) {
      current = newLive();
    }
  }
  if (!tool) void detect(true);
  if (shown) renderBody();
}

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

const LEGACY_CODEX = /\blegacy\b|previous generation/i;

/** «Gemini 4 Hydrogen (High)» → { name: «Gemini 4 Hydrogen», tier: «High» }. */
function splitLabelLevel(raw: string): { name: string; tier: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(raw.trim());
  if (m && /^(Low|Medium|High|XHigh|Max)$/i.test(m[2])) {
    return { name: m[1].trim(), tier: m[2].trim() };
  }
  return { name: raw.trim(), tier: "" };
}

function titleFromId(id: string): string {
  return id.split("-").map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(" ");
}

function tierFromNote(note: string): string {
  if (/legacy/i.test(note)) return "Legado";
  if (/previous generation/i.test(note)) return "Anterior";
  if (/most capable|complex/i.test(note)) return "Más capaz";
  if (/affordable|easier|simpler/i.test(note)) return "Ligero";
  if (/visual/i.test(note)) return "Visión";
  if (/fast|go-to/i.test(note)) return "Rápido";
  if (/^(Low|Medium|High|XHigh|Max)$/i.test(note)) return note;
  return "Disponible";
}

function providerCatalog(prov: AiProvider): { models: ModelOption[]; specific: ModelOption[] } {
  const meta = PROVIDERS[prov];
  if (prov === "claude") return { models: meta.models, specific: meta.specific };
  const detected = tools[prov]?.models ?? [];
  const toOption = (d: AiModelInfo): ModelOption => {
    const rawLabel = d.label || titleFromId(d.id);
    const { name, tier } = splitLabelLevel(rawLabel);
    const isNew = prov === "antigravity" ? /gemini-4|opus-5-5|sonnet-5-5|orchestrator/i.test(d.id) : /gpt-6|new|preview/i.test(d.id);
    return {
      value: d.id,
      label: name,
      tier: tier || tierFromNote(d.note),
      badge: /preview/i.test(d.id) ? "Preview" : isNew ? "Nuevo" : undefined,
      hint: d.note ? `${d.id} · ${d.note}` : d.id,
    };
  };
  if (prov === "codex") {
    return {
      models: [...meta.models, ...detected.filter((d) => !LEGACY_CODEX.test(d.note)).map(toOption)],
      specific: detected.filter((d) => LEGACY_CODEX.test(d.note)).map(toOption),
    };
  }
  // Antigravity: muestra TODOS los modelos reales directamente en la lista principal (sin ocultarlos).
  return {
    models: [...meta.models, ...detected.map(toOption)],
    specific: [],
  };
}

function findModelOption(val: string, prov: AiProvider = activeProvider): ModelOption {
  const cat = providerCatalog(prov);
  return cat.models.find((m) => m.value === val)
    ?? cat.specific.find((m) => m.value === val)
    ?? { value: val, label: formatModelName(val) || val, tier: "Personalizado", hint: `Modelo específico: ${val}` };
}

function modelButtonText(): string {
  const prov = current?.convo.messages.length ? current.provider : activeProvider;
  const active = findModelOption(model, prov);
  const resolved = current?.convo.model;
  const base = !model && resolved ? formatModelName(resolved) : active.label;
  const fixedLevel = prov === "antigravity" && model ? active.tier : "";
  const eff = fixedLevel || (PROVIDERS[prov].supportsEffort ? EFFORTS.find((e) => e.value === effort)?.short : "");
  const prefix = prov === "claude" ? "" : `${PROVIDERS[prov].short} · `;
  return `${prefix}${eff ? `${base} · ${eff}` : base}`;
}

function syncModelButton() {
  const label = q(".ai-model-btn-label");
  if (label) label.textContent = modelButtonText();
}

// ---------- Conversaciones ----------
function fromSaved(c: SavedChat): Live {
  const rawProv = c.provider as string | undefined;
  const prov: AiProvider = rawProv === "codex" ? "codex" : rawProv === "antigravity" || rawProv === "gemini" ? "antigravity" : "claude";
  return { id: c.id, provider: prov, normalize: createProviderNormalizer(prov, c.model || ""), cwd: c.cwd, title: c.title, convo: { ...emptyConversation(), messages: c.messages, sessionId: c.sessionId, model: c.model, usage: prov === "claude" ? usage : {} } };
}

function newLive(): Live {
  const live: Live = { id: newChatId(), provider: activeProvider, normalize: createProviderNormalizer(activeProvider, model), convo: { ...emptyConversation(), usage: activeProvider === "claude" ? usage : {} }, cwd: ws.root ?? "", title: "Conversación nueva" };
  lives.set(live.id, live);
  return live;
}

function persist(live: Live, flushNow = false) {
  if (!live.convo.messages.length) return;
  live.title = titleFrom(live.convo.messages);
  saveChat({ id: live.id, title: live.title, cwd: live.cwd, sessionId: live.convo.sessionId, model: live.convo.model, provider: live.provider, updatedAt: Date.now(), messages: live.convo.messages });
  if (flushNow) flushHistoryNow();
}

const INTERRUPTED_KEY = "pulso.ai.interrupted";

function saveRunningBeforeExit() {
  let active: Live | null = null;
  for (const l of lives.values()) {
    if (!l.convo.messages.length) continue;
    persist(l);
    if (l.convo.running && (!active || l === current)) active = l;
  }
  try {
    if (active) localStorage.setItem(INTERRUPTED_KEY, JSON.stringify({ id: active.id, cwd: active.cwd }));
    else localStorage.removeItem(INTERRUPTED_KEY);
  } catch { /* sin acceso */ }
  flushHistoryNow();
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

let codexUsage: Conversation["usage"] = {};
let agyUsage: AntigravityUsage | null = null;
let extraUsageInFlight: Promise<boolean> | null = null;

function agyWindowFromBucket(b: AntigravityBucket): UsageWindow {
  return { utilization: 1 - Math.max(0, Math.min(1, b.remaining_fraction)), resetsAt: resetTimeFromIso(b.reset_time) };
}

function agyPrimaryUsage(): Conversation["usage"] {
  const g = agyUsage?.groups?.[0];
  if (!g) return {};
  const five = g.buckets.find((b) => b.window === "5h");
  const week = g.buckets.find((b) => b.window === "weekly");
  return pruneUsage({
    fiveHour: five ? agyWindowFromBucket(five) : undefined,
    sevenDay: week ? agyWindowFromBucket(week) : undefined,
  });
}

function refreshExtraUsage(): Promise<boolean> {
  if (extraUsageInFlight) return extraUsageInFlight;
  extraUsageInFlight = (async () => {
    try {
      const res = await invoke<ExtraUsage>("ai_extra_usage");
      if (res.codex) {
        codexUsage = pruneUsage({
          fiveHour: res.codex.five_hour ? { utilization: res.codex.five_hour.used_percent / 100, resetsAt: res.codex.five_hour.resets_at } : undefined,
          sevenDay: res.codex.seven_day ? { utilization: res.codex.seven_day.used_percent / 100, resetsAt: res.codex.seven_day.resets_at } : undefined,
        });
        if (res.codex.plan && tools.codex && tools.codex.auth_method !== "api_key") {
          tools.codex.plan = res.codex.plan;
        }
      }
      if (res.antigravity) agyUsage = res.antigravity;
      if (shown) syncTelemetryViews();
      return !!(res.codex || res.antigravity);
    } catch {
      return false;
    } finally {
      extraUsageInFlight = null;
    }
  })();
  return extraUsageInFlight;
}

function providerUsage(prov: AiProvider = activeProvider): Conversation["usage"] {
  if (prov === "claude") { usage = pruneUsage(usage); return usage; }
  if (prov === "codex") { codexUsage = pruneUsage(codexUsage); return codexUsage; }
  return agyPrimaryUsage();
}

function saveUsage(u: Conversation["usage"]) {
  usage = pruneUsage(u);
  usageError = "";
  const claudeTool = tools.claude ?? tool;
  if (claudeTool?.version.includes("falso")) return; // la herramienta de pruebas nunca deja cifras guardadas
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
    if (claudeTool) localStorage.setItem(USAGE_SIG_KEY, `${claudeTool.auth_method}:${claudeTool.plan}`);
  } catch { /* sin espacio */ }
}

/** Pide a Claude Code el uso real del plan (`/usage`): no gasta cuota ni toca credenciales. */
function refreshUsage(): Promise<boolean> {
  if (activeProvider !== "claude") return Promise.resolve(false);
  if (usageInFlight) return usageInFlight;
  usageSyncing = true;
  usageError = "";
  if (shown) syncTelemetryViews();
  usageInFlight = (async () => {
    try {
      const next = parseUsageText(await invoke<string>("ai_usage"));
      if (!next.fiveHour && !next.sevenDay) {
        usageError = "La CLI no devolvió ventanas de uso reconocibles.";
        return false;
      }
      saveUsage(next);
      return true;
    } catch (e) {
      usageError = e instanceof Error ? e.message : String(e || "No se pudo consultar /usage.");
      return false;
    } finally {
      usageSyncing = false;
      usageInFlight = null;
      if (shown) syncTelemetryViews();
    }
  })();
  return usageInFlight;
}

let lastPersistAt = 0;

function apply(live: Live, ev: AiEvent) {
  const before = live.convo.touched;
  live.convo = reduce(live.convo, ev);
  if (live.convo.usage.fiveHour || live.convo.usage.sevenDay) {
    if (live.provider === "claude") saveUsage(live.convo.usage);
    else if (live.provider === "codex") codexUsage = pruneUsage(live.convo.usage);
  }
  if (live.convo.touched > before) refreshDisk();
  const now = Date.now();
  if (ev.type === "result" || ev.type === "pulso_exit") {
    lastPersistAt = now;
    persist(live, true);
    try { localStorage.removeItem(INTERRUPTED_KEY); } catch { /* sin acceso */ }
    if (live.convo.touched) refreshDisk();
    if (live.provider !== "claude") void refreshExtraUsage();
  } else if (ev.type === "pulso_user" || ev.type === "system" || now - lastPersistAt >= 1200) {
    lastPersistAt = now;
    persist(live);
  }
  if (current === live) schedulePaint();
}

// ---------- Contexto del editor ----------
function editorContext(): EditorContext {
  const ctx: EditorContext = {};
  const p = activePath();
  if (p && useFile) ctx.file = (ws.root && relativeToTop(norm(p), ws.root)) || norm(p);
  if (extraFiles.length) ctx.extraFiles = [...extraFiles];
  const ed = focusedEditor();
  const sel = ed?.getSelection();
  const edModel = ed?.getModel();
  if (useSel && ed && sel && edModel && !sel.isEmpty() && edModel.uri.scheme === "file") {
    ctx.selection = { text: edModel.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
  }
  return ctx;
}

function renderChips() {
  const box = q(".ai-chips");
  if (!box) return;
  const ctx = editorContext();
  const labels = chipLabels(ctx);
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
  for (const extra of extraFiles) {
    if (extra === ctx.file) continue;
    nodes.push(chip(baseName(extra), `Archivo adjunto: ${extra}`, () => { extraFiles = extraFiles.filter((f) => f !== extra); }));
  }
  if (labels.selection) nodes.push(chip(labels.selection, "Tu selección se envía a la IA con el mensaje", () => { useSel = false; }));
  box.replaceChildren(...nodes);
  box.hidden = !nodes.length;
  const ctxWrap = q(".ai-dock-ctx");
  if (ctxWrap) ctxWrap.hidden = !nodes.length;
  const scopeBox = q(".ai-scope-strip");
  if (scopeBox) fillScopeStrip(scopeBox, ctx);
}

// ---------- Pintado ----------
function copy(text: string, btn?: HTMLButtonElement) {
  void navigator.clipboard.writeText(text).then(() => {
    setStatus("Copiado", 2000);
    if (!btn) return;
    const prev = btn.textContent ?? "Copiar";
    btn.textContent = "Copiado";
    btn.classList.add("copied");
    window.setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
  }, () => setStatus("No se pudo copiar"));
}

function insertCode(text: string) {
  const ed = focusedEditor();
  const sel = ed?.getSelection();
  if (!ed || !sel) { setStatus("Abre un archivo en el editor para insertar el código"); return; }
  if (isFull()) setFull(false);
  ed.executeEdits("pulso-ai", [{ range: sel, text, forceMoveMarkers: true }]);
  ed.focus();
  setStatus("Código insertado en el editor", 2500);
}

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
      const acts = h("div", "ai-code-acts");
      if (focusedEditor()) {
        const ins = h("button", "ai-code-copy", "Insertar");
        ins.type = "button";
        ins.title = "Insertar en la posición actual del editor";
        ins.onclick = () => insertCode(b.text);
        acts.append(ins);
      }
      const c = h("button", "ai-code-copy", "Copiar");
      c.type = "button";
      c.onclick = () => copy(b.text, c);
      acts.append(c);
      head.append(acts);
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

function resolveToolFile(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const p = norm(raw.trim());
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith("/")) return p;
  return ws.root ? `${ws.root}/${p.replace(/^\.\//, "")}` : null;
}

function toolRow(b: Extract<Block, { kind: "tool" }>): HTMLElement {
  const d = h("details", `ai-tool${b.error ? " err" : ""}`);
  const s = h("summary", "");
  const state = b.result === undefined ? "run" : b.error ? "bad" : "ok";
  s.append(h("span", `ai-tool-dot ${state}`), h("span", "ai-tool-text", toolSummary(b)));
  const filePath = resolveToolFile(b.input.file_path ?? b.input.notebook_path ?? b.input.path ?? b.input.Path ?? b.input.TargetFile);
  if (filePath && ["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"].includes(b.name)) {
    const open = h("button", "ai-tool-open", "Abrir");
    open.type = "button";
    open.title = `Abrir ${filePath}`;
    open.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFull()) setFull(false);
      void openFile(filePath);
    };
    s.append(open);
  }
  const chev = h("span", "ai-tool-chev");
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  s.append(chev);
  d.append(s);
  const detail = h("div", "ai-tool-detail");
  const input = Object.entries(b.input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  if (input) detail.append(h("pre", "", input.length > 1500 ? `${input.slice(0, 1500)}…` : input));
  if (b.result) detail.append(h("pre", "ai-tool-result", b.result.length > 1200 ? `${b.result.slice(0, 1200)}…` : b.result));
  d.append(detail);
  return d;
}

const openTraces = new Set<string>();

function traceLabel(items: Block[], running: boolean): { title: string; live: string } {
  let reads = 0; let edits = 0; let searches = 0; let cmds = 0; let thoughts = 0; let lastAction = "";
  for (const b of items) {
    if (b.kind === "thinking") { thoughts++; continue; }
    if (b.kind !== "tool") continue;
    lastAction = toolSummary(b);
    if (b.name === "Read") reads++;
    else if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(b.name)) edits++;
    else if (["Glob", "Grep", "WebSearch", "WebFetch"].includes(b.name)) searches++;
    else if (b.name === "Command" || b.name === "Bash") cmds++;
  }
  const tools = reads + edits + searches + cmds;
  if (running) {
    const stepNoun = tools > 0 ? ` · ${tools} ${tools === 1 ? "paso" : "pasos"}` : "";
    return { title: "Pensando", live: lastAction ? `${lastAction}${stepNoun}` : "Analizando tu solicitud…" };
  }
  const parts: string[] = [];
  if (reads) parts.push(`${reads} ${reads === 1 ? "archivo leído" : "archivos leídos"}`);
  if (edits) parts.push(`${edits} ${edits === 1 ? "edición" : "ediciones"}`);
  if (searches) parts.push(`${searches} ${searches === 1 ? "búsqueda" : "búsquedas"}`);
  if (cmds) parts.push(`${cmds} ${cmds === 1 ? "comando" : "comandos"}`);
  if (!parts.length && thoughts) return { title: "Pensó", live: "Razonamiento interno" };
  return { title: parts.length ? "Pensó y exploró" : "Pasos", live: parts.join(" · ") || `${items.length} pasos` };
}

function stepGroup(traceKey: string, items: Block[], running: boolean): HTMLElement {
  const { title, live } = traceLabel(items, running);
  const d = h("details", `ai-step-group${running ? " running" : ""}`);
  if (openTraces.has(traceKey)) d.open = true;
  d.ontoggle = () => {
    if (d.open) {
      if (openTraces.size >= 100) {
        const oldest = openTraces.values().next().value;
        if (oldest !== undefined) openTraces.delete(oldest);
      }
      openTraces.add(traceKey);
    } else {
      openTraces.delete(traceKey);
    }
  };

  const sum = h("summary", "ai-step-summary");
  const orb = h("span", `ai-step-orb${running ? " pulse" : ""}`);
  const main = h("span", "ai-step-main");
  main.append(h("span", "ai-step-title", title));
  if (live) main.append(h("span", "ai-step-live", live));
  const chev = h("span", "ai-tool-chev");
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  sum.append(orb, main, chev);
  d.append(sum);

  const body = h("div", "ai-step-body");
  for (const b of items) {
    if (b.kind === "thinking") {
      const th = h("div", "ai-step-thought");
      th.append(h("div", "ai-step-thought-lbl", "Razonamiento"), h("div", "ai-step-thought-text", b.text));
      body.append(th);
    } else if (b.kind === "tool") {
      body.append(toolRow(b));
    }
  }
  d.append(body);
  return d;
}

function turnNodes(t: Turn, userNum = 0, isRunningTurn = false): HTMLElement[] {
  if (t.role === "user") {
    const u = h("div", "ai-user");
    const tag = userNum > 0 ? `#${String(userNum).padStart(2, "0")} · TÚ` : "Tú";
    u.append(h("div", "ai-user-tag", tag), h("div", "ai-user-text", t.blocks[0]?.kind === "text" ? t.blocks[0].text : ""));
    return [u];
  }
  const out: HTMLElement[] = [];
  let buf: Block[] = [];
  let traceSeq = 0;

  const flushTrace = (trailing: boolean) => {
    if (!buf.length) return;
    const key = `${t.id}:${traceSeq++}`;
    const hasOpenTool = buf.some((b) => b.kind === "tool" && b.result === undefined);
    out.push(stepGroup(key, buf, isRunningTurn && (trailing || hasOpenTool)));
    buf = [];
  };

  for (let i = 0; i < t.blocks.length; i++) {
    const b = t.blocks[i];
    if (!b) continue;
    if (b.kind === "text") {
      if (b.text.trim()) {
        flushTrace(false);
        const wrap = h("div", "ai-assistant");
        wrap.append(...markdown(b.text));
        out.push(wrap);
      }
    } else if (b.kind === "thinking") {
      if (b.text.trim()) buf.push(b);
    } else {
      buf.push(b);
    }
  }
  flushTrace(true);
  return out;
}

// ---------- Popovers (Modelo + Esfuerzo y Uso real del plan) ----------
function usageRing(ratioLeft: number, size = 14): HTMLElement {
  const clamped = Math.max(0, Math.min(1, ratioLeft));
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const tone = clamped <= 0.1 ? "low" : clamped <= 0.3 ? "warn" : "ok";
  const wrap = h("span", `ai-ring ${tone}`);
  wrap.style.width = wrap.style.height = `${size}px`;
  wrap.innerHTML = `<svg viewBox="0 0 18 18"><circle class="ai-ring-bg" cx="9" cy="9" r="${r}"/><circle class="ai-ring-fg" cx="9" cy="9" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - clamped)).toFixed(2)}"/></svg>`;
  return wrap;
}

function dismissPopover() {
  if (!closePopover) return;
  const fn = closePopover;
  closePopover = null;
  fn();
}

function openPopover(anchor: HTMLElement, pop: HTMLElement, placement: "below" | "above" = "below") {
  dismissPopover();
  document.body.append(pop);
  const ar = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(ar.left, window.innerWidth - pr.width - 8));
  const top = placement === "above"
    ? Math.max(8, ar.top - pr.height - 6)
    : Math.min(window.innerHeight - pr.height - 8, ar.bottom + 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const onDown = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) dismissPopover();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismissPopover(); }
  };
  const onBlur = () => dismissPopover();
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onBlur);
  closePopover = () => {
    pop.remove();
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onBlur);
  };
}

function buildProviderTabs(onPick?: (p: AiProvider) => void): HTMLElement {
  const bar = h("div", "ai-prov-tabs");
  for (const id of ["claude", "codex", "antigravity"] as const) {
    const t = tools[id];
    const dotCls = t?.logged_in ? "on" : t?.installed ? "wait" : "off";
    const btn = h("button", `ai-prov-tab${activeProvider === id ? " active" : ""}`);
    btn.type = "button";
    btn.title = t?.logged_in ? `${PROVIDERS[id].title} conectado` : t?.installed ? `${PROVIDERS[id].title}: falta iniciar sesión` : `${PROVIDERS[id].title}: sin instalar`;
    btn.append(h("span", `ai-prov-dot ${dotCls}`, ""), h("span", "", PROVIDERS[id].short));
    btn.onclick = () => {
      switchProvider(id);
      onPick?.(id);
    };
    bar.append(btn);
  }
  return bar;
}

function accountStatusText(id: AiProvider, t: AiTool | null): string {
  if (!t) return "Comprobando sesión…";
  const meta = PROVIDERS[id];
  const installable = !!(meta.npmPkg || meta.installCmdPs);
  if (!t.installed) return installable ? "CLI sin instalar · instalable aquí" : "CLI sin instalar";
  if (!t.logged_in) return "Instalado · falta iniciar sesión";
  if (id === "claude") return t.plan ? `Conectado · Plan ${planLabel(t.plan)}` : "Conectado · Suscripción Claude";
  if (id === "codex") {
    if (t.auth_method === "chatgpt") return t.plan && t.plan !== "ChatGPT" ? `Conectado · Plan ${planLabel(t.plan)}` : "Conectado · Suscripción ChatGPT";
    if (t.auth_method === "api_key") return "Conectado · Clave API";
    return "Conectado · ChatGPT";
  }
  return "Conectado · Cuenta Antigravity";
}

async function installAndConnect(prov: AiProvider, onDone?: () => void) {
  const meta = PROVIDERS[prov];
  const shells = await listShells().catch(() => []);
  const sh = shells.find((s) => s.id === state.settings.terminalShell) ?? shells[0];
  const ps = sh ? /powershell|pwsh/i.test(`${sh.id} ${sh.path}`) : true;
  let cmd = "";
  if (meta.installCmdPs || meta.installCmdSh) {
    cmd = ps ? (meta.installCmdPs ?? meta.installCmdSh ?? "") : (meta.installCmdSh ?? meta.installCmdPs ?? "");
    if (cmd && meta.loginCmd) {
      cmd = ps
        ? `${cmd}; if ($?) { $agy = "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"; if (Test-Path $agy) { & $agy acp --login } }`
        : `${cmd} && ${meta.loginCmd}`;
    }
  } else if (meta.npmPkg) {
    cmd = ps
      ? `npm install -g ${meta.npmPkg}; if ($?) { ${meta.loginCmd} }`
      : `npm install -g ${meta.npmPkg} && ${meta.loginCmd}`;
  }
  if (!cmd) { void openExternal(meta.docsUrl); return; }
  const r = await showDialog({
    title: `Instalar y conectar ${meta.accountTitle}`,
    message: `Se ejecutará en la terminal integrada:\n${cmd}\n\nPulso no pide ni guarda claves: iniciarás sesión directamente en la herramienta oficial.`,
    buttons: [{ label: "Cancelar", value: "cancel" }, { label: "Instalar y conectar", value: "ok", primary: true }],
  });
  if (r !== "ok") return;
  onDone?.();
  switchProvider(prov);
  watchLogin(prov, 1000);
  void runInTerminal(cmd);
}

function buildAccountsList(onClose?: () => void): HTMLElement {
  const list = h("div", "ai-acct-list");
  for (const id of ["claude", "codex", "antigravity"] as const) {
    const meta = PROVIDERS[id];
    const t = tools[id];
    const isCurrent = activeProvider === id;
    const dotCls = t?.logged_in ? "on" : t?.installed ? "wait" : "off";
    const row = h("div", `ai-acct-row${isCurrent ? " active" : ""}`);
    const info = h("div", "ai-acct-info");
    const top = h("div", "ai-acct-top");
    top.append(h("span", `ai-prov-dot ${dotCls}`, ""), h("span", "ai-acct-name", meta.accountTitle));
    info.append(top, h("div", "ai-acct-sub", accountStatusText(id, t)));
    row.append(info);

    const canInstall = !!(meta.npmPkg || meta.installCmdPs);
    if (!t?.installed) {
      const btn = h("button", "ai-acct-btn", canInstall ? "Instalar y conectar" : "Cómo instalar");
      btn.type = "button";
      btn.onclick = () => {
        if (canInstall) void installAndConnect(id, onClose);
        else void openExternal(meta.docsUrl);
      };
      row.append(btn);
    } else if (!t.logged_in) {
      const btn = h("button", "ai-acct-btn primary", "Conectar");
      btn.type = "button";
      btn.onclick = () => {
        onClose?.();
        switchProvider(id);
        startLoginFlow(id);
      };
      row.append(btn);
    } else if (isCurrent) {
      row.append(h("span", "ai-acct-badge", "En uso"));
    } else {
      const btn = h("button", "ai-acct-btn", "Usar");
      btn.type = "button";
      btn.onclick = () => {
        switchProvider(id);
        onClose?.();
      };
      row.append(btn);
    }
    list.append(row);
  }
  return list;
}

function openAccountsPopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-acct-pop");
  const render = () => {
    pop.replaceChildren();
    const head = h("div", "ai-usage-pop-head");
    head.append(h("span", "ai-usage-group", "Cuentas y suscripciones"));
    const checkBtn = h("button", "ai-usage-sync", "Comprobar");
    checkBtn.type = "button";
    checkBtn.onclick = () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "Comprobando…";
      toolAt = 0;
      void detect(true).finally(() => { if (pop.isConnected) render(); });
    };
    head.append(checkBtn);
    pop.append(
      head,
      h("div", "ai-usage-note", "Cada proveedor administra su sesión en su CLI oficial. Pulso detecta cuáles tienes activas para habilitar sus modelos."),
      buildAccountsList(() => dismissPopover()),
    );
  };
  render();
  openPopover(anchor, pop, "below");
}

const ICON_GAUGE = '<svg viewBox="0 0 24 24"><path d="M12 14l4-4M4.93 17a9 9 0 1 1 14.14 0"/><path d="M7 17h10"/></svg>';

function openModelPopover(anchor: HTMLElement) {
  const dockWrap = h("div", "ai-popover-pair");
  const pop = h("div", "ai-popover ai-model-pop");
  pop.setAttribute("role", "listbox");
  pop.setAttribute("aria-label", "Seleccionar proveedor y modelo");
  const sideUsage = h("div", "ai-popover ai-usage-pop ai-usage-docked");
  sideUsage.hidden = true;
  dockWrap.append(pop, sideUsage);

  let specificOpen = providerCatalog(activeProvider).specific.some((m) => m.value === model);
  let usageSideOpen = false;

  const syncSidePosition = () => {
    const ar = anchor.getBoundingClientRect();
    const dr = dockWrap.getBoundingClientRect();
    const left = Math.max(8, Math.min(ar.left, window.innerWidth - dr.width - 8));
    const top = Math.max(8, ar.top - dr.height - 6);
    dockWrap.style.left = `${left}px`;
    dockWrap.style.top = `${top}px`;
  };

  const renderSideUsage = () => {
    if (!usageSideOpen) { sideUsage.hidden = true; return; }
    sideUsage.hidden = false;
    populateUsageContainer(sideUsage, () => { if (dockWrap.isConnected && usageSideOpen) renderSideUsage(); });
    requestAnimationFrame(() => { if (dockWrap.isConnected) syncSidePosition(); });
  };

  const openSideUsage = () => {
    if (usageSideOpen) return;
    usageSideOpen = true;
    renderSideUsage();
    void syncAccountAndUsage().finally(() => { if (dockWrap.isConnected && usageSideOpen) renderSideUsage(); });
  };

  const render = () => {
    const meta = PROVIDERS[activeProvider];
    const cat = providerCatalog(activeProvider);
    pop.replaceChildren();
    pop.append(h("div", "ai-pop-head", "Herramienta"), buildProviderTabs(() => {
      const target = tools[activeProvider];
      if (target && !target.logged_in) { dismissPopover(); return; }
      specificOpen = providerCatalog(activeProvider).specific.some((m) => m.value === model);
      syncModelButton();
      render();
      if (usageSideOpen) renderSideUsage();
    }));
    pop.append(h("div", "ai-pop-sep"), h("div", "ai-pop-head", `Modelo · ${meta.short}`));

    const listBox = h("div", "ai-model-list");
    const addOption = (m: ModelOption) => {
      const active = m.value === model;
      const row = h("button", `ai-pop-item${active ? " active" : ""}`);
      row.type = "button";
      row.title = m.hint;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(active));
      const left = h("span", "ai-pop-main");
      left.append(h("span", "ai-pop-name", m.label));
      if (m.tier) left.append(h("span", "ai-pop-tier", m.tier));
      if (m.badge) left.append(h("span", "ai-pop-badge", m.badge));
      row.append(left, h("span", "ai-pop-check", active ? "✓" : ""));
      row.onclick = () => {
        model = m.value;
        localStorage.setItem(meta.modelKey, model);
        dismissPopover();
        syncModelButton();
      };
      listBox.append(row);
    };

    for (const m of cat.models) addOption(m);

    if (cat.specific.length > 0) {
      const toggleSpec = h("button", "ai-pop-item ai-pop-subtoggle");
      toggleSpec.type = "button";
      const toggleMain = h("span", "ai-pop-main");
      toggleMain.append(h("span", "ai-pop-name", `Más modelos (${cat.specific.length})`));
      toggleSpec.append(toggleMain, h("span", "ai-pop-chev", specificOpen ? "▾" : "›"));
      toggleSpec.onclick = () => { specificOpen = !specificOpen; render(); };
      listBox.append(h("div", "ai-pop-sep"), toggleSpec);
      if (specificOpen) for (const m of cat.specific) addOption(m);
    }

    const custom = h("button", "ai-pop-item ai-pop-custom");
    custom.type = "button";
    const customMain = h("span", "ai-pop-main");
    customMain.append(h("span", "ai-pop-name", "Otro ID de modelo…"), h("span", "ai-pop-tier", "Manual"));
    custom.append(customMain);
    custom.onclick = async () => {
      dismissPopover();
      const entered = await promptText({ title: "Identificador exacto del modelo", value: model, placeholder: cat.models[1]?.value ?? "modelo" });
      if (!entered) return;
      model = entered.trim();
      localStorage.setItem(meta.modelKey, model);
      syncModelButton();
    };
    listBox.append(custom);
    pop.append(listBox);

    if (meta.supportsEffort && (activeProvider !== "antigravity" || !model)) {
      const effBox = h("div", "ai-pop-effort");
      effBox.append(h("span", "ai-pop-effort-lbl", "Esfuerzo"));
      const pills = h("div", "ai-effort-pills");
      for (const e of EFFORTS) {
        const b = h("button", `ai-effort-pill${effort === e.value ? " active" : ""}`, e.label);
        b.type = "button";
        b.onclick = () => {
          effort = e.value;
          localStorage.setItem("pulso.ai.effort", effort);
          syncModelButton();
          render();
        };
        pills.append(b);
      }
      effBox.append(pills);
      pop.append(h("div", "ai-pop-sep"), effBox);
    }

    const viewUsage = h("button", `ai-pop-item ai-pop-usage-link${usageSideOpen ? " active" : ""}`);
    viewUsage.type = "button";
    const usageMain = h("span", "ai-pop-main");
    const gIcon = h("span", "ai-pop-gauge");
    gIcon.innerHTML = ICON_GAUGE;
    usageMain.append(gIcon, h("span", "ai-pop-name", "Ver uso y límites"));
    viewUsage.append(usageMain, h("span", "ai-pop-chev", "›"));
    viewUsage.onmouseenter = () => openSideUsage();
    viewUsage.onclick = () => {
      if (usageSideOpen) { usageSideOpen = false; renderSideUsage(); render(); }
      else { openSideUsage(); render(); }
    };

    const manage = h("button", "ai-pop-item ai-pop-subtoggle");
    manage.type = "button";
    const manageMain = h("span", "ai-pop-main");
    manageMain.append(h("span", "ai-pop-name", "Cuentas y suscripciones…"));
    manage.append(manageMain, h("span", "ai-pop-chev", "›"));
    manage.onclick = () => openAccountsPopover(anchor);
    pop.append(h("div", "ai-pop-sep"), viewUsage, manage);
    requestAnimationFrame(() => { if (dockWrap.isConnected) syncSidePosition(); });
  };

  render();
  openPopover(anchor, dockWrap, "above");
}

async function syncAccountAndUsage(): Promise<void> {
  toolAt = 0;
  await detect(true);
  await Promise.all([
    tools.claude?.logged_in ? (usageInFlight ?? refreshUsage()) : Promise.resolve(false),
    (tools.codex?.logged_in || tools.antigravity?.logged_in) ? refreshExtraUsage() : Promise.resolve(false),
  ]);
}

function agyBucketLabel(b: AntigravityBucket): string {
  if (b.window === "5h") return "Límite 5 h";
  if (b.window === "weekly") return "Límite semanal";
  return b.name || "Límite";
}

function fillQuotaCard(card: HTMLElement) {
  const meta = PROVIDERS[activeProvider];
  const curUsage = providerUsage();
  card.replaceChildren();
  const head = h("div", "ai-inst-head");
  const headLeft = h("div", "ai-inst-head-left");
  const planBadgeText = activeProvider === "claude"
    ? (tool?.plan ? `Plan ${planLabel(tool.plan)}` : "Conectado")
    : activeProvider === "codex"
      ? (tool?.plan && tool.plan !== "ChatGPT" ? `Plan ${planLabel(tool.plan)}` : "ChatGPT")
      : (tool?.plan || meta.short);
  headLeft.append(
    h("span", "ai-inst-kicker", "CUOTAS DEL PLAN"),
    h("span", "ai-inst-plan", planBadgeText),
  );
  const syncBtn = h("button", "ai-inst-sync", usageSyncing ? "Actualizando…" : "Sincronizar");
  syncBtn.type = "button";
  syncBtn.disabled = usageSyncing;
  syncBtn.title = "Actualizar límites disponibles del plan";
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Actualizando…";
    void syncAccountAndUsage().finally(() => { if (card.isConnected) fillQuotaCard(card); });
  };
  head.append(headLeft, syncBtn);
  card.append(head);

  if (activeProvider === "antigravity") {
    const meters = h("div", "ai-inst-meters");
    if (agyUsage?.groups?.length) {
      for (const g of agyUsage.groups) {
        for (const b of g.buckets) {
          const w = agyWindowFromBucket(b);
          const row = h("div", "ai-inst-row");
          const top = h("div", "ai-inst-row-top");
          top.append(h("span", "ai-inst-lbl", `${g.name} · ${agyBucketLabel(b)}`), h("span", "ai-inst-val", `${remainingPercent(w)} disp.`));
          const track = h("div", "ai-inst-track");
          const rem = remainingRatio(w);
          const bar = h("div", `ai-inst-fill${rem <= 0.1 ? " high" : rem <= 0.3 ? " warn" : ""}`);
          bar.style.width = `${Math.round(rem * 100)}%`;
          track.append(bar);
          const cd = resetCountdown(w);
          const reset = cd && cd !== "ahora" ? `Se reinicia en ${cd}` : resetClockText(w);
          row.append(top, track);
          if (reset) row.append(h("div", "ai-inst-sub", reset));
          meters.append(row);
        }
      }
    } else {
      card.append(h("div", "ai-inst-note", "Consultando límites de Antigravity…"));
      return;
    }
    card.append(meters);
    return;
  }

  const meters = h("div", "ai-inst-meters");
  for (const [label, w] of [["Ventana 5 h", curUsage.fiveHour], ["Semanal", curUsage.sevenDay]] as const) {
    const row = h("div", "ai-inst-row");
    const top = h("div", "ai-inst-row-top");
    top.append(h("span", "ai-inst-lbl", label), h("span", "ai-inst-val", w ? `${remainingPercent(w)} disp.` : "—"));
    const track = h("div", "ai-inst-track");
    const rem = remainingRatio(w);
    const bar = h("div", `ai-inst-fill${rem <= 0.1 ? " high" : rem <= 0.3 ? " warn" : ""}`);
    bar.style.width = `${w ? Math.round(rem * 100) : 0}%`;
    track.append(bar);
    const cd = resetCountdown(w);
    const clock = resetClockText(w);
    const emptyMsg = activeProvider === "claude"
      ? (usageSyncing ? "Leyendo /usage…" : "Sin datos en esta ventana")
      : "Consultando límites de ChatGPT…";
    const reset = cd && cd !== "ahora" ? `Se reinicia en ${cd}` : (clock || emptyMsg);
    row.append(top, track, h("div", "ai-inst-sub", reset));
    meters.append(row);
  }
  card.append(meters);

  if (activeProvider === "claude" && usageError) {
    card.append(h("div", "ai-inst-note err", usageError));
  } else if (activeProvider === "claude" && usageSyncing) {
    card.append(h("div", "ai-inst-note", "Sincronizando límites reales con Claude Code…"));
  }
}

function fillScopeStrip(box: HTMLElement, ctx: EditorContext) {
  box.replaceChildren();
  const label = h("span", "ai-scope-lbl", "ALCANCE");
  const pills = h("div", "ai-scope-pills");
  if (ctx.file) {
    pills.append(h("span", "ai-scope-item active", baseName(ctx.file)));
  } else {
    pills.append(h("span", "ai-scope-item", "Sin archivo activo"));
  }
  if (ctx.selection) {
    pills.append(h("span", "ai-scope-item sel", `L${ctx.selection.startLine}–${ctx.selection.endLine}`));
  }
  for (const ex of extraFiles) {
    if (ex !== ctx.file) pills.append(h("span", "ai-scope-item", baseName(ex)));
  }
  const add = h("button", "ai-scope-add", "+ Adjuntar");
  add.type = "button";
  add.onclick = attachProjectFile;
  box.append(label, pills, add);
}

function syncTelemetryViews() {
  renderFoot();
  const quota = q(".ai-inst-quota");
  if (quota) fillQuotaCard(quota);
}

function usageRingRow(title: string, w: UsageWindow | undefined, emptyText: string): HTMLElement {
  const row = h("div", "ai-usage-row");
  const left = h("div", "ai-usage-row-left");
  left.append(h("span", "ai-usage-label", title));
  const cd = resetCountdown(w);
  const clock = resetClockText(w);
  const sub = cd && cd !== "ahora" ? `Se reinicia en ${cd}` : clock || emptyText;
  left.append(h("span", "ai-usage-reset", sub));
  const right = h("div", "ai-usage-row-right");
  right.append(h("span", "ai-usage-pct", w ? `${remainingPercent(w)} disp.` : "—"), usageRing(w ? remainingRatio(w) : 0, 16));
  row.append(left, right);
  return row;
}

function populateUsageContainer(pop: HTMLElement, onRefreshDone: () => void) {
  const prov = current?.convo.messages.length ? current.provider : activeProvider;
  pop.replaceChildren();
  const head = h("div", "ai-usage-pop-head");
  head.append(h("span", "ai-usage-group", "Uso"));
  const syncBtn = h("button", "ai-usage-sync", usageSyncing ? "Actualizando…" : "Actualizar");
  syncBtn.type = "button";
  syncBtn.disabled = usageSyncing;
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Actualizando…";
    void syncAccountAndUsage().finally(onRefreshDone);
  };
  head.append(syncBtn);
  pop.append(head);

  const order: AiProvider[] = [prov, ...(["claude", "codex", "antigravity"] as const).filter((p) => p !== prov && !!tools[p]?.logged_in)];
  for (const id of order) {
    const t = tools[id] ?? (id === prov ? tool : null);
    if (id === "antigravity") {
      if (agyUsage?.groups?.length) {
        for (const g of agyUsage.groups) {
          const sec = h("div", "ai-usage-section");
          sec.append(h("div", "ai-usage-sec-title", g.name));
          for (const b of g.buckets) {
            sec.append(usageRingRow(agyBucketLabel(b), agyWindowFromBucket(b), "Sin datos"));
          }
          pop.append(sec);
        }
      } else {
        const sec = h("div", "ai-usage-section");
        sec.append(h("div", "ai-usage-sec-title", "Antigravity"), h("div", "ai-usage-note", "Consultando límites de tu cuenta…"));
        pop.append(sec);
      }
      continue;
    }
    const sec = h("div", "ai-usage-section");
    if (id === "claude") {
      const cur = providerUsage("claude");
      const title = t?.plan ? `Claude Code · Plan ${planLabel(t.plan)}` : "Claude Code";
      sec.append(
        h("div", "ai-usage-sec-title", title),
        usageRingRow("Límite semanal", cur.sevenDay, usageSyncing ? "Consultando /usage…" : "Pendiente de lectura"),
        usageRingRow("Límite 5 h", cur.fiveHour, usageSyncing ? "Consultando /usage…" : "Pendiente de lectura"),
      );
      if (usageError) sec.append(h("div", "ai-usage-note err", usageError));
    } else {
      const cur = providerUsage("codex");
      const title = t?.plan && t.plan !== "ChatGPT" ? `ChatGPT / Codex · Plan ${planLabel(t.plan)}` : "ChatGPT / Codex";
      sec.append(
        h("div", "ai-usage-sec-title", title),
        usageRingRow("Límite semanal", cur.sevenDay, "Consultando app-server…"),
        usageRingRow("Límite 5 h", cur.fiveHour, "Consultando app-server…"),
      );
    }
    pop.append(sec);
  }

  const convo = current?.convo;
  if (convo && (convo.model || convo.outcome)) {
    const sess = h("div", "ai-usage-sess");
    if (convo.model) sess.append(h("div", "ai-usage-meta", `Modelo activo: ${formatModelName(convo.model)}`));
    if (convo.outcome?.durationMs) sess.append(h("div", "ai-usage-meta", `Último turno: ${(convo.outcome.durationMs / 1000).toFixed(1).replace(".", ",")} s`));
    if (convo.outcome && convo.outcome.costUsd > 0) sess.append(h("div", "ai-usage-meta", `Coste reportado: $${convo.outcome.costUsd.toFixed(4)}`));
    pop.append(sess);
  }
}

function openUsagePopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-usage-pop");
  const fill = () => populateUsageContainer(pop, () => { if (pop.isConnected) fill(); });
  fill();
  openPopover(anchor, pop, "above");
  if (tools.claude?.logged_in || activeProvider === "claude") {
    void refreshUsage().finally(() => { if (pop.isConnected) fill(); });
  }
  if (tools.codex?.logged_in || tools.antigravity?.logged_in) {
    void refreshExtraUsage().finally(() => { if (pop.isConnected) fill(); });
  }
}

function openQuickPromptsPopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-quick-pop");
  pop.append(h("div", "ai-pop-head", "Acciones rápidas"));
  for (const item of QUICK_PROMPTS) {
    const row = h("button", "ai-pop-item");
    row.type = "button";
    const left = h("span", "ai-pop-main");
    left.append(h("span", "ai-pop-name", item.label));
    row.append(left, h("span", "ai-pop-badge", item.tag));
    row.onclick = () => {
      dismissPopover();
      const inp = q<HTMLTextAreaElement>(".ai-input");
      if (!inp) return;
      inp.value = item.prompt;
      autosize();
      inp.focus();
    };
    pop.append(row);
  }
  openPopover(anchor, pop, "above");
}

function attachProjectFile() {
  if (!ws.root) { setStatus("Abre una carpeta primero"); return; }
  quickPick({
    placeholder: "Adjuntar archivo del proyecto al contexto…",
    load: async () => {
      const files = await invoke<string[]>("list_files", { path: ws.root });
      return files.map((p) => ({ p, r: rel(p) })).sort((a, b) => a.r.localeCompare(b.r)).map<PickItem>(({ p, r }) => ({
        label: baseName(p),
        detail: dirName(r),
        run: () => {
          if (!extraFiles.includes(r)) extraFiles.push(r);
          renderChips();
          q<HTMLTextAreaElement>(".ai-input")?.focus();
        },
      }));
    },
  });
}

function usageText(): string {
  const prov = current?.convo.messages.length ? current.provider : activeProvider;
  const curTool = tools[prov] ?? tool;
  const curUsage = providerUsage(prov);
  const parts: string[] = [];
  if (curTool?.plan) parts.push(prov === "claude" ? `Plan ${planLabel(curTool.plan)}` : `${PROVIDERS[prov].short} · ${planLabel(curTool.plan)}`);
  if (curUsage.fiveHour) parts.push(`5 h: ${remainingPercent(curUsage.fiveHour)} disp.${resetIn(curUsage.fiveHour) ? ` (${resetIn(curUsage.fiveHour)})` : ""}`);
  if (curUsage.sevenDay) parts.push(`sem.: ${remainingPercent(curUsage.sevenDay)} disp.`);
  return parts.join(" · ");
}

function renderFoot() {
  const foot = q(".ai-foot");
  if (!foot) return;
  const prov = current?.convo.messages.length ? current.provider : activeProvider;
  const curUsage = providerUsage(prov);
  const text = usageText();
  foot.replaceChildren();
  const hasWindows = !!(curUsage.fiveHour || curUsage.sevenDay);
  const ratioLeft = curUsage.fiveHour ? remainingRatio(curUsage.fiveHour) : curUsage.sevenDay ? remainingRatio(curUsage.sevenDay) : 1;
  const trigger = h("button", "ai-usage-btn");
  trigger.type = "button";
  trigger.title = "Ver límites disponibles del plan";
  const pctText = curUsage.fiveHour ? `${remainingPercent(curUsage.fiveHour)} disp.` : curUsage.sevenDay ? `${remainingPercent(curUsage.sevenDay)} sem.` : "Ver uso";
  trigger.append(usageRing(hasWindows ? ratioLeft : 0, 14), h("span", "", pctText));
  trigger.onclick = () => openUsagePopover(trigger);

  if (!text || !hasWindows) {
    foot.append(h("span", "ai-foot-text", `${text ? `${text} · ` : ""}Usa tu sesión de ${PROVIDERS[prov].title}`), trigger);
    return;
  }
  const bars = h("span", "ai-meters");
  for (const w of [curUsage.fiveHour, curUsage.sevenDay]) {
    if (!w) continue;
    const rem = remainingRatio(w);
    const m = h("span", "ai-meter");
    const f = h("span", `ai-meter-fill${rem <= 0.1 ? " high" : ""}`);
    f.style.width = `${Math.round(rem * 100)}%`;
    m.append(f);
    bars.append(m);
  }
  foot.append(bars, h("span", "ai-foot-text", text), trigger);
}

function setupMessage(title: string, text: string, ...extra: HTMLElement[]): HTMLElement {
  const box = h("div", "ai-setup");
  const card = h("div", "ai-setup-card");
  const mark = h("div", "ai-hero-icon");
  mark.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 10l3 2-3 2M13 15h3"/></svg>';
  card.append(mark, h("div", "ai-setup-title", title), h("p", "", text));
  if (extra.length) {
    const actions = h("div", "ai-setup-actions");
    actions.append(...extra);
    card.append(actions);
  }
  const accts = h("div", "ai-setup-accts");
  accts.append(h("div", "ai-inst-kicker", "TUS CUENTAS Y SUSCRIPCIONES"), buildAccountsList());
  card.append(accts);
  box.append(card);
  return box;
}

async function detectProviderNow(prov: AiProvider) {
  try {
    const next = await invoke<AiTool>("ai_detect_provider", { provider: prov }).catch(() => null);
    if (!next) { await detect(true); return; }
    const wasInstalled = !!tools[prov]?.installed;
    const wasLogged = !!tools[prov]?.logged_in;
    tools[prov] = next;
    if (prov === activeProvider) tool = next;
    if (next.logged_in) {
      awaitingLogin = false;
      window.clearInterval(loginWatchTimer);
      if (!wasLogged) setStatus(`${PROVIDERS[prov].title} conectado`, 4000);
      if (prov === "claude") void refreshUsage();
      void detect(true);
    }
    if (shown && (next.logged_in || next.installed !== wasInstalled)) renderBody();
  } catch { /* reintento en el siguiente tick */ }
}

function watchLogin(prov: AiProvider, intervalMs = 1000) {
  awaitingLogin = true;
  loginProvider = prov;
  const started = Date.now();
  window.clearInterval(loginWatchTimer);
  loginWatchTimer = window.setInterval(() => {
    if (!awaitingLogin || tools[prov]?.logged_in || Date.now() - started > 600_000) {
      awaitingLogin = false;
      window.clearInterval(loginWatchTimer);
      return;
    }
    void detectProviderNow(prov);
  }, intervalMs);
}

function startLoginFlow(prov: AiProvider = activeProvider) {
  watchLogin(prov, 1000);
  void runInTerminal(PROVIDERS[prov].loginCmd);
}

function buildEmptyWorkbench(): HTMLElement {
  const meta = PROVIDERS[activeProvider];
  const empty = h("div", "ai-empty ai-bench");
  const main = h("div", "ai-bench-main");

  const modeShort = mode === "full" ? "Agente" : mode === "edit" ? "Puede editar" : "Solo leer";
  const modeCls = mode === "full" ? " full" : mode === "edit" ? " edit" : "";
  const eyebrow = h("div", "ai-bench-eyebrow");
  eyebrow.append(
    h("span", "ai-bench-dot", ""),
    h("span", "ai-bench-kicker", "PULSO // ESTACIÓN DE CÓDIGO"),
    h("span", `ai-meta-pill${modeCls}`, modeShort),
    buildProviderTabs(),
  );

  const hero = h("div", "ai-bench-hero");
  const wsName = baseName(ws.root ?? "") || "Proyecto";
  hero.append(
    h("div", "ai-empty-title", `Mesa de trabajo · ${wsName}`),
    h("p", "ai-bench-lead", `Conversa directo sobre el código abierto usando tu sesión local de ${meta.title}, sin claves almacenadas.`),
  );

  const scope = h("div", "ai-scope-strip");
  fillScopeStrip(scope, editorContext());

  const exWrap = h("div", "ai-examples");
  for (const ex of EXAMPLES) {
    const b = h("button", "ai-example");
    b.type = "button";
    const top = h("div", "ai-example-top");
    top.append(h("span", "ai-example-code", ex.code), h("span", "ai-example-tag", ex.tag), h("span", "ai-example-arr", "↗"));
    const mainTxt = h("span", "ai-example-main", ex.label);
    b.append(top, mainTxt);
    b.onclick = () => { const t = q<HTMLTextAreaElement>(".ai-input")!; t.value = ex.prompt; t.focus(); autosize(); };
    exWrap.append(b);
  }
  main.append(eyebrow, hero, scope, exWrap);

  const rail = h("div", "ai-bench-rail");
  const quotaCard = h("div", "ai-inst-card ai-inst-quota");
  fillQuotaCard(quotaCard);

  const threadsCard = h("div", "ai-inst-card ai-inst-threads");
  const thHead = h("div", "ai-inst-head");
  const thLeft = h("div", "ai-inst-head-left");
  thLeft.append(h("span", "ai-inst-kicker", "SESIONES RECIENTES"));
  const allBtn = h("button", "ai-inst-sync", "Ver todo");
  allBtn.type = "button";
  allBtn.onclick = () => { historyOpen = true; renderBody(); };
  thHead.append(thLeft, allBtn);
  threadsCard.append(thHead);

  const recent = chatsFor(loadChats(), ws.root ?? "").slice(0, 3);
  if (recent.length) {
    const list = h("div", "ai-thread-list");
    for (const c of recent) {
      const btn = h("button", "ai-thread-row");
      btn.type = "button";
      btn.append(h("span", "ai-thread-name", c.title), h("span", "ai-thread-when", agoFrom(c.updatedAt)));
      btn.onclick = () => {
        const opened = lives.get(c.id) ?? (() => { const l = fromSaved(c); lives.set(l.id, l); return l; })();
        switchProvider(opened.provider);
        current = opened;
        renderBody();
      };
      list.append(btn);
    }
    threadsCard.append(list);
  } else {
    const spec = h("div", "ai-inst-spec");
    const activeOpt = findModelOption(model);
    const effOpt = EFFORTS.find((e) => e.value === effort)?.label ?? "Auto";
    spec.append(
      h("div", "ai-spec-row", `Motor activo: ${activeOpt.label}`),
      h("div", "ai-spec-row", `Esfuerzo: ${effOpt} · Modo: ${mode === "full" ? "Agente completo" : mode === "edit" ? "Edición directa" : "Solo lectura"}`),
      h("div", "ai-inst-note", `Tus hilos guardados en ${wsName} aparecerán aquí para retomarlos en un clic.`),
    );
    threadsCard.append(spec);
  }

  rail.append(quotaCard, threadsCard);
  empty.append(main, rail);
  return empty;
}

/** Estado de revisión de propuestas de diff generadas por la IA en esta sesión. */
const proposalStatus = new Map<string, "applied" | "discarded">();
/** Tarjetas de permiso bloqueado descartadas manualmente por turno. */
const dismissedDenials = new Set<string>();

function buildDenialCard(live: Live, denials: number, actions: readonly DeniedAction[] | undefined, dismissKey: string): HTMLElement {
  const card = h("div", "ai-denial-card");
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Permiso requerido por el agente");

  const wantsFull = mode !== "read" || needsCommandPermission(actions);
  const targetMode: AiMode = wantsFull ? "full" : "edit";
  const targetLabel = targetMode === "full" ? "Agente" : "Puede editar";

  const head = h("div", "ai-denial-head");
  head.append(
    h("span", "ai-denial-badge", "PERMISO REQUERIDO"),
    h("span", "ai-denial-title", denials === 1 ? "El agente necesitó ejecutar una acción bloqueada" : `El agente necesitó ejecutar ${denials} acciones bloqueadas`),
  );
  card.append(head);

  if (actions?.length) {
    const list = h("div", "ai-denial-list");
    for (const a of actions.slice(0, 4)) {
      const row = h("div", "ai-denial-item");
      row.append(h("span", "ai-denial-tool", a.tool));
      if (a.detail) row.append(h("code", "ai-denial-detail", a.detail));
      if (a.reason) row.append(h("span", "ai-denial-reason", a.reason));
      list.append(row);
    }
    card.append(list);
  } else {
    const explain = targetMode === "full"
      ? "El modo actual no permite ejecutar comandos de terminal (como run_command o Bash). Aprueba esta acción para que el agente pueda completar la tarea."
      : "El modo «Solo leer» impide modificar archivos. Aprueba la edición para que el agente pueda continuar.";
    card.append(h("p", "ai-denial-msg", explain));
  }

  const acts = h("div", "ai-denial-acts");
  const onceBtn = h("button", "ai-denial-btn primary", "Permitir una vez y continuar");
  onceBtn.type = "button";
  onceBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    const contPrompt = targetMode === "full"
      ? "El usuario aprobó ejecutar el comando o herramienta que quedó bloqueada en el paso anterior. Ejecútalo ahora y completa la tarea pendiente."
      : "El usuario aprobó modificar archivos para el paso anterior. Aplica los cambios y completa la tarea pendiente.";
    void dispatchPrompt(live, "Permiso concedido (una vez) · continuar", contPrompt, targetMode);
  };

  const switchBtn = h("button", "ai-denial-btn", `Activar «${targetLabel}» y continuar`);
  switchBtn.type = "button";
  switchBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    mode = targetMode;
    localStorage.setItem("pulso.ai.mode", mode);
    localStorage.setItem(targetMode === "full" ? "pulso.ai.fullOk" : "pulso.ai.editOk", "1");
    build();
    const contPrompt = targetMode === "full"
      ? "El usuario activó el modo Agente completo (edición y comandos de terminal aprobados). Ejecuta lo que quedó pendiente y completa la tarea."
      : "El usuario activó el modo Puede editar. Aplica los cambios y completa la tarea pendiente.";
    void dispatchPrompt(live, `Modo «${targetLabel}» activado · continuar`, contPrompt, targetMode);
  };

  const dismissBtn = h("button", "ai-denial-btn ghost", "No permitir");
  dismissBtn.type = "button";
  dismissBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    renderBody();
  };

  acts.append(onceBtn, switchBtn, dismissBtn);
  card.append(acts);
  return card;
}

function renderIssueBanner() {
  const banner = q(".ai-issue-banner");
  if (!banner) return;
  const work = getActiveIssueWork();
  if (!work) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  const info = h("div", "ai-issue-info");
  info.append(
    h("span", "ai-issue-num", `#${work.number}`),
    h("span", "ai-issue-title", work.title),
    h("code", "ai-issue-branch", work.branch),
  );
  const acts = h("div", "ai-issue-acts");
  const prBtn = h("button", "ai-issue-btn primary", "Crear PR");
  prBtn.type = "button";
  prBtn.title = `Crear pull request enlazando Closes #${work.number}`;
  prBtn.onclick = () => {
    const files = current ? touchedFiles(current.convo.messages) : [];
    void createPrForActiveIssue(files);
  };
  const endBtn = h("button", "ai-issue-btn", "Finalizar");
  endBtn.type = "button";
  endBtn.title = "Dejar de asociar esta issue al asistente";
  endBtn.onclick = () => { clearActiveIssueWork(); renderIssueBanner(); };
  acts.append(prBtn, endBtn);
  banner.replaceChildren(info, acts);
}

/** Caché incremental de nodos renderizados por turno: evita reconstruir toda la conversación en cada token (O(1) por frame). */
interface TurnCacheEntry { turn: Turn; active: boolean; slot: HTMLElement }
let renderedChatId = "";
let renderedTurns: TurnCacheEntry[] = [];
let turnsHost: HTMLElement | null = null;
let tailHost: HTMLElement | null = null;

function resetTurnCache() {
  renderedChatId = "";
  renderedTurns = [];
  turnsHost = null;
  tailHost = null;
}

function renderBody() {
  const body = q(".ai-body");
  const compose = q(".ai-compose");
  if (!body || !compose) return;
  const prov = current?.convo.messages.length ? current.provider : activeProvider;
  const meta = PROVIDERS[prov];
  const curTool = tools[prov] ?? (prov === activeProvider ? tool : null);
  tool = tools[activeProvider];
  const sub = q(".ai-sub");
  if (sub) {
    if (!curTool?.installed) sub.textContent = "";
    else if (prov === "claude") sub.textContent = `Claude Code${curTool.version ? ` ${curTool.version.split(" ")[0]}` : ""}${curTool.plan ? ` · plan ${planLabel(curTool.plan)}` : ""}`;
    else sub.textContent = `${meta.title}${curTool.version ? ` ${curTool.version.split(" ")[0]}` : ""}${curTool.plan ? ` · ${curTool.plan}` : ""}`;
  }
  const liveDot = q(".ai-live-dot");
  if (liveDot) {
    liveDot.className = `ai-live-dot${curTool?.logged_in ? " on" : curTool ? " off" : " wait"}`;
  }
  const planBadge = q(".ai-plan-pill");
  if (planBadge) {
    planBadge.hidden = !curTool?.installed || !curTool.logged_in;
    planBadge.textContent = prov === "claude"
      ? (curTool?.plan ? `Plan ${planLabel(curTool.plan)}` : "Conectado")
      : prov === "codex"
        ? (curTool?.auth_method === "api_key" ? "Codex API" : curTool?.plan && curTool.plan !== "ChatGPT" ? `ChatGPT ${planLabel(curTool.plan)}` : "ChatGPT")
        : (curTool?.plan || "Antigravity");
  }
  const histBtn = q<HTMLButtonElement>('.ai-tools button[title="Conversaciones anteriores"]');
  if (histBtn) { histBtn.classList.toggle("active", historyOpen); histBtn.setAttribute("aria-pressed", String(historyOpen)); }
  renderIssueBanner();
  renderFoot();
  const recheck = () => { toolAt = 0; void detect(true); };
  const ready = !!curTool?.installed && curTool.logged_in && !!ws.root;
  compose.hidden = !ready || historyOpen;
  if (!curTool) { resetTurnCache(); body.replaceChildren(setupMessage(`Detectando ${meta.title}`, "Comprobando sesión y estado de tu cuenta…")); return; }
  if (!curTool.installed) {
    resetTurnCache();
    const canInstall = !!(meta.npmPkg || meta.installCmdPs);
    const installBtn = canInstall ? (() => { const b = h("button", "foot-btn ai-btn-primary", "Instalar y conectar"); b.type = "button"; b.onclick = () => void installAndConnect(prov); return b; })() : null;
    const again = h("button", canInstall ? "foot-btn foot-btn-line" : "foot-btn ai-btn-primary", "Volver a comprobar"); again.type = "button"; again.onclick = recheck;
    const guide = h("button", "foot-btn foot-btn-line", "Cómo instalarlo"); guide.type = "button"; guide.onclick = () => void openExternal(meta.docsUrl);
    const extraBtns: HTMLElement[] = [...(installBtn ? [installBtn] : []), again, guide];
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", "Volver a Claude Code"); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(`${meta.title} no está instalado`, meta.installHint, ...extraBtns));
    return;
  }
  if (!curTool.logged_in) {
    resetTurnCache();
    const login = h("button", "foot-btn ai-btn-primary", meta.loginBtn); login.type = "button";
    login.onclick = () => startLoginFlow(prov);
    const again = h("button", "foot-btn foot-btn-line", "Ya inicié sesión: volver a comprobar"); again.type = "button"; again.onclick = recheck;
    const extraBtns: HTMLElement[] = [login, again];
    const title = prov === "claude" ? "Inicia sesión para cargar tu plan" : `Inicia sesión en ${meta.title}`;
    const desc = prov === "claude"
      ? "Claude Code está instalado pero no hay una sesión iniciada. Se abrirá el inicio de sesión y tu plan se cargará al instante."
      : `${meta.title} está instalado pero no hay una sesión iniciada. Se abrirá el inicio de sesión en la terminal integrada.`;
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", "Volver a Claude Code"); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(title, desc, ...extraBtns));
    return;
  }
  if (!ws.root) { resetTurnCache(); body.replaceChildren(setupMessage("Abre un proyecto", "Abre una carpeta de proyecto para que el asistente pueda leer tu código y ayudarte dentro de ella.")); return; }
  if (historyOpen) { resetTurnCache(); renderHistory(body); return; }

  const live = current ?? (current = newLive());
  const c = live.convo;
  syncModelButton();
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;

  if (!c.messages.length) {
    resetTurnCache();
    body.replaceChildren(buildEmptyWorkbench());
  } else {
    const canReuse = renderedChatId === live.id && turnsHost && tailHost && body.contains(turnsHost) && body.contains(tailHost);
    if (!canReuse) {
      renderedChatId = live.id;
      renderedTurns = [];
      turnsHost = h("div", "ai-turns-host");
      tailHost = h("div", "ai-tail-host");
      body.replaceChildren(turnsHost, tailHost);
    }

    // Recortar turnos sobrantes si la lista se acortó.
    while (renderedTurns.length > c.messages.length) {
      renderedTurns.pop()?.slot.remove();
    }

    let userNum = 0;
    c.messages.forEach((t, idx) => {
      if (t.role === "user") userNum += 1;
      const activeTurn = c.running && idx === c.messages.length - 1 && t.role === "assistant";
      const existing = renderedTurns[idx];
      if (existing && existing.turn === t && existing.active === activeTurn) {
        return; // Sin cambios: conserva el DOM y cualquier selección de texto del usuario.
      }
      const slot = existing ? existing.slot : h("div", "ai-turn-slot");
      if (!existing) {
        turnsHost!.append(slot);
      }
      slot.replaceChildren(...turnNodes(t, userNum, activeTurn));
      renderedTurns[idx] = { turn: t, active: activeTurn, slot };
    });

    const tailNodes: HTMLElement[] = [];
    const last = c.messages[c.messages.length - 1];
    const lastSlot = renderedTurns[renderedTurns.length - 1]?.slot;
    const lastEl = lastSlot?.lastElementChild as HTMLElement | null;
    const hasRunningTrace = c.running && lastEl?.classList.contains("ai-step-group") && lastEl.classList.contains("running");
    if (c.running && (!last || last.role === "user" || (!last.done && !hasRunningTrace))) {
      const w = h("div", "ai-working-pill");
      w.append(h("span", "ai-step-orb pulse"), h("span", "ai-working-lbl", "Pensando"));
      tailNodes.push(w);
    }
    if (c.error) {
      const e = h("div", "ai-error");
      e.append(h("div", "", c.error));
      if (isAuthError(c.error)) {
        const b = h("button", "foot-btn foot-btn-line", "Iniciar sesión en la terminal"); b.type = "button";
        b.onclick = () => startLoginFlow(live.provider);
        e.append(b);
      }
      tailNodes.push(e);
      if (!c.running && c.outcome?.denials) {
        const dKey = `${live.id}:${c.messages.length}`;
        if (!dismissedDenials.has(dKey)) {
          tailNodes.push(buildDenialCard(live, c.outcome.denials, c.outcome.deniedActions, dKey));
        }
      }
    } else if (!c.running) {
      // Propuestas revisables en bloques ```lang path=... del último turno del asistente.
      const lastAssistant = [...c.messages].reverse().find((m) => m.role === "assistant");
      const assistantMd = lastAssistant
        ? lastAssistant.blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map((b) => b.text).join("\n")
        : "";
      const proposals = assistantMd ? extractProposedEdits(assistantMd) : [];
      if (proposals.length) {
        const pbox = h("div", "ai-proposals");
        pbox.append(h("span", "ai-touched-label", `Revisar cambios propuestos (${proposals.length}):`));
        for (const edit of proposals) {
          const pkey = `${live.id}:${lastAssistant?.id ?? ""}:${edit.path}`;
          const st = proposalStatus.get(pkey);
          const label = st === "applied" ? `${baseName(edit.path)} ✓` : st === "discarded" ? `${baseName(edit.path)} ✕` : `Diff: ${baseName(edit.path)}`;
          const btn = h("button", `ai-prop-btn${st ? ` ${st}` : ""}`, label);
          btn.type = "button";
          btn.title = `${edit.path} — Revisar diferencias antes de aplicar`;
          btn.onclick = () => {
            if (isFull()) setFull(false);
            void reviewProposedEdit(
              edit,
              () => { proposalStatus.set(pkey, "applied"); renderBody(); },
              () => { proposalStatus.set(pkey, "discarded"); renderBody(); },
            );
          };
          pbox.append(btn);
        }
        tailNodes.push(pbox);
      }
      if (c.outcome?.ok) {
        const files = touchedFiles(c.messages);
        if (files.length) {
          const box = h("div", "ai-touched");
          box.append(h("span", "ai-touched-label", "Archivos modificados:"));
          for (const fp of files) {
            const resolved = resolveToolFile(fp);
            const btn = h("button", "ai-touched-file", baseName(fp));
            btn.type = "button";
            btn.title = fp;
            btn.onclick = () => {
              if (!resolved) return;
              if (isFull()) setFull(false);
              void openFile(resolved);
            };
            box.append(btn);
          }
          tailNodes.push(box);
        }
        if (c.outcome.denials) {
          const dKey = `${live.id}:${c.messages.length}`;
          if (!dismissedDenials.has(dKey)) {
            tailNodes.push(buildDenialCard(live, c.outcome.denials, c.outcome.deniedActions, dKey));
          }
        }
        const secs = c.outcome.durationMs ? ` · ${(c.outcome.durationMs / 1000).toFixed(1).replace(".", ",")} s` : "";
        const modelTag = c.model ? ` · ${formatModelName(c.model)}` : "";
        const o = h("div", "ai-outcome", `Listo${secs}${modelTag}`);
        if (c.touched) o.append(` · ${c.touched} archivo${c.touched === 1 ? "" : "s"} modificado${c.touched === 1 ? "" : "s"}`);
        if (c.outcome.denials) o.append(` · ${c.outcome.denials} acción${c.outcome.denials === 1 ? "" : "es"} no permitida${c.outcome.denials === 1 ? "" : "s"}`);
        tailNodes.push(o);
      }
    }
    tailHost!.replaceChildren(...tailNodes);
  }
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
    const row = h("div", `ai-hist-row${current?.id === r.id ? " current" : ""}`);
    const open = h("button", "ai-hist-open"); open.type = "button";
    open.append(h("span", "ai-hist-name", r.title), h("span", "ai-hist-when", r.running ? "respondiendo…" : agoFrom(r.when)));
    open.onclick = () => {
      const opened = lives.get(r.id) ?? (() => { const l = fromSaved(saved.find((c) => c.id === r.id)!); lives.set(l.id, l); return l; })();
      switchProvider(opened.provider);
      current = opened;
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
  if (!force && tool && Date.now() - toolAt < 60_000) { if (shown) renderBody(); return; }
  if (detectInFlight) return detectInFlight;
  const wasLogged = !!tools[activeProvider]?.logged_in;
  if (!tool && shown) renderBody();
  detectInFlight = (async () => {
    try {
      const all = await invoke<AllAiTools>("ai_detect_all").catch(async () => {
        const claude = await invoke<AiTool>("ai_detect");
        return { claude, codex: null, antigravity: null } as unknown as { claude: AiTool; codex: AiTool | null; antigravity: AiTool | null };
      });
      const nextClaude = all.claude;
      const sig = `${nextClaude.auth_method}:${nextClaude.plan}`;
      const prevSig = localStorage.getItem(USAGE_SIG_KEY);
      if (!nextClaude.logged_in || prevSig !== sig) {
        usage = {};
        usageError = "";
        localStorage.removeItem(USAGE_KEY);
      }
      tools.claude = nextClaude;
      tools.codex = all.codex;
      tools.antigravity = all.antigravity;
      tool = tools[activeProvider];

      if (nextClaude.logged_in) {
        localStorage.setItem(USAGE_SIG_KEY, sig);
        void refreshUsage();
      }
      if (all.codex?.logged_in || all.antigravity?.logged_in) {
        void refreshExtraUsage();
      }
      const curTool = tools[activeProvider];
      if (curTool?.logged_in && (awaitingLogin || (!wasLogged && shown))) {
        awaitingLogin = false;
        window.clearInterval(loginWatchTimer);
        if (activeProvider === "claude" && curTool.plan) {
          setStatus(`Claude Code conectado · Plan ${planLabel(curTool.plan)}`, 4000);
        } else if (activeProvider !== "claude") {
          setStatus(`${PROVIDERS[activeProvider].title} conectado`, 4000);
        }
      }
    } catch (e) {
      const fail: AiTool = { installed: false, version: "", logged_in: false, auth_method: "", plan: "", error: String(e) };
      tools[activeProvider] = fail;
      tool = fail;
    } finally {
      toolAt = Date.now();
      detectInFlight = null;
      if (shown) renderBody();
    }
  })();
  return detectInFlight;
}

function autosize() {
  const t = q<HTMLTextAreaElement>(".ai-input");
  if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }
}

async function dispatchPrompt(live: Live, displayText: string, prompt: string, effectiveMode: AiMode) {
  if (!ws.root || live.convo.running) return;
  live.cwd = ws.root;
  live.stopping = false;
  if (!live.convo.messages.length) {
    live.provider = activeProvider;
    live.normalize = createProviderNormalizer(live.provider, model || "");
  }
  const useEffort = PROVIDERS[live.provider].supportsEffort && !(live.provider === "antigravity" && model)
    ? effort || null
    : null;
  apply(live, userEvent(displayText));
  try {
    await invoke("ai_send", { id: live.id, cwd: ws.root, prompt, session: live.convo.sessionId || null, model: model || null, effort: useEffort, mode: effectiveMode, provider: live.provider });
  } catch (e) {
    apply(live, exitEvent(1, String(e)));
  }
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
  await dispatchPrompt(live, text, prompt, mode);
}

function newConversation() {
  dismissPopover();
  if (current && !current.convo.messages.length) { historyOpen = false; renderBody(); return; }
  current = newLive();
  extraFiles = [];
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
  if (full) bus.emit("overlay", "ai");
  applyMode();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !closePopover && isFull() && !document.querySelector(".modal")) { e.preventDefault(); e.stopPropagation(); setFull(false); }
}

async function chooseMode(next: AiMode) {
  if (next === mode) return;
  if (next === "edit" && localStorage.getItem("pulso.ai.editOk") !== "1") {
    const msg = `Con «Puede editar», ${PROVIDERS[activeProvider].title} podrá modificar y crear archivos en tu proyecto sin preguntar cada vez. Verás los cambios en el panel de Git y podrás descartarlos. Si necesita ejecutar un comando de terminal, Pulso te pedirá permiso.`;
    const r = await showDialog({
      title: "Permitir que la IA edite archivos",
      message: msg,
      buttons: [{ label: "Cancelar", value: "cancel" }, { label: "Permitir editar", value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    localStorage.setItem("pulso.ai.editOk", "1");
  } else if (next === "full" && localStorage.getItem("pulso.ai.fullOk") !== "1") {
    const msg = `Con «Agente», ${PROVIDERS[activeProvider].title} podrá modificar archivos Y ejecutar comandos de terminal (pruebas, búsquedas, diagnósticos, git, etc.) dentro de tu proyecto sin pedir confirmación en cada paso. Actívalo solo en proyectos en los que confíes.`;
    const r = await showDialog({
      title: "Activar modo Agente completo",
      message: msg,
      buttons: [{ label: "Cancelar", value: "cancel" }, { label: "Activar modo Agente", value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    localStorage.setItem("pulso.ai.fullOk", "1");
  }
  mode = next;
  localStorage.setItem("pulso.ai.mode", mode);
  build();
}

function openAppearancePopover(anchor: HTMLElement) {
  openPopover(anchor, buildAppearancePopover(viewEl()), "below");
}

const ICON_PALETTE = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.7 1.8-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1a1.5 1.5 0 0 1 1.5-1.5h2A4.5 4.5 0 0 0 21 11.3C21 6.7 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/></svg>';

// ---------- Construcción de la vista ----------
function build() {
  const root = viewEl();
  const keep = q<HTMLTextAreaElement>(".ai-input")?.value ?? "";
  const shell = h("div", "ai-shell");
  const head = h("div", "ai-head");
  const titles = h("div", "ai-titles");
  const titleRow = h("div", "ai-title-row");
  const planBtn = h("button", "ai-plan-pill", "");
  planBtn.type = "button";
  planBtn.title = "Ver y conectar suscripciones (Claude, ChatGPT, Antigravity)";
  planBtn.onclick = () => openAccountsPopover(planBtn);
  titleRow.append(h("span", "ai-live-dot", ""), h("span", "ai-title", "Asistente"), planBtn);
  titles.append(titleRow, h("span", "ai-sub", ""));
  const tools = h("div", "ai-tools");
  const add = iconBtn(ICON_PLUS, "Nueva conversación"); add.onclick = newConversation;
  const hist = iconBtn(ICON_CLOCK, "Conversaciones anteriores"); hist.onclick = () => { historyOpen = !historyOpen; renderBody(); };
  const themeBtn = iconBtn(ICON_PALETTE, "Cambiar color de fondo"); themeBtn.onclick = () => openAppearancePopover(themeBtn);
  const expand = iconBtn(ICON_EXPAND, "Pantalla completa", "ai-expand"); expand.onclick = () => setFull(!isFull());
  tools.append(add, hist, themeBtn, expand);
  head.append(titles, h("span", "grow"), tools);

  const body = h("div", "ai-body");
  body.tabIndex = 0;
  body.setAttribute("role", "log");
  body.setAttribute("aria-label", "Conversación con la IA");

  const compose = h("form", "ai-compose");
  const dock = h("div", "ai-dock");
  const dockCtx = h("div", "ai-dock-ctx"); dockCtx.hidden = true;
  const chips = h("div", "ai-chips"); chips.hidden = true;
  dockCtx.append(h("span", "ai-dock-ctx-lbl", "CONTEXTO"), chips);

  const inputWrap = h("div", "ai-input-wrap");
  const input = h("textarea", "ai-input");
  input.rows = 1; input.placeholder = "Describe el cambio, duda o archivo a inspeccionar…"; input.setAttribute("aria-label", "Mensaje para la IA"); input.value = keep;
  inputWrap.append(h("span", "ai-input-caret", "›"), input);

  const dockBar = h("div", "ai-dock-bar");
  const leftBar = h("div", "ai-dock-left");
  const attachBtn = iconBtn(ICON_PLUS, "Adjuntar archivo del proyecto", "ai-compose-act");
  attachBtn.onclick = attachProjectFile;
  const quickBtn = iconBtn('<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>', "Acciones rápidas", "ai-compose-act");
  quickBtn.onclick = () => openQuickPromptsPopover(quickBtn);

  const modelBtn = h("button", "ai-model-btn");
  modelBtn.type = "button";
  modelBtn.title = "Cambiar modelo y esfuerzo";
  modelBtn.setAttribute("aria-label", "Modelo");
  modelBtn.append(h("span", "ai-model-btn-label", modelButtonText()), h("span", "ai-model-btn-chev", "⌄"));
  modelBtn.onclick = () => openModelPopover(modelBtn);

  const seg = h("div", "seg ai-mode");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", "Permisos");
  const modeOptions: readonly [AiMode, string, string][] = [
    ["read", "Solo leer", "La IA puede leer y buscar en tu proyecto, pero no modificarlo"],
    ["edit", "Puede editar", "La IA puede editar archivos directamente. Si intenta ejecutar comandos, Pulso te pedirá permiso"],
    ["full", "Agente", "La IA puede editar archivos y ejecutar comandos de terminal en tu proyecto para completar tareas"],
  ];
  for (const [value, label, hint] of modeOptions) {
    const b = h("button", "", label); b.type = "button"; b.title = hint; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(mode === value));
    b.onclick = () => void chooseMode(value);
    seg.append(b);
  }
  leftBar.append(attachBtn, quickBtn, modelBtn, seg);

  const rightBar = h("div", "ai-dock-right");
  const sendBtn = h("button", "ai-send"); sendBtn.type = "submit"; sendBtn.innerHTML = ICON_SEND; sendBtn.title = "Enviar (Enter)"; sendBtn.setAttribute("aria-label", "Enviar");
  rightBar.append(h("span", "ai-send-hint", "Enter ↵"), sendBtn);
  dockBar.append(leftBar, rightBar);
  dock.append(dockCtx, inputWrap, dockBar);
  compose.append(dock);

  compose.onsubmit = (e) => { e.preventDefault(); void send(); };
  input.oninput = autosize;
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } };
  const issueBanner = h("div", "ai-issue-banner");
  issueBanner.hidden = true;
  const foot = h("div", "ai-foot");
  shell.append(head, issueBanner, body, compose, foot);
  root.replaceChildren(shell);
  applyMode();
  renderBody();
  autosize();
}

/** Lo llama el selector de vistas de la barra lateral. */
export function setAiVisible(visible: boolean) {
  shown = visible;
  window.removeEventListener("keydown", onKey, true);
  if (!visible) { dismissPopover(); return; }
  window.addEventListener("keydown", onKey, true);
  if (isFull()) bus.emit("overlay", "ai");
  if (!q(".ai-shell")) build(); else { applyMode(); renderBody(); }
  void detect(!tool?.logged_in);
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

export function initAi() {
  applyAiAppearance(viewEl());
  if (!("__TAURI_INTERNALS__" in window)) return;
  // El historial vive en un archivo: se carga una vez, recupera si cerró ejecutando y repinta si corresponde.
  void initHistory().then(() => {
    try {
      const raw = localStorage.getItem(INTERRUPTED_KEY);
      if (raw) {
        localStorage.removeItem(INTERRUPTED_KEY);
        const info = JSON.parse(raw) as { id?: string; cwd?: string };
        const saved = info.id ? loadChats().find((c) => c.id === info.id) : undefined;
        if (saved && (!ws.root || saved.cwd.replace(/\\/g, "/").toLowerCase() === ws.root.replace(/\\/g, "/").toLowerCase())) {
          const l = fromSaved(saved);
          lives.set(l.id, l);
          switchProvider(l.provider);
          current = l;
        }
      }
    } catch { /* nada que hacer */ }
    if (shown) renderBody();
  });
  window.addEventListener("beforeunload", saveRunningBeforeExit);
  window.addEventListener("pagehide", saveRunningBeforeExit);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveRunningBeforeExit(); });
  // Reconoce Claude Code y su plan al instante al iniciar la aplicación.
  void detect(true);
  window.addEventListener("focus", () => {
    if (awaitingLogin) void detectProviderNow(loginProvider);
    else if (shown && !tool?.logged_in) void detect(true);
  });
  void listen<{ id: string; line: string }>("ai-line", (e) => {
    const live = lives.get(e.payload.id);
    if (!live) return;
    try {
      const raw = JSON.parse(e.payload.line) as AiEvent;
      for (const ev of live.normalize(raw)) apply(live, ev);
    } catch { /* línea que no es JSON: se ignora */ }
  });
  void listen<{ id: string; code: number | null; stderr: string }>("ai-exit", (e) => {
    const live = lives.get(e.payload.id);
    if (live) apply(live, exitEvent(live.stopping ? null : e.payload.code, e.payload.stderr));
  });
  // El contexto adjunto sigue al editor: archivo y selección actuales, liberando listeners al cerrar el editor.
  const attach = (ed: monaco.editor.ICodeEditor) => {
    const d1 = ed.onDidChangeCursorSelection(() => { if (shown && ed === focusedEditor()) { useSel = true; renderChips(); } });
    const d2 = ed.onDidFocusEditorText(() => { const p = activePath() ?? ""; if (p !== lastFile) { lastFile = p; useFile = true; } if (shown) renderChips(); });
    ed.onDidDispose(() => { d1.dispose(); d2.dispose(); });
  };
  monaco.editor.getEditors().forEach(attach);
  monaco.editor.onDidCreateEditor(attach);
  bus.on("overlay", (kind) => { if (kind === "board" && isFull()) setFull(false); });
  bus.on("issue-workflow-start", ({ body: prompt }) => {
    historyOpen = false;
    newConversation();
    renderIssueBanner();
    const inp = q<HTMLTextAreaElement>(".ai-input");
    if (inp) {
      inp.value = prompt;
      autosize();
      inp.focus();
    }
  });
}

/** «IA: Nueva conversación» desde la paleta. */
export const startNewConversation = () => { historyOpen = false; newConversation(); };
