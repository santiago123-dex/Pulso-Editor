import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseInline, parseMarkdown } from "./aiMarkdown";
import { buildPrompt, chipLabels, type EditorContext } from "./aiContext";
import {
  createProviderNormalizer, emptyConversation, exitEvent, formatModelName, isAuthError, parseUsageText, percent, planLabel, pruneUsage,
  reduce, resetClockText, resetCountdown, resetIn, toolSummary, touchedFiles, usedPercent,
  usedRatio, userEvent, type AiEvent, type AiProvider, type Block, type Conversation, type Turn, type UsageWindow,
} from "./aiModel";
import { chatsFor, deleteChat, initHistory, loadChats, newChatId, saveChat, titleFrom, type SavedChat } from "./aiStore";
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
import "./aiChat.css";

/**
 * Asistente de IA: conversa en la carpeta del proyecto usando la CLI oficial elegida (Claude Code, Codex CLI o Gemini CLI).
 * Pulso nunca ve ni guarda credenciales; cada herramienta administra su propia sesión.
 */
interface AiModelInfo { id: string; label: string; note: string }
interface AiTool { installed: boolean; version: string; logged_in: boolean; auth_method: string; plan: string; error: string; models?: AiModelInfo[] }
interface WindowQuota { used_percent: number; resets_at: number }
interface CodexQuota { plan: string; five_hour?: WindowQuota; seven_day?: WindowQuota }
interface GeminiModelStat { model: string; requests: number; tokens: number }
interface GeminiUsage { requests_24h: number; tokens_24h: number; requests_7d: number; tokens_7d: number; models: GeminiModelStat[] }
interface ExtraUsage { codex?: CodexQuota; gemini?: GeminiUsage }
interface AllAiTools { claude: AiTool; codex: AiTool; gemini: AiTool }
interface Live { id: string; provider: AiProvider; normalize: (ev: AiEvent) => AiEvent[]; convo: Conversation; cwd: string; title: string; stopping?: boolean }

interface ModelOption {
  value: string;
  label: string;
  tier: string;
  badge?: string;
  hint: string;
}

interface ProviderMeta {
  id: AiProvider;
  short: string;
  title: string;
  accountTitle: string;
  npmPkg?: string;
  loginCmd: string;
  loginBtn: string;
  installHint: string;
  docsUrl: string;
  modelKey: string;
  supportsEffort: boolean;
  models: ModelOption[];
  specific: ModelOption[];
}

// Los alias («fable», «opus»…) los resuelve Claude Code al modelo más reciente de tu plan; los nombres con versión son los de la familia actual.
const MODELS: ModelOption[] = [
  { value: "", label: "Predeterminado", tier: "Cuenta", badge: "Auto", hint: "Modelo configurado por defecto en tu sesión de Claude Code" },
  { value: "fable", label: "Claude Fable 5.2", tier: "Máxima capacidad", badge: "Nuevo", hint: "Alias «fable»: el Fable más reciente. Si tu plan no lo incluye, Claude Code lo avisará" },
  { value: "opus", label: "Claude Opus 5.5", tier: "Profundo", badge: "Nuevo", hint: "Alias «opus» para análisis complejo y arquitectura" },
  { value: "sonnet", label: "Claude Sonnet 5.5", tier: "Equilibrado", badge: "Nuevo", hint: "Alias «sonnet» (último Sonnet disponible en tu plan)" },
  { value: "haiku", label: "Claude Haiku 5.5", tier: "Rápido", badge: "Ligero", hint: "Alias «haiku» para respuestas inmediatas" },
];

const SPECIFIC_MODELS: ModelOption[] = [
  { value: "claude-fable-5-2", label: "Claude Fable 5.2", tier: "claude-fable-5-2", badge: "Fijo", hint: "Fijar versión Fable 5.2" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "claude-opus-5-5", badge: "Fijo", hint: "Fijar versión Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "claude-sonnet-5-5", badge: "Fijo", hint: "Fijar versión Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "claude-haiku-5-5", badge: "Fijo", hint: "Fijar versión Haiku 5.5" },
];

