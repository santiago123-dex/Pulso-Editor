import { lang, t as tr } from "./i18n";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "./core/events";
import { currentRepo } from "./core/repo";
import { readStorage, removeStorage, writeJsonStorage, writeStorage } from "./core/storage";
import {
  EFFORTS, EXAMPLES, PROVIDERS, QUICK_PROMPTS,
  type AiModelInfo, type AiTool, type AllAiTools, type AntigravityBucket, type AntigravityUsage, type CodexQuota, type ExtraUsage, type ModelOption, type ProviderMeta, type WindowQuota,
} from "./ai/catalog";
import { applyAiAppearance, buildAppearancePopover } from "./ai/appearance";
import { linkTarget, parseInline, parseMarkdown } from "./aiMarkdown";
import { buildPrompt, chipLabels, fileMentionAt, filterProjectFiles, type ContextNote, type EditorContext } from "./aiContext";
import {
  activitySummary, createProviderNormalizer, elapsedLabel, emptyConversation, exitEvent, mergeAssistantRuns, formatModelName, isAuthError, needsCommandPermission, parseUsageText, planLabel, pruneUsage,
  reduce, remainingPercent, remainingRatio, resetClockText, resetCountdown, resetIn, resetTimeFromIso, splitAssistantTurn, toolSummary, touchedFiles,
  userEvent, type AiEvent, type AiProvider, type Block, type Conversation, type DeniedAction, type Turn, type UsageWindow, type UserImage,
} from "./aiModel";
import { chatsFor, deleteChat, flushHistoryNow, initHistory, loadChats, newChatId, sameDir, saveChat, titleFrom, type SavedChat } from "./aiStore";
import { checkExternal } from "./docs";
import { refreshTree } from "./explorer";
import { activePath, focusedEditor, openFile } from "./groups";
import { agoFrom, relativeToTop } from "./historyModel";
import { refreshScm } from "./scm";
import type { Changes } from "./scmModel";
import { fetchIssues } from "./github";
import { listPulls } from "./pulls";
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
  if (p === "local") return "local";
  return "claude";
}

const lives = new Map<string, Live>();
let activeProvider: AiProvider = savedProvider();
let current: Live | null = null;
const tools: Record<AiProvider, AiTool | null> = { claude: null, codex: null, antigravity: null, local: null };
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
  const m = readStorage("pulso.ai.mode");
  if (m === "full" || m === "edit") return m;
  return "read";
}
let model = readStorage(PROVIDERS[activeProvider].modelKey) ?? "";
let effort = readStorage("pulso.ai.effort") ?? "";
let mode: AiMode = savedMode();
let useFile = true;
let useSel = true;
let extraFiles: string[] = [];
let extraNotes: ContextNote[] = [];
let attachedImages: UserImage[] = [];
let mentionFiles: { root: string; list: string[] } | null = null;
let lastFile = "";
let usage: Conversation["usage"] = readStoredUsage();
let closePopover: (() => void) | null = null;
let loginWatchTimer = 0;
let awaitingLogin = false;
let loginProvider: AiProvider = activeProvider;

function switchProvider(next: AiProvider) {
  if (activeProvider === next && tool === tools[next]) return;
  activeProvider = next;
  writeStorage("pulso.ai.provider", next);
  model = readStorage(PROVIDERS[next].modelKey) ?? "";
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

const isFull = () => readStorage(FULL_KEY) === "1";
/** Segundos con un decimal, con la coma o el punto que use el idioma elegido: «3,2» o «3.2». */
const seconds = (ms: number) => (ms / 1000).toLocaleString(lang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const viewEl = () => $("view-ai");
const q = <T extends HTMLElement>(sel: string) => viewEl().querySelector<T>(sel);

const ICON_EXPAND = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_SHRINK = '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
const ICON_IMAGE = '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/></svg>';

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
  if (/legacy/i.test(note)) return tr("Legado");
  if (/previous generation/i.test(note)) return tr("Anterior");
  if (/most capable|complex/i.test(note)) return tr("Más capaz");
  if (/affordable|easier|simpler/i.test(note)) return tr("Ligero");
  if (/visual/i.test(note)) return tr("Visión");
  if (/fast|go-to/i.test(note)) return tr("Rápido");
  if (/^(Low|Medium|High|XHigh|Max)$/i.test(note)) return note;
  return tr("Disponible");
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
      badge: /preview/i.test(d.id) ? "Preview" : isNew ? tr("Nuevo") : undefined,
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
    ?? { value: val, label: formatModelName(val) || val, tier: tr("Personalizado"), hint: tr("Modelo específico: {model}", { model: val }) };
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
  const prov: AiProvider = rawProv === "codex" ? "codex" : rawProv === "antigravity" || rawProv === "gemini" ? "antigravity" : rawProv === "local" ? "local" : "claude";
  return { id: c.id, provider: prov, normalize: createProviderNormalizer(prov, c.model || ""), cwd: c.cwd, title: c.title, convo: { ...emptyConversation(), messages: c.messages, sessionId: c.sessionId, model: c.model, usage: prov === "claude" ? usage : {} } };
}

function newLive(): Live {
  const live: Live = { id: newChatId(), provider: activeProvider, normalize: createProviderNormalizer(activeProvider, model), convo: { ...emptyConversation(), usage: activeProvider === "claude" ? usage : {} }, cwd: ws.root ?? "", title: tr("Conversación nueva") };
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
  if (active) writeJsonStorage(INTERRUPTED_KEY, { id: active.id, cwd: active.cwd });
  else removeStorage(INTERRUPTED_KEY);
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
  if (prov === "local") return {};
  return agyPrimaryUsage();
}

function saveUsage(u: Conversation["usage"]) {
  usage = pruneUsage(u);
  usageError = "";
  const claudeTool = tools.claude ?? tool;
  if (claudeTool?.version.includes("falso")) return; // la herramienta de pruebas nunca deja cifras guardadas
  writeJsonStorage(USAGE_KEY, usage);
  if (claudeTool) writeStorage(USAGE_SIG_KEY, `${claudeTool.auth_method}:${claudeTool.plan}`);
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
        usageError = tr("La CLI no devolvió ventanas de uso reconocibles.");
        return false;
      }
      saveUsage(next);
      return true;
    } catch (e) {
      usageError = e instanceof Error ? e.message : String(e || tr("No se pudo consultar /usage."));
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
    removeStorage(INTERRUPTED_KEY);
    if (live.convo.touched) refreshDisk();
    if (live.provider === "codex" || live.provider === "antigravity") void refreshExtraUsage();
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
  if (extraNotes.length) ctx.notes = [...extraNotes];
  if (attachedImages.length) ctx.images = attachedImages.map((i) => ({ path: i.path, name: i.name }));
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
    x.type = "button"; x.title = tr("No adjuntar esto"); x.setAttribute("aria-label", tr("Quitar {item}", { item: text }));
    x.onclick = () => { off(); renderChips(); };
    c.append(x);
    return c;
  };
  const nodes: HTMLElement[] = [];
  if (labels.file) nodes.push(chip(labels.file, tr("Archivo abierto: se le dice a la IA cuál es"), () => { useFile = false; }));
  for (const extra of extraFiles) {
    if (extra === ctx.file) continue;
    nodes.push(chip(baseName(extra), tr("Archivo adjunto: {file}", { file: extra }), () => { extraFiles = extraFiles.filter((f) => f !== extra); }));
  }
  for (const note of extraNotes) {
    nodes.push(chip(note.label, note.title, () => { extraNotes = extraNotes.filter((n) => n.id !== note.id); }));
  }
  for (const img of attachedImages) {
    const c = h("span", "ai-chip ai-chip-img");
    c.title = tr("Imagen adjunta: {name}", { name: img.name });
    if (img.preview) {
      const thumb = document.createElement("img");
      thumb.className = "ai-chip-thumb";
      thumb.src = img.preview;
      thumb.alt = img.name;
      thumb.onclick = (e) => { e.stopPropagation(); void openImageLightbox(img); };
      c.append(thumb);
    }
    c.append(h("span", "", img.name));
    const x = h("button", "ai-chip-x", "×");
    x.type = "button"; x.title = tr("No adjuntar esto"); x.setAttribute("aria-label", tr("Quitar {item}", { item: img.name }));
    x.onclick = () => { attachedImages = attachedImages.filter((i) => i !== img); renderChips(); };
    c.append(x);
    nodes.push(c);
  }
  if (labels.selection) nodes.push(chip(labels.selection, tr("Tu selección se envía a la IA con el mensaje"), () => { useSel = false; }));
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
    setStatus(tr("Copiado"), 2000);
    if (!btn) return;
    const prev = btn.textContent ?? tr("Copiar");
    btn.textContent = tr("Copiado");
    btn.classList.add("copied");
    window.setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
  }, () => setStatus(tr("No se pudo copiar")));
}