const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  claude: {
    id: "claude",
    short: "Claude",
    title: "Claude Code",
    accountTitle: "Claude (Anthropic)",
    loginCmd: "claude auth login",
    loginBtn: "Iniciar sesión con Claude Code",
    installHint: "Instálalo, inicia sesión con tu cuenta y pulsa «Volver a comprobar». El asistente usa tu suscripción; Pulso no guarda ninguna clave.",
    docsUrl: "https://claude.com/claude-code",
    modelKey: "pulso.ai.model",
    supportsEffort: true,
    models: MODELS,
    specific: SPECIFIC_MODELS,
  },
  codex: {
    id: "codex",
    short: "Codex",
    title: "Codex CLI (ChatGPT)",
    accountTitle: "ChatGPT / Codex (OpenAI)",
    npmPkg: "@openai/codex",
    loginCmd: "codex login",
    loginBtn: "Iniciar sesión con ChatGPT",
    installHint: "Instala @openai/codex (`npm i -g @openai/codex`), inicia sesión con tu suscripción de ChatGPT y pulsa «Volver a comprobar».",
    docsUrl: "https://github.com/openai/codex",
    modelKey: "pulso.ai.model.codex",
    supportsEffort: true,
    // Los modelos reales salen de la caché de tu cuenta (~/.codex/models_cache.json); aquí no se inventa ninguno.
    models: [
      { value: "", label: "Predeterminado", tier: "Cuenta", badge: "Auto", hint: "Modelo configurado en tu cuenta de Codex CLI" },
    ],
    specific: [],
  },
  gemini: {
    id: "gemini",
    short: "Gemini",
    title: "Gemini CLI",
    accountTitle: "Gemini (Google)",
    npmPkg: "@google/gemini-cli",
    loginCmd: "gemini",
    loginBtn: "Iniciar sesión con Google (Gemini)",
    installHint: "Instala Gemini CLI (`npm i -g @google/gemini-cli`), inicia sesión con tu cuenta de Google y pulsa «Volver a comprobar».",
    docsUrl: "https://geminicli.com",
    modelKey: "pulso.ai.model.gemini",
    supportsEffort: false,
    // Alias oficiales de Gemini CLI: siempre apuntan al modelo vigente; las versiones concretas se leen de la herramienta instalada.
    models: [
      { value: "", label: "Predeterminado", tier: "Automático", badge: "Auto", hint: "Gemini CLI elige el modelo según la tarea" },
      { value: "pro", label: "Gemini Pro", tier: "Profundo", hint: "Alias «pro»: el mejor Pro disponible" },
      { value: "flash", label: "Gemini Flash", tier: "Rápido", hint: "Alias «flash»: el Flash vigente" },
      { value: "flash-lite", label: "Gemini Flash Lite", tier: "Ligero", badge: "Ligero", hint: "Alias «flash-lite»: el más económico" },
    ],
    specific: [],
  },
};

const EFFORTS: { value: string; label: string; short: string }[] = [
  { value: "", label: "Auto", short: "" },
  { value: "low", label: "Bajo", short: "Bajo" },
  { value: "medium", label: "Medio", short: "Medio" },
  { value: "high", label: "Alto", short: "Alto" },
  { value: "max", label: "Máx", short: "Máx" },
];

const QUICK_PROMPTS: { label: string; tag: string; prompt: string }[] = [
  { label: "Explicar este código", tag: "Lectura", prompt: "Explica paso a paso qué hace este código y sus dependencias principales." },
  { label: "Buscar posibles errores", tag: "Revisión", prompt: "Revisa este código en busca de errores, condiciones de carrera o casos borde sin cubrir." },
  { label: "Escribir pruebas unitarias", tag: "Tests", prompt: "Propón e implementa pruebas unitarias claras cubriendo casos normales y límites." },
  { label: "Refactorizar para claridad", tag: "Mejora", prompt: "Refactoriza este fragmento para hacerlo más legible y modular sin cambiar su comportamiento." },
  { label: "Documentar funciones", tag: "Docs", prompt: "Añade comentarios JSDoc/TSDoc concisos explicando parámetros, retorno y propósito." },
];

const EXAMPLES: { code: string; label: string; tag: string; prompt: string }[] = [
  { code: "01", label: "Explica qué hace este archivo", tag: "Lectura", prompt: "Explica qué hace este archivo" },
  { code: "02", label: "Busca posibles errores en lo que tengo abierto", tag: "Revisión", prompt: "Busca posibles errores en lo que tengo abierto" },
  { code: "03", label: "Propón pruebas para la selección", tag: "Tests", prompt: "Propón pruebas para la selección" },
  { code: "04", label: "Simplifica y refactoriza este bloque", tag: "Refactor", prompt: "Simplifica este código para hacerlo más claro y mantenible sin cambiar su comportamiento." },
];

// v2: la clave anterior pudo quedar con cifras de pruebas; se ignora y se borra al arrancar.
const USAGE_KEY = "pulso.ai.usage.v2";
const USAGE_SIG_KEY = "pulso.ai.usageSig";
const FULL_KEY = "pulso.aiFull";

function readStoredUsage(): Conversation["usage"] {
  try {
    localStorage.removeItem("pulso.ai.usage");
    const raw = JSON.parse(localStorage.getItem(USAGE_KEY) ?? "{}");
    return pruneUsage(raw);
  } catch {
    return {};
  }
}

function savedProvider(): AiProvider {
  const p = localStorage.getItem("pulso.ai.provider");
  return p === "codex" || p === "gemini" ? p : "claude";
}

const lives = new Map<string, Live>();
let activeProvider: AiProvider = savedProvider();
let current: Live | null = null;
const tools: Record<AiProvider, AiTool | null> = { claude: null, codex: null, gemini: null };
let tool: AiTool | null = null;
let toolAt = 0;
let detectInFlight: Promise<void> | null = null;
let usageInFlight: Promise<boolean> | null = null;
let usageSyncing = false;
let usageError = "";
let shown = false;
let historyOpen = false;
let model = localStorage.getItem(PROVIDERS[activeProvider].modelKey) ?? "";
let effort = localStorage.getItem("pulso.ai.effort") ?? "";
let mode: "read" | "edit" = localStorage.getItem("pulso.ai.mode") === "edit" ? "edit" : "read";
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

const OLD_MODEL = /previous generation|legacy/i;

/** «gemini-3.5-flash-lite» → «Gemini 3.5 Flash Lite». */
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
  return "Disponible";
}

function providerCatalog(prov: AiProvider): { models: ModelOption[]; specific: ModelOption[] } {
  const meta = PROVIDERS[prov];
  if (prov === "claude") return { models: meta.models, specific: meta.specific };
  const detected = tools[prov]?.models ?? [];
  const toOption = (d: AiModelInfo): ModelOption => ({
    value: d.id,
    label: d.label || titleFromId(d.id),
    tier: tierFromNote(d.note),
    badge: /preview/i.test(d.id) ? "Preview" : undefined,
    hint: d.note || `Modelo ${d.id}`,
  });
  if (prov === "codex") {
    return {
      models: [...meta.models, ...detected.filter((d) => !OLD_MODEL.test(d.note)).map(toOption)],
      specific: detected.filter((d) => OLD_MODEL.test(d.note)).map(toOption),
    };
  }
  const aliases = new Set(meta.models.map((m) => m.value));
  return { models: meta.models, specific: detected.filter((d) => !aliases.has(d.id)).map(toOption) };
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
  const eff = PROVIDERS[prov].supportsEffort ? EFFORTS.find((e) => e.value === effort)?.short : "";
  const prefix = prov === "claude" ? "" : `${PROVIDERS[prov].short} · `;
  return `${prefix}${eff ? `${base} · ${eff}` : base}`;
}

function syncModelButton() {
  const label = q(".ai-model-btn-label");
  if (label) label.textContent = modelButtonText();
}

// ---------- Conversaciones ----------
function fromSaved(c: SavedChat): Live {
  const prov: AiProvider = c.provider === "codex" || c.provider === "gemini" ? c.provider : "claude";
  return { id: c.id, provider: prov, normalize: createProviderNormalizer(prov, c.model || ""), cwd: c.cwd, title: c.title, convo: { ...emptyConversation(), messages: c.messages, sessionId: c.sessionId, model: c.model, usage: prov === "claude" ? usage : {} } };
}

function newLive(): Live {
  const live: Live = { id: newChatId(), provider: activeProvider, normalize: createProviderNormalizer(activeProvider, model), convo: { ...emptyConversation(), usage: activeProvider === "claude" ? usage : {} }, cwd: ws.root ?? "", title: "Conversación nueva" };
  lives.set(live.id, live);
  return live;
}