function insertCode(text: string) {
  const ed = focusedEditor();
  const sel = ed?.getSelection();
  if (!ed || !sel) { setStatus(tr("Abre un archivo en el editor para insertar el código")); return; }
  if (isFull()) setFull(false);
  ed.executeEdits("pulso-ai", [{ range: sel, text, forceMoveMarkers: true }]);
  ed.focus();
  setStatus(tr("Código insertado en el editor"), 2500);
}

/** Enlace de una respuesta: los archivos se abren en el editor en su línea; las páginas, en el navegador. */
function linkNode(text: string, href: string): Node {
  const target = linkTarget(href);
  if (!target) return document.createTextNode(text);
  const b = h("button", "ai-link", text);
  b.type = "button";
  b.title = target.kind === "file" ? (target.line > 1 ? tr("Abrir {path} en la línea {line}", { path: target.path, line: target.line }) : tr("Abrir {path}", { path: target.path })) : target.url;
  b.onclick = () => {
    if (target.kind === "web") { void invoke("open_external", { url: target.url }).catch((e) => setStatus(String(e))); return; }
    if (isFull()) setFull(false);
    void openFile(target.path, { line: target.line, col: 1 });
  };
  return b;
}

function inline(parent: HTMLElement, text: string) {
  for (const p of parseInline(text)) {
    if (p.kind === "code") parent.append(h("code", "ai-icode", p.text));
    else if (p.kind === "bold") parent.append(h("strong", "", p.text));
    else if (p.kind === "link") parent.append(linkNode(p.text, p.href ?? ""));
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
        const ins = h("button", "ai-code-copy", tr("Insertar"));
        ins.type = "button";
        ins.title = tr("Insertar en la posición actual del editor");
        ins.onclick = () => insertCode(b.text);
        acts.append(ins);
      }
      const c = h("button", "ai-code-copy", tr("Copiar"));
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
    const open = h("button", "ai-tool-open", tr("Abrir"));
    open.type = "button";
    open.title = tr("Abrir {path}", { path: filePath });
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

/** Tarjetas de actividad que la persona desplegó: se conservan al volver a pintar la conversación. */
const openTraces = new Set<string>();
/** Cuándo empezó y terminó cada turno del asistente en esta sesión de Pulso (para «Trabajando · 12 s» y «Trabajó 40 s»). */
const turnStartedAt = new Map<string, number>();
const turnEndedAt = new Map<string, number>();
let activityTimer = 0;
/** Momento del envío: la tarjeta de espera lo fija y la tarjeta real del turno lo hereda, para contar desde que la persona envió. */
let waitingSince = 0;

/** Traza del pulso (el mismo gesto del logotipo): late mientras la IA trabaja y queda quieta al terminar. */
const PULSE_SVG = '<svg viewBox="0 0 44 14" aria-hidden="true"><path class="ai-pulse-base" d="M0 7h44"/><path class="ai-pulse-beat" d="M0 7h12l2.5-5 3.5 10 3-12 3 12 2.5-5H44"/></svg>';

/** Mantiene vivo el contador de segundos de las tarjetas en curso sin volver a pintar la conversación. */
function tickActivityClocks() {
  const live = document.querySelectorAll<HTMLElement>(".ai-activity.running .ai-act-time[data-start]");
  if (!live.length) { window.clearInterval(activityTimer); activityTimer = 0; return; }
  live.forEach((el) => { el.textContent = elapsedLabel(Date.now() - Number(el.dataset.start)); });
}

function activityItem(b: Block): HTMLElement {
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

function activityCard(turnId: string, items: Block[], running: boolean): HTMLElement {
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
  d.addEventListener("toggle", () => { more.textContent = items.length ? (d.open ? tr("Ocultar") : tr("Ver pasos")) : ""; });
  sum.append(pulse, title, time, detail, more);
  if (!items.length) sum.classList.add("empty");
  d.append(sum);

  const body = h("div", "ai-act-body");
  for (const b of items) body.append(activityItem(b));
  d.append(body);
  return d;
}

function turnNodes(t: Turn, _userNum = 0, isRunningTurn = false): HTMLElement[] {
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
  for (const id of ["claude", "codex", "antigravity", "local"] as const) {
    const t = tools[id];
    const dotCls = t?.logged_in ? "on" : t?.installed ? "wait" : "off";
    const btn = h("button", `ai-prov-tab${activeProvider === id ? " active" : ""}`);
    btn.type = "button";
    btn.title = t?.logged_in ? tr("{provider} conectado", { provider: PROVIDERS[id].title }) : t?.installed ? tr("{provider}: falta iniciar sesión", { provider: PROVIDERS[id].title }) : tr("{provider}: sin instalar", { provider: PROVIDERS[id].title });
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
  if (!t) return tr("Comprobando sesión…");
  const meta = PROVIDERS[id];
  const installable = !!(meta.npmPkg || meta.installCmdPs);
  if (!t.installed) return installable ? tr("CLI sin instalar · instalable aquí") : tr("CLI sin instalar");
  if (!t.logged_in) return t.error ? tr("Instalado · no se pudo comprobar la sesión") : tr("Instalado · falta iniciar sesión");
  if (id === "claude") return t.plan ? tr("Conectado · Plan {plan}", { plan: planLabel(t.plan) }) : tr("Conectado · Suscripción Claude");
  if (id === "codex") {
    if (t.auth_method === "chatgpt") return t.plan && t.plan !== "ChatGPT" ? tr("Conectado · Plan {plan}", { plan: planLabel(t.plan) }) : tr("Conectado · Suscripción ChatGPT");
    if (t.auth_method === "api_key") return tr("Conectado · Clave API");
    return tr("Conectado · ChatGPT");
  }
  return tr("Conectado · Cuenta Antigravity");
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
        ? prov === "local"
          // Tras instalar, la terminal abierta aún no tiene Ollama en el PATH: se usa su ruta.
          ? `${cmd}; if ($?) { & "$env:LOCALAPPDATA\\Programs\\Ollama\\ollama.exe" pull qwen2.5-coder:7b }`
          : `${cmd}; if ($?) { $agy = "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"; if (Test-Path $agy) { & $agy acp --login } }`
        : `${cmd} && ${meta.loginCmd}`;
    }
  } else if (meta.npmPkg) {
    cmd = ps
      ? `npm install -g ${meta.npmPkg}; if ($?) { ${meta.loginCmd} }`
      : `npm install -g ${meta.npmPkg} && ${meta.loginCmd}`;
  }
  if (!cmd) { void openExternal(meta.docsUrl); return; }
  const r = await showDialog({
    title: tr("Instalar y conectar {account}", { account: meta.accountTitle }),
    message: tr("Se ejecutará en la terminal integrada:") + "\n" + cmd + "\n\n" + tr("Pulso no pide ni guarda claves: iniciarás sesión directamente en la herramienta oficial."),
    buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Instalar y conectar"), value: "ok", primary: true }],
  });
  if (r !== "ok") return;
  onDone?.();
  switchProvider(prov);
  watchLogin(prov, 1000);
  void runInTerminal(cmd);
}

function buildAccountsList(onClose?: () => void): HTMLElement {
  const list = h("div", "ai-acct-list");
  for (const id of ["claude", "codex", "antigravity", "local"] as const) {
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
      const btn = h("button", "ai-acct-btn", canInstall ? tr("Instalar y conectar") : tr("Cómo instalar"));
      btn.type = "button";
      btn.onclick = () => {
        if (canInstall) void installAndConnect(id, onClose);
        else void openExternal(meta.docsUrl);
      };
      row.append(btn);
    } else if (!t.logged_in) {
      const btn = h("button", "ai-acct-btn primary", tr("Conectar"));
      btn.type = "button";
      btn.onclick = () => {
        onClose?.();
        switchProvider(id);
        startLoginFlow(id);
      };
      row.append(btn);
    } else if (isCurrent) {
      row.append(h("span", "ai-acct-badge", tr("En uso")));
    } else {
      const btn = h("button", "ai-acct-btn", tr("Usar"));
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
    head.append(h("span", "ai-usage-group", tr("Cuentas y suscripciones")));
    const checkBtn = h("button", "ai-usage-sync", tr("Comprobar"));
    checkBtn.type = "button";
    checkBtn.onclick = () => {
      checkBtn.disabled = true;
      checkBtn.textContent = tr("Comprobando…");
      toolAt = 0;
      void detect(true).finally(() => { if (pop.isConnected) render(); });
    };
    head.append(checkBtn);
    pop.append(
      head,
      h("div", "ai-usage-note", tr("Cada proveedor administra su sesión en su CLI oficial. Pulso detecta cuáles tienes activas para habilitar sus modelos.")),
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
  pop.setAttribute("aria-label", tr("Seleccionar proveedor y modelo"));
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
    pop.append(h("div", "ai-pop-head", tr("Herramienta")), buildProviderTabs(() => {
      const target = tools[activeProvider];
      if (target && !target.logged_in) { dismissPopover(); return; }
      specificOpen = providerCatalog(activeProvider).specific.some((m) => m.value === model);
      syncModelButton();
      render();
      if (usageSideOpen) renderSideUsage();
    }));
    pop.append(h("div", "ai-pop-sep"), h("div", "ai-pop-head", tr("Modelo · {provider}", { provider: meta.short })));

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
        writeStorage(meta.modelKey, model);
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
      toggleMain.append(h("span", "ai-pop-name", tr("Más modelos ({count})", { count: cat.specific.length })));
      toggleSpec.append(toggleMain, h("span", "ai-pop-chev", specificOpen ? "▾" : "›"));
      toggleSpec.onclick = () => { specificOpen = !specificOpen; render(); };
      listBox.append(h("div", "ai-pop-sep"), toggleSpec);
      if (specificOpen) for (const m of cat.specific) addOption(m);
    }

    const custom = h("button", "ai-pop-item ai-pop-custom");
    custom.type = "button";
    const customMain = h("span", "ai-pop-main");
    customMain.append(h("span", "ai-pop-name", tr("Otro ID de modelo…")), h("span", "ai-pop-tier", tr("Manual")));
    custom.append(customMain);
    custom.onclick = async () => {
      dismissPopover();
      const entered = await promptText({ title: tr("Identificador exacto del modelo"), value: model, placeholder: cat.models[1]?.value ?? "modelo" });
      if (!entered) return;
      model = entered.trim();
      writeStorage(meta.modelKey, model);
      syncModelButton();
    };
    listBox.append(custom);
    pop.append(listBox);

    if (meta.supportsEffort && (activeProvider !== "antigravity" || !model)) {
      const effBox = h("div", "ai-pop-effort");
      effBox.append(h("span", "ai-pop-effort-lbl", tr("Esfuerzo")));
      const pills = h("div", "ai-effort-pills");
      for (const e of EFFORTS) {
        const b = h("button", `ai-effort-pill${effort === e.value ? " active" : ""}`, e.label);
        b.type = "button";
        b.onclick = () => {
          effort = e.value;
          writeStorage("pulso.ai.effort", effort);
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
    usageMain.append(gIcon, h("span", "ai-pop-name", tr("Ver uso y límites")));
    viewUsage.append(usageMain, h("span", "ai-pop-chev", "›"));
    viewUsage.onmouseenter = () => openSideUsage();
    viewUsage.onclick = () => {
      if (usageSideOpen) { usageSideOpen = false; renderSideUsage(); render(); }
      else { openSideUsage(); render(); }
    };

    const manage = h("button", "ai-pop-item ai-pop-subtoggle");
    manage.type = "button";
    const manageMain = h("span", "ai-pop-main");
    manageMain.append(h("span", "ai-pop-name", tr("Cuentas y suscripciones…")));
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
  if (b.window === "5h") return tr("Límite 5 h");
  if (b.window === "weekly") return tr("Límite semanal");
  return b.name || tr("Límite");
}

function fillQuotaCard(card: HTMLElement) {
  const meta = PROVIDERS[activeProvider];
  const curUsage = providerUsage();
  card.replaceChildren();
  const head = h("div", "ai-inst-head");
  const headLeft = h("div", "ai-inst-head-left");
  const planBadgeText = activeProvider === "claude"
    ? (tool?.plan ? tr("Plan {plan}", { plan: planLabel(tool.plan) }) : tr("Conectado"))
    : activeProvider === "codex"
      ? (tool?.plan && tool.plan !== "ChatGPT" ? tr("Plan {plan}", { plan: planLabel(tool.plan) }) : "ChatGPT")
      : (tool?.plan || meta.short);
  headLeft.append(
    h("span", "ai-inst-kicker", tr("Cuotas del plan")),
    h("span", "ai-inst-plan", planBadgeText),
  );
  const syncBtn = h("button", "ai-inst-sync", usageSyncing ? tr("Actualizando…") : tr("Sincronizar"));
  syncBtn.type = "button";
  syncBtn.disabled = usageSyncing;
  syncBtn.title = tr("Actualizar límites disponibles del plan");
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = tr("Actualizando…");
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
          top.append(h("span", "ai-inst-lbl", `${g.name} · ${agyBucketLabel(b)}`), h("span", "ai-inst-val", tr("{pct} disp.", { pct: remainingPercent(w) })));
          const track = h("div", "ai-inst-track");
          const rem = remainingRatio(w);
          const bar = h("div", `ai-inst-fill${rem <= 0.1 ? " high" : rem <= 0.3 ? " warn" : ""}`);
          bar.style.width = `${Math.round(rem * 100)}%`;
          track.append(bar);
          const cd = resetCountdown(w);
          const reset = cd && cd !== "ahora" ? tr("Se reinicia en {time}", { time: cd }) : resetClockText(w);
          row.append(top, track);
          if (reset) row.append(h("div", "ai-inst-sub", reset));
          meters.append(row);
        }
      }
    } else {
      card.append(h("div", "ai-inst-note", tr("Consultando límites de Antigravity…")));
      return;
    }
    card.append(meters);
    return;
  }

  const meters = h("div", "ai-inst-meters");
  for (const [label, w] of [[tr("Ventana 5 h"), curUsage.fiveHour], [tr("Semanal"), curUsage.sevenDay]] as const) {
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
      ? (usageSyncing ? tr("Leyendo /usage…") : tr("Sin datos en esta ventana"))
      : tr("Consultando límites de ChatGPT…");
    const reset = cd && cd !== "ahora" ? tr("Se reinicia en {time}", { time: cd }) : (clock || emptyMsg);
    row.append(top, track, h("div", "ai-inst-sub", reset));
    meters.append(row);
  }
  card.append(meters);

  if (activeProvider === "claude" && usageError) {
    card.append(h("div", "ai-inst-note err", usageError));
  } else if (activeProvider === "claude" && usageSyncing) {
    card.append(h("div", "ai-inst-note", tr("Sincronizando límites reales con Claude Code…")));
  }
}

function fillScopeStrip(box: HTMLElement, ctx: EditorContext) {
  box.replaceChildren();
  const label = h("span", "ai-scope-lbl", tr("Alcance"));
  const pills = h("div", "ai-scope-pills");
  if (ctx.file) {
    pills.append(h("span", "ai-scope-item active", baseName(ctx.file)));
  } else {
    pills.append(h("span", "ai-scope-item", tr("Sin archivo activo")));
  }
  if (ctx.selection) {
    pills.append(h("span", "ai-scope-item sel", `L${ctx.selection.startLine}–${ctx.selection.endLine}`));
  }
  for (const ex of extraFiles) {
    if (ex !== ctx.file) pills.append(h("span", "ai-scope-item", baseName(ex)));
  }
  const add = h("button", "ai-scope-add", tr("+ Adjuntar"));
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
  const sub = cd && cd !== "ahora" ? tr("Se reinicia en {time}", { time: cd }) : clock || emptyText;
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
  head.append(h("span", "ai-usage-group", tr("Uso")));
  const syncBtn = h("button", "ai-usage-sync", usageSyncing ? tr("Actualizando…") : tr("Actualizar"));
  syncBtn.type = "button";
  syncBtn.disabled = usageSyncing;
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = tr("Actualizando…");
    void syncAccountAndUsage().finally(onRefreshDone);
  };
  head.append(syncBtn);
  pop.append(head);

  const order: AiProvider[] = [prov, ...(["claude", "codex", "antigravity", "local"] as const).filter((p) => p !== prov && !!tools[p]?.logged_in)];
  for (const id of order) {
    const t = tools[id] ?? (id === prov ? tool : null);
    if (id === "antigravity") {
      if (agyUsage?.groups?.length) {
        for (const g of agyUsage.groups) {
          const sec = h("div", "ai-usage-section");
          sec.append(h("div", "ai-usage-sec-title", g.name));
          for (const b of g.buckets) {
            sec.append(usageRingRow(agyBucketLabel(b), agyWindowFromBucket(b), tr("Sin datos")));
          }
          pop.append(sec);
        }
      } else {
        const sec = h("div", "ai-usage-section");
        sec.append(h("div", "ai-usage-sec-title", "Antigravity"), h("div", "ai-usage-note", tr("Consultando límites de tu cuenta…")));
        pop.append(sec);
      }
      continue;
    }
    const sec = h("div", "ai-usage-section");
    if (id === "local") {
      // Un modelo local no tiene cuotas ni límites de plan.
      sec.append(h("div", "ai-usage-sec-title", "Ollama (local)"), h("div", "ai-usage-note", tr("Se ejecuta en este equipo: sin límites de uso.")));
      pop.append(sec);
      continue;
    }
    if (id === "claude") {
      const cur = providerUsage("claude");
      const title = t?.plan ? "Claude Code · " + tr("Plan {plan}", { plan: planLabel(t.plan) }) : "Claude Code";
      sec.append(
        h("div", "ai-usage-sec-title", title),
        usageRingRow(tr("Límite semanal"), cur.sevenDay, usageSyncing ? tr("Consultando /usage…") : tr("Pendiente de lectura")),
        usageRingRow(tr("Límite 5 h"), cur.fiveHour, usageSyncing ? tr("Consultando /usage…") : tr("Pendiente de lectura")),
      );
      if (usageError) sec.append(h("div", "ai-usage-note err", usageError));
    } else {
      const cur = providerUsage("codex");
      const title = t?.plan && t.plan !== "ChatGPT" ? "ChatGPT / Codex · " + tr("Plan {plan}", { plan: planLabel(t.plan) }) : "ChatGPT / Codex";
      sec.append(
        h("div", "ai-usage-sec-title", title),
        usageRingRow(tr("Límite semanal"), cur.sevenDay, tr("Consultando app-server…")),
        usageRingRow(tr("Límite 5 h"), cur.fiveHour, tr("Consultando app-server…")),
      );
    }
    pop.append(sec);
  }

  const convo = current?.convo;
  if (convo && (convo.model || convo.outcome)) {
    const sess = h("div", "ai-usage-sess");
    if (convo.model) sess.append(h("div", "ai-usage-meta", tr("Modelo activo: {model}", { model: formatModelName(convo.model) })));
    if (convo.outcome?.durationMs) sess.append(h("div", "ai-usage-meta", tr("Último turno: {secs} s", { secs: seconds(convo.outcome.durationMs) })));
    if (convo.outcome && convo.outcome.costUsd > 0) sess.append(h("div", "ai-usage-meta", tr("Coste reportado: {cost}", { cost: "$" + convo.outcome.costUsd.toFixed(4) })));
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
  pop.append(h("div", "ai-pop-head", tr("Acciones rápidas")));
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

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "");
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

function makeThumbnail(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 320;
      const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(dataUrl.length <= 35_000 ? dataUrl : ""); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      } catch {
        resolve(dataUrl.length <= 35_000 ? dataUrl : "");
      }
    };
    img.onerror = () => resolve("");
    img.src = dataUrl;
  });
}