function persist(live: Live) {
  if (!live.convo.messages.length) return;
  live.title = titleFrom(live.convo.messages);
  saveChat({ id: live.id, title: live.title, cwd: live.cwd, sessionId: live.convo.sessionId, model: live.convo.model, provider: live.provider, updatedAt: Date.now(), messages: live.convo.messages });
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
let geminiUsage: GeminiUsage | null = null;
let extraUsageInFlight: Promise<boolean> | null = null;

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
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
      if (res.gemini) geminiUsage = res.gemini;
      if (shown) syncTelemetryViews();
      return !!(res.codex || res.gemini);
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
  return {};
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

function apply(live: Live, ev: AiEvent) {
  const before = live.convo.touched;
  live.convo = reduce(live.convo, ev);
  if (live.convo.usage.fiveHour || live.convo.usage.sevenDay) {
    if (live.provider === "claude") saveUsage(live.convo.usage);
    else if (live.provider === "codex") codexUsage = pruneUsage(live.convo.usage);
  }
  if (live.convo.touched > before) refreshDisk();
  if (ev.type === "result" || ev.type === "pulso_exit") {
    persist(live);
    if (live.convo.touched) refreshDisk();
    if (live.provider !== "claude") void refreshExtraUsage();
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
  const filePath = resolveToolFile(b.input.file_path ?? b.input.notebook_path ?? b.input.path);
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

function turnNodes(t: Turn, userNum = 0): HTMLElement[] {
  if (t.role === "user") {
    const u = h("div", "ai-user");
    const tag = userNum > 0 ? `#${String(userNum).padStart(2, "0")} · TÚ` : "Tú";
    u.append(h("div", "ai-user-tag", tag), h("div", "ai-user-text", t.blocks[0]?.kind === "text" ? t.blocks[0].text : ""));
    return [u];
  }
  const out: HTMLElement[] = [];
  let trace: HTMLElement | null = null;
  const pushTrace = (el: HTMLElement) => {
    if (!trace) { trace = h("div", "ai-trace"); out.push(trace); }
    trace.append(el);
  };
  for (const b of t.blocks) {
    if (!b) continue;
    if (b.kind === "text") {
      if (b.text.trim()) {
        trace = null;
        const wrap = h("div", "ai-assistant");
        wrap.append(...markdown(b.text));
        out.push(wrap);
      }
    } else if (b.kind === "thinking") {
      if (!b.text.trim()) continue;
      const d = h("details", "ai-think");
      d.append(h("summary", "", "Razonamiento"), h("div", "ai-think-text", b.text));
      pushTrace(d);
    } else {
      pushTrace(toolRow(b));
    }
  }
  return out;
}

// ---------- Popovers (Modelo + Esfuerzo y Uso real del plan) ----------
function usageRing(ratioUsed: number, size = 14): HTMLElement {
  const clamped = Math.max(0, Math.min(1, ratioUsed));
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const tone = clamped >= 0.9 ? "low" : clamped >= 0.7 ? "warn" : "ok";
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
  for (const id of ["claude", "codex", "gemini"] as const) {
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
  if (!t.installed) return PROVIDERS[id].npmPkg ? "CLI sin instalar · instalable aquí" : "CLI sin instalar";
  if (!t.logged_in) return "Instalado · falta iniciar sesión";
  if (id === "claude") return t.plan ? `Conectado · Plan ${planLabel(t.plan)}` : "Conectado · Suscripción Claude";
  if (id === "codex") {
    if (t.auth_method === "chatgpt") return "Conectado · Suscripción ChatGPT";
    if (t.auth_method === "api_key") return "Conectado · Clave API";
    return "Conectado · ChatGPT";
  }
  if (t.auth_method === "google") return "Conectado · Cuenta Google";
  return t.plan ? `Conectado · ${t.plan}` : "Conectado · Gemini CLI";
}

async function installAndConnect(prov: AiProvider, onDone?: () => void) {
  const meta = PROVIDERS[prov];
  if (!meta.npmPkg) { void openExternal(meta.docsUrl); return; }
  const shells = await listShells().catch(() => []);
  const sh = shells.find((s) => s.id === state.settings.terminalShell) ?? shells[0];
  const ps = sh ? /powershell|pwsh/i.test(`${sh.id} ${sh.path}`) : false;
  const cmd = ps
    ? `npm install -g ${meta.npmPkg}; if ($?) { ${meta.loginCmd} }`
    : `npm install -g ${meta.npmPkg} && ${meta.loginCmd}`;
  const r = await showDialog({
    title: `Instalar y conectar ${meta.accountTitle}`,
    message: `Se ejecutará en la terminal integrada:\n${cmd}\n\nPulso no pide ni guarda claves: iniciarás sesión directamente en la CLI oficial.`,
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
  for (const id of ["claude", "codex", "gemini"] as const) {
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

    if (!t?.installed) {
      const btn = h("button", "ai-acct-btn", meta.npmPkg ? "Instalar y conectar" : "Cómo instalar");
      btn.type = "button";
      btn.onclick = () => {
        if (meta.npmPkg) void installAndConnect(id, onClose);
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

function openModelPopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-model-pop");
  pop.setAttribute("role", "listbox");
  pop.setAttribute("aria-label", "Seleccionar proveedor y modelo");
  let specificOpen = providerCatalog(activeProvider).specific.some((m) => m.value === model);

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
    }));
    pop.append(h("div", "ai-pop-sep"), h("div", "ai-pop-head", `Modelo · ${meta.short}`));

    const addOption = (m: ModelOption) => {
      const active = m.value === model;
      const row = h("button", `ai-pop-item${active ? " active" : ""}`);
      row.type = "button";
      row.title = m.hint;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(active));
      const left = h("span", "ai-pop-main");
      left.append(h("span", "ai-pop-name", m.label), h("span", "ai-pop-tier", m.tier));
      if (m.badge) left.append(h("span", "ai-pop-badge", m.badge));
      row.append(left, h("span", "ai-pop-check", active ? "✓" : ""));
      row.onclick = () => {
        model = m.value;
        localStorage.setItem(meta.modelKey, model);
        dismissPopover();
        syncModelButton();
      };
      pop.append(row);
    };

    for (const m of cat.models) addOption(m);

    const toggleSpec = h("button", "ai-pop-item ai-pop-subtoggle");
    toggleSpec.type = "button";
    const toggleMain = h("span", "ai-pop-main");
    toggleMain.append(h("span", "ai-pop-name", `Más modelos (${cat.specific.length})`));
    toggleSpec.append(toggleMain, h("span", "ai-pop-chev", specificOpen ? "▾" : "›"));
    toggleSpec.onclick = () => { specificOpen = !specificOpen; render(); };
    pop.append(h("div", "ai-pop-sep"), toggleSpec);

    if (specificOpen) {
      for (const m of cat.specific) addOption(m);
      const custom = h("button", "ai-pop-item");
      custom.type = "button";
      const customMain = h("span", "ai-pop-main");
      customMain.append(h("span", "ai-pop-name", "Otro ID de modelo…"), h("span", "ai-pop-tier", "Manual"));
      custom.append(customMain);
      custom.onclick = async () => {
        dismissPopover();
        const entered = await promptText({ title: "Identificador exacto del modelo", value: model, placeholder: cat.specific[0]?.value ?? "modelo" });
        if (!entered) return;
        model = entered.trim();
        localStorage.setItem(meta.modelKey, model);
        syncModelButton();
      };
      pop.append(custom);
    }

    if (meta.supportsEffort) {
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

    const viewUsage = h("button", "ai-pop-item ai-pop-usage-link");
    viewUsage.type = "button";
    const usageMain = h("span", "ai-pop-main");
    usageMain.append(h("span", "ai-pop-name", "Ver uso y límites"));
    viewUsage.append(usageMain, h("span", "ai-pop-chev", "›"));
    viewUsage.onclick = () => openUsagePopover(anchor);

    const manage = h("button", "ai-pop-item ai-pop-subtoggle");
    manage.type = "button";
    const manageMain = h("span", "ai-pop-main");
    manageMain.append(h("span", "ai-pop-name", "Cuentas y suscripciones…"));
    manage.append(manageMain, h("span", "ai-pop-chev", "›"));
    manage.onclick = () => openAccountsPopover(anchor);
    pop.append(h("div", "ai-pop-sep"), viewUsage, manage);
  };

  render();
  openPopover(anchor, pop, "above");
}

async function syncAccountAndUsage(): Promise<void> {
  toolAt = 0;
  await detect(true);
  await Promise.all([
    tools.claude?.logged_in ? (usageInFlight ?? refreshUsage()) : Promise.resolve(false),
    (tools.codex?.logged_in || tools.gemini?.logged_in) ? refreshExtraUsage() : Promise.resolve(false),
  ]);
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
    h("span", "ai-inst-kicker", "TELEMETRÍA DE CUENTA"),
    h("span", "ai-inst-plan", planBadgeText),
  );
  const syncBtn = h("button", "ai-inst-sync", usageSyncing ? "Actualizando…" : "Sincronizar");
  syncBtn.type = "button";
  syncBtn.disabled = usageSyncing;
  syncBtn.title = activeProvider === "claude"
    ? "Consultar límites reales con Claude Code (/usage)"
    : activeProvider === "codex"
      ? "Leer límites recientes de ChatGPT/Codex"
      : "Actualizar consumo local de Gemini CLI";
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Actualizando…";
    void syncAccountAndUsage().finally(() => { if (card.isConnected) fillQuotaCard(card); });
  };
  head.append(headLeft, syncBtn);
  card.append(head);

  if (activeProvider === "gemini") {
    const g = geminiUsage;
    const statsBox = h("div", "ai-inst-spec");
    if (g) {
      statsBox.append(
        h("div", "ai-spec-row", `Últimas 24 h: ${g.requests_24h} cons. · ${formatTokens(g.tokens_24h)} tok`),
        h("div", "ai-spec-row", `Últimos 7 d: ${g.requests_7d} cons. · ${formatTokens(g.tokens_7d)} tok`),
      );
      for (const m of g.models.slice(0, 3)) {
        statsBox.append(h("div", "ai-inst-sub", `${formatModelName(m.model)}: ${m.requests} cons. · ${formatTokens(m.tokens)} tok`));
      }
    } else {
      statsBox.append(h("div", "ai-spec-row", `${meta.title} conectado`));
    }
    card.append(statsBox, h("div", "ai-inst-note", "Gemini CLI registra consumo local por sesión; Google no expone % global remoto en disco."));
    return;
  }

  const meters = h("div", "ai-inst-meters");
  for (const [label, w] of [["Ventana 5 h", curUsage.fiveHour], ["Semanal", curUsage.sevenDay]] as const) {
    const row = h("div", "ai-inst-row");
    const top = h("div", "ai-inst-row-top");
    top.append(h("span", "ai-inst-lbl", label), h("span", "ai-inst-val", w ? `${usedPercent(w)} usado` : "—"));
    const track = h("div", "ai-inst-track");
    const ratio = usedRatio(w);
    const bar = h("div", `ai-inst-fill${ratio >= 0.9 ? " high" : ratio >= 0.7 ? " warn" : ""}`);
    bar.style.width = `${Math.round(ratio * 100)}%`;
    track.append(bar);
    const clock = resetClockText(w);
    const cd = resetCountdown(w);
    const emptyMsg = activeProvider === "claude"
      ? (usageSyncing ? "Leyendo /usage…" : "Sin datos en esta ventana")
      : "Disponible tras tu primera sesión en Codex";
    const reset = clock ? (cd && cd !== "ahora" ? `${clock} (${cd})` : clock) : emptyMsg;
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
  right.append(h("span", "ai-usage-pct", w ? `${usedPercent(w)} usado` : "—"), usageRing(usedRatio(w), 16));
  row.append(left, right);
  return row;
}

function openUsagePopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-usage-pop");
  const fill = () => {
    const prov = current?.convo.messages.length ? current.provider : activeProvider;
    pop.replaceChildren();
    const head = h("div", "ai-usage-pop-head");
    head.append(h("span", "ai-usage-group", "Uso y límites"));
    const syncBtn = h("button", "ai-usage-sync", usageSyncing ? "Actualizando…" : "Actualizar");
    syncBtn.type = "button";
    syncBtn.disabled = usageSyncing;
    syncBtn.onclick = () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "Actualizando…";
      void syncAccountAndUsage().finally(() => { if (pop.isConnected) fill(); });
    };
    head.append(syncBtn);
    pop.append(head);

    const order: AiProvider[] = [prov, ...(["claude", "codex", "gemini"] as const).filter((p) => p !== prov && !!tools[p]?.logged_in)];
    for (const id of order) {
      const t = tools[id] ?? (id === prov ? tool : null);
      const sec = h("div", "ai-usage-section");
      if (id === "claude") {
        const cur = providerUsage("claude");
        const title = t?.plan ? `Claude Code · Plan ${planLabel(t.plan)}` : "Claude Code";
        sec.append(
          h("div", "ai-usage-sec-title", title),
          usageRingRow("Límite semanal · todos", cur.sevenDay, usageSyncing ? "Consultando /usage…" : "Pendiente de lectura"),
          usageRingRow("Límite de 5 horas", cur.fiveHour, usageSyncing ? "Consultando /usage…" : "Pendiente de lectura"),
        );
        if (usageError) sec.append(h("div", "ai-usage-note err", usageError));
      } else if (id === "codex") {
        const cur = providerUsage("codex");
        const title = t?.plan && t.plan !== "ChatGPT" ? `ChatGPT / Codex · Plan ${planLabel(t.plan)}` : "ChatGPT / Codex";
        sec.append(
          h("div", "ai-usage-sec-title", title),
          usageRingRow("Límite semanal", cur.sevenDay, "Sin sesiones recientes aún"),
          usageRingRow("Límite de 5 horas", cur.fiveHour, "Sin sesiones recientes aún"),
        );
      } else {
        const g = geminiUsage;
        sec.append(h("div", "ai-usage-sec-title", "Gemini CLI · Cuenta Google"));
        if (g) {
          const statRow = (label: string, val: string) => {
            const row = h("div", "ai-usage-row");
            const left = h("div", "ai-usage-row-left");
            left.append(h("span", "ai-usage-label", label));
            row.append(left, h("span", "ai-usage-pct", val));
            return row;
          };
          sec.append(
            statRow("Consumo local (24 h)", `${g.requests_24h} cons. · ${formatTokens(g.tokens_24h)} tok`),
            statRow("Consumo local (7 d)", `${g.requests_7d} cons. · ${formatTokens(g.tokens_7d)} tok`),
          );
          for (const m of g.models.slice(0, 3)) {
            const mr = h("div", "ai-usage-meta", `${formatModelName(m.model)}: ${m.requests} cons. · ${formatTokens(m.tokens)} tok`);
            sec.append(mr);
          }
        } else {
          sec.append(h("div", "ai-usage-note", "Sin actividad local registrada aún en ~/.gemini/tmp."));
        }
        sec.append(h("div", "ai-usage-note", "Gemini CLI no expone % global remoto en disco (solo métricas locales de tus turnos)."));
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
  };
  fill();
  openPopover(anchor, pop, "above");
  if (tools.claude?.logged_in || activeProvider === "claude") {
    void refreshUsage().finally(() => { if (pop.isConnected) fill(); });
  }
  if (tools.codex?.logged_in || tools.gemini?.logged_in) {
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
  if (curTool?.plan) parts.push(prov === "claude" ? `Plan ${planLabel(curTool.plan)}` : `${PROVIDERS[prov].short} · ${curTool.plan}`);
  if (curUsage.fiveHour) parts.push(`sesión de 5 h: ${percent(curUsage.fiveHour)}${resetIn(curUsage.fiveHour) ? ` (se reinicia ${resetIn(curUsage.fiveHour)})` : ""}`);
  if (curUsage.sevenDay) parts.push(`semana: ${percent(curUsage.sevenDay)}`);
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
  const ratio = curUsage.fiveHour ? usedRatio(curUsage.fiveHour) : usedRatio(curUsage.sevenDay);
  const trigger = h("button", "ai-usage-btn");
  trigger.type = "button";
  trigger.title = "Ver límites de uso del plan";
  const pctText = curUsage.fiveHour ? `${usedPercent(curUsage.fiveHour)} usado` : curUsage.sevenDay ? `${usedPercent(curUsage.sevenDay)} sem.` : "Ver uso";
  trigger.append(usageRing(ratio, 14), h("span", "", pctText));
  trigger.onclick = () => openUsagePopover(trigger);

  if (!text || !hasWindows) {
    foot.append(h("span", "ai-foot-text", `${text ? `${text} · ` : ""}Usa tu sesión de ${PROVIDERS[prov].title}`), trigger);
    return;
  }
  const bars = h("span", "ai-meters");
  for (const w of [curUsage.fiveHour, curUsage.sevenDay]) {
    if (!w) continue;
    const m = h("span", "ai-meter");
    const f = h("span", `ai-meter-fill${w.utilization >= 0.9 ? " high" : ""}`);
    f.style.width = `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)}%`;
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

  const eyebrow = h("div", "ai-bench-eyebrow");
  eyebrow.append(
    h("span", "ai-bench-dot", ""),
    h("span", "ai-bench-kicker", "PULSO // ESTACIÓN DE CÓDIGO"),
    h("span", `ai-meta-pill${mode === "edit" ? " edit" : ""}`, mode === "edit" ? "Puede editar" : "Solo leer"),
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
      h("div", "ai-spec-row", `Esfuerzo: ${effOpt} · Modo: ${mode === "edit" ? "Edición directa" : "Solo lectura"}`),
      h("div", "ai-inst-note", `Tus hilos guardados en ${wsName} aparecerán aquí para retomarlos en un clic.`),
    );
    threadsCard.append(spec);
  }

  rail.append(quotaCard, threadsCard);
  empty.append(main, rail);
  return empty;
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
        ? (curTool?.auth_method === "api_key" ? "Codex API" : "ChatGPT")
        : (curTool?.plan && curTool.plan !== "Google" ? curTool.plan : "Gemini");
  }
  const histBtn = q<HTMLButtonElement>('.ai-tools button[title="Conversaciones anteriores"]');
  if (histBtn) { histBtn.classList.toggle("active", historyOpen); histBtn.setAttribute("aria-pressed", String(historyOpen)); }
  renderFoot();
  const recheck = () => { toolAt = 0; void detect(true); };
  const ready = !!curTool?.installed && curTool.logged_in && !!ws.root;
  compose.hidden = !ready || historyOpen;
  if (!curTool) { body.replaceChildren(setupMessage(`Detectando ${meta.title}`, "Comprobando sesión y estado de tu cuenta…")); return; }
  if (!curTool.installed) {
    const again = h("button", "foot-btn ai-btn-primary", "Volver a comprobar"); again.type = "button"; again.onclick = recheck;
    const guide = h("button", "foot-btn foot-btn-line", "Cómo instalarlo"); guide.type = "button"; guide.onclick = () => void openExternal(meta.docsUrl);
    const extraBtns: HTMLElement[] = [again, guide];
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", "Volver a Claude Code"); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(`${meta.title} no está instalado`, meta.installHint, ...extraBtns));
    return;
  }
  if (!curTool.logged_in) {
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
  if (!ws.root) { body.replaceChildren(setupMessage("Abre un proyecto", "Abre una carpeta de proyecto para que el asistente pueda leer tu código y ayudarte dentro de ella.")); return; }
  if (historyOpen) { renderHistory(body); return; }

  const live = current ?? (current = newLive());
  const c = live.convo;
  syncModelButton();
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const nodes: HTMLElement[] = [];
  if (!c.messages.length) {
    nodes.push(buildEmptyWorkbench());
  }
  let userNum = 0;
  for (const t of c.messages) {
    if (t.role === "user") userNum += 1;
    nodes.push(...turnNodes(t, userNum));
  }
  const last = c.messages[c.messages.length - 1];
  if (c.running && (!last || last.role === "user" || !last.done)) nodes.push(h("div", "ai-working", "Trabajando…"));
  if (c.error) {
    const e = h("div", "ai-error");
    e.append(h("div", "", c.error));
    if (isAuthError(c.error)) {
      const b = h("button", "foot-btn foot-btn-line", "Iniciar sesión en la terminal"); b.type = "button";
      b.onclick = () => startLoginFlow(live.provider);
      e.append(b);
    }
    nodes.push(e);
  } else if (c.outcome?.ok && !c.running) {
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
      nodes.push(box);
    }
    const secs = c.outcome.durationMs ? ` · ${(c.outcome.durationMs / 1000).toFixed(1).replace(".", ",")} s` : "";
    const modelTag = c.model ? ` · ${formatModelName(c.model)}` : "";
    const o = h("div", "ai-outcome", `Listo${secs}${modelTag}`);
    if (c.touched) o.append(` · ${c.touched} archivo${c.touched === 1 ? "" : "s"} modificado${c.touched === 1 ? "" : "s"}`);
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
        return { claude, codex: null, gemini: null } as unknown as { claude: AiTool; codex: AiTool | null; gemini: AiTool | null };
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
      tools.gemini = all.gemini;
      tool = tools[activeProvider];

      if (nextClaude.logged_in) {
        localStorage.setItem(USAGE_SIG_KEY, sig);
        void refreshUsage();
      }
      if (all.codex?.logged_in || all.gemini?.logged_in) {
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
  if (!live.convo.messages.length) {
    live.provider = activeProvider;
    live.normalize = createProviderNormalizer(live.provider, model || "");
  }
  const useEffort = PROVIDERS[live.provider].supportsEffort ? effort || null : null;
  apply(live, userEvent(text));
  try {
    await invoke("ai_send", { id: live.id, cwd: ws.root, prompt, session: live.convo.sessionId || null, model: model || null, effort: useEffort, mode, provider: live.provider });
  } catch (e) {
    apply(live, exitEvent(1, String(e)));
  }
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
  if (full) window.dispatchEvent(new CustomEvent("pulso-overlay", { detail: "ai" }));
  applyMode();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !closePopover && isFull() && !document.querySelector(".modal")) { e.preventDefault(); e.stopPropagation(); setFull(false); }
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
  const titleRow = h("div", "ai-title-row");
  const planBtn = h("button", "ai-plan-pill", "");
  planBtn.type = "button";
  planBtn.title = "Ver y conectar suscripciones (Claude, ChatGPT, Gemini)";
  planBtn.onclick = () => openAccountsPopover(planBtn);
  titleRow.append(h("span", "ai-live-dot", ""), h("span", "ai-title", "Asistente"), planBtn);
  titles.append(titleRow, h("span", "ai-sub", ""));
  const tools = h("div", "ai-tools");
  const add = iconBtn(ICON_PLUS, "Nueva conversación"); add.onclick = newConversation;
  const hist = iconBtn(ICON_CLOCK, "Conversaciones anteriores"); hist.onclick = () => { historyOpen = !historyOpen; renderBody(); };
  const expand = iconBtn(ICON_EXPAND, "Pantalla completa", "ai-expand"); expand.onclick = () => setFull(!isFull());
  tools.append(add, hist, expand);
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
  for (const [value, label, hint] of [["read", "Solo leer", "La IA puede leer y buscar en tu proyecto, pero no modificarlo"], ["edit", "Puede editar", "La IA puede editar y crear archivos sin preguntar. Nunca ejecuta comandos"]] as const) {
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
  const foot = h("div", "ai-foot");
  shell.append(head, body, compose, foot);
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
  if (isFull()) window.dispatchEvent(new CustomEvent("pulso-overlay", { detail: "ai" }));
  if (!q(".ai-shell")) build(); else { applyMode(); renderBody(); }
  void detect(!tool?.logged_in);
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

export function initAi() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  // El historial vive en un archivo: se carga una vez y, si la pestaña ya se pintó, se repinta con él.
  void initHistory().then(() => { if (shown) renderBody(); });
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