async function openImageLightbox(img: UserImage) {
  document.querySelector(".ai-lightbox")?.remove();
  const backdrop = h("div", "ai-lightbox");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", img.name);
  const frame = h("div", "ai-lightbox-frame");
  const head = h("div", "ai-lightbox-head");
  head.append(h("span", "ai-lightbox-name", img.name));
  const closeBtn = h("button", "icon-btn ai-lightbox-close", "×");
  closeBtn.type = "button";
  closeBtn.title = tr("Cerrar (Esc)");
  closeBtn.setAttribute("aria-label", tr("Cerrar"));
  const close = () => {
    window.removeEventListener("keydown", onEsc, true);
    backdrop.remove();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  closeBtn.onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  window.addEventListener("keydown", onEsc, true);
  head.append(closeBtn);
  const pic = document.createElement("img");
  pic.className = "ai-lightbox-img";
  pic.alt = img.name;
  pic.draggable = false;
  if (img.preview) pic.src = img.preview;
  frame.append(head, pic);
  backdrop.append(frame);
  document.body.append(backdrop);
  if (img.path && "__TAURI_INTERNALS__" in window) {
    try {
      const full = await invoke<string>("ai_read_image_data_url", { path: img.path });
      if (document.body.contains(pic)) pic.src = full;
    } catch { /* se queda la miniatura */ }
  }
}

function collectReferencedImagePaths(): string[] {
  const paths = new Set<string>();
  const scanTurns = (turns: readonly Turn[]) => {
    for (const turn of turns) {
      for (const b of turn.blocks) {
        if (b.kind === "image" && b.path) paths.add(b.path);
      }
    }
  };
  for (const c of loadChats()) scanTurns(c.messages);
  for (const l of lives.values()) scanTurns(l.convo.messages);
  for (const img of attachedImages) if (img.path) paths.add(img.path);
  return Array.from(paths);
}

function pruneUnusedImages() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void invoke("ai_prune_images", { keepPaths: collectReferencedImagePaths() }).catch(() => {});
}

async function addImageFiles(files: Iterable<File>) {
  if (!ws.root) { setStatus(tr("Abre una carpeta primero")); return; }
  for (const file of files) {
    if (attachedImages.length >= MAX_IMAGES) {
      setStatus(tr("Puedes adjuntar como máximo {max} imágenes por mensaje", { max: MAX_IMAGES }), 4000);
      break;
    }
    const mime = file.type.toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      setStatus(tr("Formato no soportado ({name}). Usa PNG, JPG, WEBP o GIF.", { name: file.name || mime || "archivo" }), 4500);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus(tr("La imagen {name} supera el límite de 10 MB", { name: file.name || "imagen" }), 4500);
      continue;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) continue;
      const base64 = dataUrl.slice(comma + 1);
      const saved = await invoke<{ path: string; name: string }>("ai_save_image", {
        name: file.name || null,
        mime,
        dataBase64: base64,
      });
      const preview = await makeThumbnail(dataUrl);
      attachedImages.push({ path: saved.path, name: saved.name, ...(preview ? { preview } : {}) });
      renderChips();
    } catch (e) {
      setStatus(tr("No se pudo adjuntar la imagen: {error}", { error: String(e) }), 5000);
    }
  }
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

function addContextNote(note: ContextNote) {
  extraNotes = [...extraNotes.filter((n) => n.id !== note.id), note];
  renderChips();
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

function attachProjectFileOnly() {
  if (!ws.root) { setStatus(tr("Abre una carpeta primero")); return; }
  quickPick({
    placeholder: tr("Adjuntar archivo del proyecto al contexto…"),
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

async function attachGitChanges() {
  if (!ws.root) { setStatus(tr("Abre una carpeta primero")); return; }
  try {
    const c = await invoke<Changes>("git_changes", { root: ws.root });
    const lines: string[] = [`Rama: ${c.branch}`];
    if (c.conflicted.length) lines.push("Conflictos:\n" + c.conflicted.map((x) => `  ! ${x.path}`).join("\n"));
    if (c.staged.length) lines.push("Preparados:\n" + c.staged.map((x) => `  ${x.status} ${x.path}`).join("\n"));
    if (c.unstaged.length) lines.push("Sin preparar:\n" + c.unstaged.map((x) => `  ${x.status} ${x.path}`).join("\n"));
    const total = c.conflicted.length + c.staged.length + c.unstaged.length;
    if (!total) { setStatus(tr("No hay cambios de Git pendientes para adjuntar")); return; }
    addContextNote({
      id: "git:changes",
      label: tr("Git · {count} cambios", { count: total }),
      title: tr("Cambios de Git en rama «{branch}»", { branch: c.branch }),
      body: lines.join("\n\n"),
    });
  } catch (e) {
    setStatus(String(e));
  }
}

async function attachGithubIssue() {
  const repo = await currentRepo();
  if (!repo) { setStatus(tr("Esta carpeta no tiene un remoto de GitHub.")); return; }
  quickPick({
    placeholder: tr("Adjuntar issue de GitHub al contexto…"),
    empty: tr("No hay issues abiertas"),
    load: async () => {
      const issues = await fetchIssues(repo.owner, repo.repo, "open");
      return issues.map<PickItem>((i) => ({
        label: `#${i.number} ${i.title}`,
        detail: i.labels.map((l) => l.name).join(", "),
        run: () => addContextNote({
          id: `issue:${i.number}`,
          label: `Issue #${i.number}`,
          title: `Issue #${i.number}: ${i.title}`,
          body: (i.body?.trim() || i.title) + `\n\nURL: ${i.html_url}`,
        }),
      }));
    },
  });
}

async function attachGithubPr() {
  const repo = await currentRepo();
  if (!repo) { setStatus(tr("Esta carpeta no tiene un remoto de GitHub.")); return; }
  quickPick({
    placeholder: tr("Adjuntar pull request de GitHub al contexto…"),
    empty: tr("No hay pull requests abiertas"),
    load: async () => {
      const prs = await listPulls(repo.owner, repo.repo, "open");
      return prs.map<PickItem>((p) => ({
        label: `PR #${p.number} ${p.title}`,
        detail: `${p.head.ref} → ${p.base.ref}`,
        run: () => addContextNote({
          id: `pr:${p.number}`,
          label: `PR #${p.number}`,
          title: `Pull Request #${p.number}: ${p.title} (${p.head.ref} → ${p.base.ref})`,
          body: (p.body?.trim() || p.title) + `\n\nURL: ${p.html_url}`,
        }),
      }));
    },
  });
}

function attachProjectFile() {
  if (!ws.root) { setStatus(tr("Abre una carpeta primero")); return; }
  quickPick({
    placeholder: tr("¿Qué quieres adjuntar al contexto?"),
    load: () => [
      { label: tr("Archivo del proyecto…"), detail: tr("Añade una ruta del proyecto (también puedes escribir @archivo)"), run: attachProjectFileOnly },
      { label: tr("Cambios de Git actuales"), detail: tr("Rama activa y archivos modificados/preparados"), run: () => void attachGitChanges() },
      { label: tr("Issue de GitHub…"), detail: tr("Adjunta título y descripción de una issue abierta"), run: () => void attachGithubIssue() },
      { label: tr("Pull request de GitHub…"), detail: tr("Adjunta título, ramas y descripción de una PR abierta"), run: () => void attachGithubPr() },
    ],
  });
}

function usageText(): string {
  const prov = current?.convo.messages.length ? current.provider : activeProvider;
  const curTool = tools[prov] ?? tool;
  const curUsage = providerUsage(prov);
  const parts: string[] = [];
  if (curTool?.plan) parts.push(prov === "claude" ? tr("Plan {plan}", { plan: planLabel(curTool.plan) }) : `${PROVIDERS[prov].short} · ${planLabel(curTool.plan)}`);
  if (curUsage.fiveHour) parts.push(tr("5 h: {pct} disp.", { pct: remainingPercent(curUsage.fiveHour) }) + (resetIn(curUsage.fiveHour) ? ` (${resetIn(curUsage.fiveHour)})` : ""));
  if (curUsage.sevenDay) parts.push(tr("sem.: {pct} disp.", { pct: remainingPercent(curUsage.sevenDay) }));
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
  trigger.title = tr("Ver límites disponibles del plan");
  const pctText = curUsage.fiveHour ? tr("{pct} disp.", { pct: remainingPercent(curUsage.fiveHour) }) : curUsage.sevenDay ? tr("{pct} sem.", { pct: remainingPercent(curUsage.sevenDay) }) : tr("Ver uso");
  trigger.append(usageRing(hasWindows ? ratioLeft : 0, 14), h("span", "", pctText));
  trigger.onclick = () => openUsagePopover(trigger);

  if (!text || !hasWindows) {
    foot.append(h("span", "ai-foot-text", `${text ? `${text} · ` : ""}${tr("Usa tu sesión de {provider}", { provider: PROVIDERS[prov].title })}`), trigger);
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
  accts.append(h("div", "ai-inst-kicker", tr("Tus cuentas y suscripciones")), buildAccountsList());
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
      if (!wasLogged) setStatus(tr("{provider} conectado", { provider: PROVIDERS[prov].title }), 4000);
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

  const modeShort = mode === "full" ? tr("Agente") : mode === "edit" ? tr("Puede editar") : tr("Solo leer");
  const modeCls = mode === "full" ? " full" : mode === "edit" ? " edit" : "";
  const eyebrow = h("div", "ai-bench-eyebrow");
  eyebrow.append(
    h("span", `ai-meta-pill${modeCls}`, modeShort),
    buildProviderTabs(),
  );

  const hero = h("div", "ai-bench-hero");
  const wsName = baseName(ws.root ?? "") || tr("Proyecto");
  hero.append(
    h("div", "ai-empty-title", tr("Mesa de trabajo · {folder}", { folder: wsName })),
    h("p", "ai-bench-lead", tr("Conversa directo sobre el código abierto usando tu sesión local de {provider}, sin claves almacenadas.", { provider: meta.title })),
  );

  const scope = h("div", "ai-scope-strip");
  fillScopeStrip(scope, editorContext());

  const exWrap = h("div", "ai-examples");
  for (const ex of EXAMPLES) {
    const b = h("button", "ai-example");
    b.type = "button";
    b.append(h("span", "ai-example-tag", ex.tag), h("span", "ai-example-main", ex.label));
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
  thLeft.append(h("span", "ai-inst-kicker", tr("Sesiones recientes")));
  const allBtn = h("button", "ai-inst-sync", tr("Ver todo"));
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
      h("div", "ai-spec-row", tr("Motor activo: {model}", { model: activeOpt.label })),
      h("div", "ai-spec-row", tr("Esfuerzo: {effort} · Modo: {mode}", { effort: effOpt, mode: mode === "full" ? tr("Agente completo") : mode === "edit" ? tr("Edición directa") : tr("Solo lectura") })),
      h("div", "ai-inst-note", tr("Tus hilos guardados en {folder} aparecerán aquí para retomarlos en un clic.", { folder: wsName })),
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
  card.setAttribute("aria-label", tr("Permiso requerido por el agente"));

  const wantsFull = mode !== "read" || needsCommandPermission(actions);
  const targetMode: AiMode = wantsFull ? "full" : "edit";
  const targetLabel = targetMode === "full" ? tr("Agente") : tr("Puede editar");

  const head = h("div", "ai-denial-head");
  head.append(
    h("span", "ai-denial-badge", "PERMISO REQUERIDO"),
    h("span", "ai-denial-title", denials === 1 ? tr("El agente necesitó ejecutar una acción bloqueada") : tr("El agente necesitó ejecutar {count} acciones bloqueadas", { count: denials })),
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
      ? tr("El modo actual no permite ejecutar comandos de terminal (como run_command o Bash). Aprueba esta acción para que el agente pueda completar la tarea.")
      : tr("El modo «Solo leer» impide modificar archivos. Aprueba la edición para que el agente pueda continuar.");
    card.append(h("p", "ai-denial-msg", explain));
  }

  const acts = h("div", "ai-denial-acts");
  const onceBtn = h("button", "ai-denial-btn primary", tr("Permitir una vez y continuar"));
  onceBtn.type = "button";
  onceBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    const contPrompt = targetMode === "full"
      ? "El usuario aprobó ejecutar el comando o herramienta que quedó bloqueada en el paso anterior. Ejecútalo ahora y completa la tarea pendiente."
      : "El usuario aprobó modificar archivos para el paso anterior. Aplica los cambios y completa la tarea pendiente.";
    void dispatchPrompt(live, tr("Permiso concedido (una vez) · continuar"), contPrompt, targetMode);
  };

  const switchBtn = h("button", "ai-denial-btn", tr("Activar «{mode}» y continuar", { mode: targetLabel }));
  switchBtn.type = "button";
  switchBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    mode = targetMode;
    writeStorage("pulso.ai.mode", mode);
    writeStorage(targetMode === "full" ? "pulso.ai.fullOk" : "pulso.ai.editOk", "1");
    build();
    const contPrompt = targetMode === "full"
      ? "El usuario activó el modo Agente completo (edición y comandos de terminal aprobados). Ejecuta lo que quedó pendiente y completa la tarea."
      : "El usuario activó el modo Puede editar. Aplica los cambios y completa la tarea pendiente.";
    void dispatchPrompt(live, tr("Modo «{mode}» activado · continuar", { mode: targetLabel }), contPrompt, targetMode);
  };

  const dismissBtn = h("button", "ai-denial-btn ghost", tr("No permitir"));
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
  const prBtn = h("button", "ai-issue-btn primary", tr("Crear PR"));
  prBtn.type = "button";
  prBtn.title = tr("Crear pull request enlazando Closes #{number}", { number: work.number });
  prBtn.onclick = () => {
    const files = current ? touchedFiles(current.convo.messages) : [];
    void createPrForActiveIssue(files);
  };
  const endBtn = h("button", "ai-issue-btn", tr("Finalizar"));
  endBtn.type = "button";
  endBtn.title = tr("Dejar de asociar esta issue al asistente");
  endBtn.onclick = () => { clearActiveIssueWork(); renderIssueBanner(); };
  acts.append(prBtn, endBtn);
  banner.replaceChildren(info, acts);
}

/** Caché incremental de nodos renderizados por turno: evita reconstruir toda la conversación en cada token (O(1) por frame). */
interface TurnCacheEntry { parts: Turn[]; active: boolean; activitySig: string; slot: HTMLElement }

const activitySignature = (t: Turn, active: boolean): string => {
  if (t.role !== "assistant") return "";
  const { activity } = splitAssistantTurn(t.blocks);
  return `${active ? "1" : "0"}:${activity.length}:${activity.map((b) => (b.kind === "tool" ? `${b.id}:${b.result?.length ?? 0}:${b.error ? 1 : 0}` : b.kind === "image" ? b.name : `${b.kind}:${b.text.length}`)).join(",")}`;
};

/** ¿Son los mismos turnos originales, en el mismo orden? (si sí, el nodo ya pintado sirve) */
const sameParts = (a: Turn[], b: Turn[]) => a.length === b.length && a.every((t, i) => t === b[i]);
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
    else if (prov === "claude") sub.textContent = `Claude Code${curTool.version ? ` ${curTool.version.split(" ")[0]}` : ""}${curTool.plan ? " · " + tr("plan {plan}", { plan: planLabel(curTool.plan) }) : ""}`;
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
      ? (curTool?.plan ? tr("Plan {plan}", { plan: planLabel(curTool.plan) }) : tr("Conectado"))
      : prov === "codex"
        ? (curTool?.auth_method === "api_key" ? "Codex API" : curTool?.plan && curTool.plan !== "ChatGPT" ? `ChatGPT ${planLabel(curTool.plan)}` : "ChatGPT")
        : prov === "local" ? "Ollama" : (curTool?.plan || "Antigravity");
  }
  const histBtn = q<HTMLButtonElement>(`.ai-tools button[title="${CSS.escape(tr("Conversaciones anteriores"))}"]`);
  if (histBtn) { histBtn.classList.toggle("active", historyOpen); histBtn.setAttribute("aria-pressed", String(historyOpen)); }
  renderIssueBanner();
  renderFoot();
  const recheck = () => { toolAt = 0; void detect(true); };
  const ready = !!curTool?.installed && curTool.logged_in && !!ws.root;
  compose.hidden = !ready || historyOpen;
  if (!curTool) { resetTurnCache(); body.replaceChildren(setupMessage(tr("Detectando {provider}", { provider: meta.title }), tr("Comprobando sesión y estado de tu cuenta…"))); return; }
  if (!curTool.installed) {
    resetTurnCache();
    const canInstall = !!(meta.npmPkg || meta.installCmdPs);
    const installBtn = canInstall ? (() => { const b = h("button", "foot-btn ai-btn-primary", tr("Instalar y conectar")); b.type = "button"; b.onclick = () => void installAndConnect(prov); return b; })() : null;
    const again = h("button", canInstall ? "foot-btn foot-btn-line" : "foot-btn ai-btn-primary", tr("Volver a comprobar")); again.type = "button"; again.onclick = recheck;
    const guide = h("button", "foot-btn foot-btn-line", tr("Cómo instalarlo")); guide.type = "button"; guide.onclick = () => void openExternal(meta.docsUrl);
    const extraBtns: HTMLElement[] = [...(installBtn ? [installBtn] : []), again, guide];
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", tr("Volver a Claude Code")); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(tr("{provider} no está instalado", { provider: meta.title }), meta.installHint, ...extraBtns));
    return;
  }
  if (!curTool.logged_in) {
    resetTurnCache();
    const login = h("button", "foot-btn ai-btn-primary", meta.loginBtn); login.type = "button";
    login.onclick = () => startLoginFlow(prov);
    const again = h("button", "foot-btn foot-btn-line", prov === "local" ? tr("Volver a comprobar") : tr("Ya inicié sesión: volver a comprobar")); again.type = "button"; again.onclick = recheck;
    const extraBtns: HTMLElement[] = [login, again];
    // Para Ollama «sin sesión» significa que no hay ningún modelo descargado.
    const couldNotCheck = !!curTool.error && prov !== "local";
    const title = couldNotCheck ? tr("No se pudo comprobar tu sesión de {provider}", { provider: meta.title }) : prov === "claude" ? tr("Inicia sesión para cargar tu plan") : prov === "local" ? tr("Descarga un modelo para Ollama") : tr("Inicia sesión en {provider}", { provider: meta.title });
    const desc = couldNotCheck
      ? tr("{provider} está instalado, pero no se pudo comprobar si hay una sesión iniciada (puede ser algo puntual). Pulsa «volver a comprobar»; si sigue igual, inicia sesión de nuevo.", { provider: meta.title })
      : prov === "local"
      ? tr("Ollama está en marcha pero no tiene ningún modelo. «Descargar un modelo» baja qwen2.5-coder:7b (unos 4,7 GB) en la terminal integrada; también puedes descargar otro con «ollama pull <modelo>».")
      : prov === "claude"
      ? tr("Claude Code está instalado pero no hay una sesión iniciada. Se abrirá el inicio de sesión y tu plan se cargará al instante.")
      : tr("{provider} está instalado pero no hay una sesión iniciada. Se abrirá el inicio de sesión en la terminal integrada.", { provider: meta.title });
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", tr("Volver a Claude Code")); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(title, desc, ...extraBtns));
    return;
  }
  if (!ws.root) { resetTurnCache(); body.replaceChildren(setupMessage(tr("Abre un proyecto"), tr("Abre una carpeta de proyecto para que el asistente pueda leer tu código y ayudarte dentro de ella."))); return; }
  if (historyOpen) { resetTurnCache(); renderHistory(body); return; }

  if (current && !sameDir(current.cwd, ws.root)) {
    if (current.convo.messages.length) persist(current, true);
    else lives.delete(current.id);
    current = null;
    resetTurnCache();
  }
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

    const view = mergeAssistantRuns(c.messages);
    // Recortar turnos sobrantes si la lista se acortó.
    while (renderedTurns.length > view.length) {
      renderedTurns.pop()?.slot.remove();
    }

    let userNum = 0;
    view.forEach(({ turn: t, parts }, idx) => {
      if (t.role === "user") userNum += 1;
      const activeTurn = c.running && idx === view.length - 1 && t.role === "assistant";
      const existing = renderedTurns[idx];
      if (existing && sameParts(existing.parts, parts) && existing.active === activeTurn) {
        return; // Sin cambios: conserva el DOM y cualquier selección de texto del usuario.
      }
      const slot = existing ? existing.slot : h("div", "ai-turn-slot");
      if (!existing) {
        turnsHost!.append(slot);
      }
      const nextActSig = activitySignature(t, activeTurn);
      if (existing && t.role === "assistant" && existing.activitySig === nextActSig) {
        // Solo cambió el texto en curso: conservar la tarjeta de actividad para no reiniciar su pulso ni provocar saltos.
        const { final } = splitAssistantTurn(t.blocks);
        let wrap = slot.querySelector<HTMLElement>(":scope > .ai-assistant");
        if (final.trim()) {
          if (!wrap) { wrap = h("div", "ai-assistant"); slot.append(wrap); }
          wrap.replaceChildren(...markdown(final));
        } else {
          wrap?.remove();
        }
      } else {
        slot.replaceChildren(...turnNodes(t, userNum, activeTurn));
      }
      renderedTurns[idx] = { parts: [...parts], active: activeTurn, activitySig: nextActSig, slot };
    });

    const tailNodes: HTMLElement[] = [];
    const last = c.messages[c.messages.length - 1];
    const lastSlot = renderedTurns[renderedTurns.length - 1]?.slot;
    const hasRunningTrace = c.running && !!lastSlot?.querySelector(".ai-activity.running");
    if (c.running && (!last || last.role === "user" || (!last.done && !hasRunningTrace))) {
      // Aún no llegó nada del asistente: la misma tarjeta de actividad, para que no cambie de forma al empezar a responder.
      tailNodes.push(activityCard(`${live.id}:espera:${c.messages.length}`, [], true));
    }
    if (c.error) {
      const e = h("div", "ai-error");
      e.append(h("div", "", c.error));
      if (isAuthError(c.error)) {
        const b = h("button", "foot-btn foot-btn-line", tr("Iniciar sesión en la terminal")); b.type = "button";
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
        pbox.append(h("span", "ai-touched-label", tr("Revisar cambios propuestos ({count}):", { count: proposals.length })));
        for (const edit of proposals) {
          const pkey = `${live.id}:${lastAssistant?.id ?? ""}:${edit.path}`;
          const st = proposalStatus.get(pkey);
          const label = st === "applied" ? `${baseName(edit.path)} ✓` : st === "discarded" ? `${baseName(edit.path)} ✕` : `Diff: ${baseName(edit.path)}`;
          const btn = h("button", `ai-prop-btn${st ? ` ${st}` : ""}`, label);
          btn.type = "button";
          btn.title = tr("{path} — Revisar diferencias antes de aplicar", { path: edit.path });
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
          box.append(h("span", "ai-touched-label", tr("Archivos modificados:")));
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
        const secs = c.outcome.durationMs ? ` · ${seconds(c.outcome.durationMs)} s` : "";
        const modelTag = c.model ? ` · ${formatModelName(c.model)}` : "";
        const o = h("div", "ai-outcome", tr("Listo") + secs + modelTag);
        if (c.touched) o.append(" · " + (c.touched === 1 ? tr("1 archivo modificado") : tr("{count} archivos modificados", { count: c.touched })));
        if (c.outcome.denials) o.append(" · " + (c.outcome.denials === 1 ? tr("1 acción no permitida") : tr("{count} acciones no permitidas", { count: c.outcome.denials })));
        tailNodes.push(o);
      }
    }
    tailHost!.replaceChildren(...tailNodes);
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
  const send = q<HTMLButtonElement>(".ai-send")!;
  send.innerHTML = c.running ? ICON_STOP : ICON_SEND;
  send.title = c.running ? tr("Parar") : tr("Enviar (Enter)");
  send.setAttribute("aria-label", send.title);
  send.classList.toggle("stop", c.running);
  renderChips();
}

function renderHistory(body: HTMLElement) {
  const saved = chatsFor(loadChats(), ws.root ?? "");
  const rows: { id: string; title: string; when: number; running: boolean }[] = [];
  for (const l of lives.values()) if (l.convo.messages.length && ws.root && sameDir(l.cwd, ws.root)) rows.push({ id: l.id, title: titleFrom(l.convo.messages), when: Date.now(), running: l.convo.running });
  for (const c of saved) if (!rows.some((r) => r.id === c.id)) rows.push({ id: c.id, title: c.title, when: c.updatedAt, running: false });
  rows.sort((a, b) => b.when - a.when);
  const nodes: HTMLElement[] = [h("div", "ai-hist-title", tr("Conversaciones de este proyecto"))];
  if (!rows.length) nodes.push(h("div", "ai-hist-empty", tr("Aún no hay conversaciones guardadas.")));
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
    const del = iconBtn('<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>', tr("Eliminar esta conversación"), "ai-hist-del");
    del.onclick = () => { deleteChat(r.id); if (lives.get(r.id)?.convo.running) { void invoke("ai_stop", { id: r.id }); } lives.delete(r.id); if (current?.id === r.id) current = null; pruneUnusedImages(); renderBody(); };
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
      const prevSig = readStorage(USAGE_SIG_KEY);
      if (!nextClaude.logged_in || prevSig !== sig) {
        usage = {};
        usageError = "";
        removeStorage(USAGE_KEY);
      }
      tools.claude = nextClaude;
      tools.codex = all.codex;
      tools.antigravity = all.antigravity;
      tools.local = ("local" in all ? all.local : null) ?? null;
      tool = tools[activeProvider];

      if (nextClaude.logged_in) {
        writeStorage(USAGE_SIG_KEY, sig);
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
          setStatus(tr("Claude Code conectado · Plan {plan}", { plan: planLabel(curTool.plan) }), 4000);
        } else if (activeProvider !== "claude") {
          setStatus(tr("{provider} conectado", { provider: PROVIDERS[activeProvider].title }), 4000);
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

/** Mensajes anteriores en texto para el agente local (sin el último, que es el que se envía ahora). */
function localHistory(live: Live): { role: string; content: string }[] {
  return live.convo.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? splitAssistantTurn(m.blocks).final : m.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n"),
  })).filter((m) => m.content.trim()).slice(-30);
}

async function dispatchPrompt(live: Live, displayText: string, prompt: string, effectiveMode: AiMode, images: readonly UserImage[] = []) {
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
  apply(live, userEvent(displayText, images));
  try {
    // El agente local no guarda sesiones: recibe la conversación anterior (solo el texto) desde aquí.
    const sendModel = live.provider === "local" ? model || tools.local?.models?.[0]?.id || null : model || null;
    const history = live.provider === "local" ? localHistory(live) : null;
    const imagePaths = images.length ? images.map((i) => i.path) : null;
    await invoke("ai_send", { id: live.id, cwd: ws.root, prompt, session: live.convo.sessionId || null, model: sendModel, effort: useEffort, mode: effectiveMode, provider: live.provider, history, images: imagePaths });
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
  if (!text && !attachedImages.length) return;
  const imgs = [...attachedImages];
  const promptText = text || (imgs.length === 1 ? tr("Analiza la imagen adjunta.") : tr("Analiza las imágenes adjuntas."));
  const prompt = buildPrompt(promptText, editorContext());
  input.value = ""; autosize();
  attachedImages = [];
  extraNotes = [];
  renderChips();
  await dispatchPrompt(live, text, prompt, mode, imgs);
}

function newConversation() {
  dismissPopover();
  if (current && !current.convo.messages.length) { historyOpen = false; renderBody(); return; }
  current = newLive();
  extraFiles = [];
  extraNotes = [];
  attachedImages = [];
  historyOpen = false;
  renderBody();
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

function applyMode() {
  const v = viewEl();
  v.classList.toggle("ai-full", isFull());
  v.classList.toggle("ai-docked", !isFull());
  const expand = q<HTMLElement>(".ai-expand");
  if (expand) { expand.title = isFull() ? tr("Volver a la barra lateral (Esc)") : tr("Pantalla completa"); expand.setAttribute("aria-label", expand.title); expand.innerHTML = isFull() ? ICON_SHRINK : ICON_EXPAND; }
}

function setFull(full: boolean) {
  writeStorage(FULL_KEY, full ? "1" : "0");
  if (full) bus.emit("overlay", "ai");
  applyMode();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !closePopover && isFull() && !document.querySelector(".modal")) { e.preventDefault(); e.stopPropagation(); setFull(false); }
}

async function chooseMode(next: AiMode) {
  if (next === mode) return;
  if (next === "edit" && readStorage("pulso.ai.editOk") !== "1") {
    const msg = tr("Con «Puede editar», {provider} podrá modificar y crear archivos en tu proyecto sin preguntar cada vez. Verás los cambios en el panel de Git y podrás descartarlos. Si necesita ejecutar un comando de terminal, Pulso te pedirá permiso.", { provider: PROVIDERS[activeProvider].title });
    const r = await showDialog({
      title: tr("Permitir que la IA edite archivos"),
      message: msg,
      buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Permitir editar"), value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    writeStorage("pulso.ai.editOk", "1");
  } else if (next === "full" && readStorage("pulso.ai.fullOk") !== "1") {
    const msg = tr("Con «Agente», {provider} podrá modificar archivos Y ejecutar comandos de terminal (pruebas, búsquedas, diagnósticos, git, etc.) dentro de tu proyecto sin pedir confirmación en cada paso. Actívalo solo en proyectos en los que confíes.", { provider: PROVIDERS[activeProvider].title });
    const r = await showDialog({
      title: tr("Activar modo Agente completo"),
      message: msg,
      buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Activar modo Agente"), value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    writeStorage("pulso.ai.fullOk", "1");
  }
  mode = next;
  writeStorage("pulso.ai.mode", mode);
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
  planBtn.title = tr("Ver y conectar suscripciones (Claude, ChatGPT, Antigravity)");
  planBtn.onclick = () => openAccountsPopover(planBtn);
  titleRow.append(h("span", "ai-live-dot", ""), h("span", "ai-title", tr("Asistente")), planBtn);
  titles.append(titleRow, h("span", "ai-sub", ""));
  const tools = h("div", "ai-tools");
  const add = iconBtn(ICON_PLUS, tr("Nueva conversación")); add.onclick = newConversation;
  const hist = iconBtn(ICON_CLOCK, tr("Conversaciones anteriores")); hist.onclick = () => { historyOpen = !historyOpen; renderBody(); };
  const themeBtn = iconBtn(ICON_PALETTE, tr("Cambiar color de fondo")); themeBtn.onclick = () => openAppearancePopover(themeBtn);
  const expand = iconBtn(ICON_EXPAND, tr("Pantalla completa"), "ai-expand"); expand.onclick = () => setFull(!isFull());
  tools.append(add, hist, themeBtn, expand);
  head.append(titles, h("span", "grow"), tools);

  const body = h("div", "ai-body");
  body.tabIndex = 0;
  body.setAttribute("role", "log");
  body.setAttribute("aria-label", tr("Conversación con la IA"));

  const compose = h("form", "ai-compose");
  const mentionBox = h("div", "ai-mention");
  mentionBox.hidden = true;
  mentionBox.setAttribute("role", "listbox");
  mentionBox.setAttribute("aria-label", tr("Mencionar archivo del proyecto"));
  const dock = h("div", "ai-dock");
  const dockCtx = h("div", "ai-dock-ctx"); dockCtx.hidden = true;
  const chips = h("div", "ai-chips"); chips.hidden = true;
  dockCtx.append(h("span", "ai-dock-ctx-lbl", tr("Contexto")), chips);

  const inputWrap = h("div", "ai-input-wrap");
  const input = h("textarea", "ai-input");
  input.rows = 1; input.placeholder = tr("Describe el cambio, duda o archivo a inspeccionar…"); input.setAttribute("aria-label", tr("Mensaje para la IA")); input.value = keep;
  inputWrap.append(h("span", "ai-input-caret", "›"), input);

  const dockBar = h("div", "ai-dock-bar");
  const leftBar = h("div", "ai-dock-left");
  const attachBtn = iconBtn(ICON_PLUS, tr("Adjuntar archivo del proyecto"), "ai-compose-act");
  attachBtn.onclick = attachProjectFile;
  const imgInput = document.createElement("input");
  imgInput.type = "file";
  imgInput.accept = "image/png,image/jpeg,image/webp,image/gif";
  imgInput.multiple = true;
  imgInput.hidden = true;
  imgInput.onchange = () => {
    if (imgInput.files?.length) void addImageFiles(Array.from(imgInput.files));
    imgInput.value = "";
  };
  const imgBtn = iconBtn(ICON_IMAGE, tr("Adjuntar imagen (o pega con Ctrl+V)"), "ai-compose-act");
  imgBtn.onclick = () => imgInput.click();
  const quickBtn = iconBtn('<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>', tr("Acciones rápidas"), "ai-compose-act");
  quickBtn.onclick = () => openQuickPromptsPopover(quickBtn);

  const modelBtn = h("button", "ai-model-btn");
  modelBtn.type = "button";
  modelBtn.title = tr("Cambiar modelo y esfuerzo");
  modelBtn.setAttribute("aria-label", tr("Modelo"));
  modelBtn.append(h("span", "ai-model-btn-label", modelButtonText()), h("span", "ai-model-btn-chev", "⌄"));
  modelBtn.onclick = () => openModelPopover(modelBtn);

  const seg = h("div", "seg ai-mode");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", tr("Permisos"));
  const modeOptions: readonly [AiMode, string, string][] = [
    ["read", tr("Solo leer"), tr("La IA puede leer y buscar en tu proyecto, pero no modificarlo")],
    ["edit", tr("Puede editar"), tr("La IA puede editar archivos directamente. Si intenta ejecutar comandos, Pulso te pedirá permiso")],
    ["full", tr("Agente"), tr("La IA puede editar archivos y ejecutar comandos de terminal en tu proyecto para completar tareas")],
  ];
  for (const [value, label, hint] of modeOptions) {
    const b = h("button", "", label); b.type = "button"; b.title = hint; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(mode === value));
    b.onclick = () => void chooseMode(value);
    seg.append(b);
  }
  leftBar.append(attachBtn, imgBtn, imgInput, quickBtn, modelBtn, seg);

  const rightBar = h("div", "ai-dock-right");
  const sendBtn = h("button", "ai-send"); sendBtn.type = "submit"; sendBtn.innerHTML = ICON_SEND; sendBtn.title = tr("Enviar (Enter)"); sendBtn.setAttribute("aria-label", tr("Enviar"));
  rightBar.append(h("span", "ai-send-hint", "Enter ↵"), sendBtn);
  dockBar.append(leftBar, rightBar);
  dock.append(dockCtx, inputWrap, dockBar);
  compose.append(mentionBox, dock);

  let mentionItems: string[] = [];
  let mentionIdx = 0;
  let mentionStart = -1;
  let mentionQuery = "";
  const closeMention = () => { mentionBox.hidden = true; mentionItems = []; mentionStart = -1; };
  const pickMention = (file: string) => {
    if (mentionStart < 0) return;
    const end = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(end);
    const inserted = `@${file} `;
    input.value = `${before}${inserted}${after}`;
    input.selectionStart = input.selectionEnd = before.length + inserted.length;
    if (!extraFiles.includes(file)) extraFiles.push(file);
    closeMention();
    renderChips();
    autosize();
    input.focus();
  };
  const paintMention = () => {
    if (!mentionItems.length) { closeMention(); return; }
    mentionBox.replaceChildren(...mentionItems.map((file, i) => {
      const row = h("button", `ai-mention-item${i === mentionIdx ? " active" : ""}`);
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === mentionIdx));
      row.append(h("span", "ai-mention-name", baseName(file)));
      const dir = dirName(file);
      if (dir) row.append(h("span", "ai-mention-dir", dir));
      row.onmousedown = (e) => { e.preventDefault(); pickMention(file); };
      return row;
    }));
    mentionBox.hidden = false;
  };
  const updateMention = async () => {
    if (!ws.root) { closeMention(); return; }
    const hit = fileMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (!hit) { closeMention(); return; }
    mentionStart = hit.start;
    mentionQuery = hit.query;
    const root = ws.root;
    if (!mentionFiles || mentionFiles.root !== root) {
      try {
        const raw = await invoke<string[]>("list_files", { path: root });
        mentionFiles = { root, list: raw.map((p) => rel(p)).sort((a, b) => a.localeCompare(b)) };
      } catch {
        closeMention();
        return;
      }
    }
    if (ws.root !== root || mentionStart < 0) return;
    const again = fileMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (!again || again.query !== mentionQuery) return;
    mentionItems = filterProjectFiles(mentionFiles.list, again.query, 8);
    mentionIdx = 0;
    paintMention();
  };

  compose.onsubmit = (e) => { e.preventDefault(); closeMention(); void send(); };
  input.oninput = () => { autosize(); void updateMention(); };
  input.onblur = () => { window.setTimeout(closeMention, 120); };
  input.onkeydown = (e) => {
    if (!mentionBox.hidden && mentionItems.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = (mentionIdx + 1) % mentionItems.length; paintMention(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = (mentionIdx - 1 + mentionItems.length) % mentionItems.length; paintMention(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); pickMention(mentionItems[mentionIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  };
  input.onpaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void addImageFiles(files);
    }
  };
  dock.ondragover = (e) => {
    if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file" && it.type.startsWith("image/"))) {
      e.preventDefault();
      dock.classList.add("drag-over");
    }
  };
  dock.ondragleave = (e) => {
    if (!dock.contains(e.relatedTarget as Node | null)) dock.classList.remove("drag-over");
  };
  dock.ondrop = (e) => {
    dock.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addImageFiles(files);
    }
  };
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
      const raw = readStorage(INTERRUPTED_KEY);
      if (raw) {
        removeStorage(INTERRUPTED_KEY);
        const info = JSON.parse(raw) as { id?: string; cwd?: string };
        const saved = info.id ? loadChats().find((c) => c.id === info.id) : undefined;
        if (saved && (!ws.root || sameDir(saved.cwd, ws.root))) {
          const l = fromSaved(saved);
          lives.set(l.id, l);
          switchProvider(l.provider);
          current = l;
        }
      }
    } catch { /* nada que hacer */ }
    pruneUnusedImages();
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

/** ¿Hay alguna conversación de IA respondiendo actualmente en la carpeta indicada? */
export function hasRunningAiForWorkspace(root: string | null): boolean {
  if (!root) return false;
  for (const l of lives.values()) {
    if (l.convo.running && sameDir(l.cwd, root)) return true;
  }
  return false;
}

/** Detiene todas las conversaciones de IA en curso de la carpeta indicada. */
export async function stopRunningAiForWorkspace(root: string | null): Promise<void> {
  if (!root) return;
  const targets: Live[] = [];
  for (const l of lives.values()) {
    if (l.convo.running && sameDir(l.cwd, root)) targets.push(l);
  }
  for (const l of targets) {
    l.stopping = true;
    await invoke("ai_stop", { id: l.id }).catch(() => {});
  }
}

/** Al cambiar o cerrar carpeta se descarta la conversación activa del proyecto anterior y se actualiza la vista para el nuevo. */
export function resetAi() {
  dismissPopover();
  extraFiles = [];
  extraNotes = [];
  attachedImages = [];
  mentionFiles = null;
  lastFile = "";
  useFile = true;
  useSel = true;
  historyOpen = false;
  const keepCurrent = !!(ws.root && current && current.convo.messages.length && sameDir(current.cwd, ws.root));
  if (!keepCurrent && current) {
    if (current.convo.messages.length) persist(current, true);
    else lives.delete(current.id);
    current = null;
    resetTurnCache();
  }
  const input = q<HTMLTextAreaElement>(".ai-input");
  if (input) {
    input.value = "";
    autosize();
  }
  if (shown) renderBody();
}

/** «IA: Nueva conversación» desde la paleta. */
export const startNewConversation = () => { historyOpen = false; newConversation(); };
