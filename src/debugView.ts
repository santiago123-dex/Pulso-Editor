import "./debug.css";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activePath, focusedEditor } from "./groups";
import { t } from "./i18n";
import { setStatus } from "./ui";
import { $, baseName, h, norm } from "./util";
import { ws } from "./workspace";
import {
  appendConsole,
  breakpointsForFile,
  countBreakpoints,
  formatFrameLocation,
  loadBreakpoints,
  removeBreakpoint,
  saveBreakpoints,
  toDapBreakpoints,
  toggleBreakpoint,
  type BreakpointMap,
  type DapEvalResult,
  type DapScope,
  type DapStackFrame,
  type DapVariable,
  type DebugConsoleEntry,
  type DebugSessionStatus,
  type LaunchConfig,
} from "./debugModel";

const inTauri = "__TAURI_INTERNALS__" in window;

interface DapConfigsResponse {
  trusted: boolean;
  configs: LaunchConfig[];
}

interface DapEventPayload {
  event: string;
  body: Record<string, unknown>;
}

let status: DebugSessionStatus = "idle";
let trusted = false;
let configs: LaunchConfig[] = [];
let selectedConfigIdx = 0;
let activeThreadId = 1;
let frames: DapStackFrame[] = [];
let activeFrameId: number | null = null;
let pausedLoc: { path: string; line: number } | null = null;
let scopes: DapScope[] = [];
let varsByRef = new Map<number, DapVariable[]>();
let expandedRefs = new Set<number>();
let consoleEntries: DebugConsoleEntry[] = [];
let breakpoints: BreakpointMap = loadBreakpoints();
let openFileAt: (path: string, line?: number) => Promise<void> = async () => {};

const editorDecorations = new WeakMap<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>();
const wiredEditors = new WeakSet<monaco.editor.ICodeEditor>();

function pathFromModel(model: monaco.editor.ITextModel | null): string | null {
  if (!model) return null;
  const raw = model.uri.fsPath || model.uri.path;
  if (!raw) return null;
  // En Windows Monaco puede prefijar `/C:/...`.
  const cleaned = /^\/[A-Za-z]:\//.test(raw) ? raw.slice(1) : raw;
  return norm(cleaned);
}

function updateDecorationsFor(ed: monaco.editor.ICodeEditor) {
  let col = editorDecorations.get(ed);
  if (!col) {
    col = ed.createDecorationsCollection();
    editorDecorations.set(ed, col);
  }
  const path = pathFromModel(ed.getModel());
  if (!path) {
    col.clear();
    return;
  }
  const decs: monaco.editor.IModelDeltaDecoration[] = [];
  for (const line of breakpointsForFile(breakpoints, path)) {
    decs.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: false,
        glyphMarginClassName: "pulso-bp-glyph",
        glyphMarginHoverMessage: { value: t("Punto de interrupción (clic para quitar)") },
      },
    });
  }
  if (pausedLoc && norm(pausedLoc.path).toLowerCase() === path.toLowerCase()) {
    decs.push({
      range: new monaco.Range(pausedLoc.line, 1, pausedLoc.line, 1),
      options: {
        isWholeLine: true,
        className: "pulso-debug-line",
        glyphMarginClassName: "pulso-debug-glyph",
      },
    });
  }
  col.set(decs);
}

function refreshAllDecorations() {
  for (const ed of monaco.editor.getEditors()) updateDecorationsFor(ed);
}

function wireEditor(ed: monaco.editor.ICodeEditor) {
  if (wiredEditors.has(ed)) return;
  wiredEditors.add(ed);
  ed.onDidChangeModel(() => updateDecorationsFor(ed));
  ed.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    const path = pathFromModel(ed.getModel());
    if (!line || !path) return;
    void toggleBp(path, line);
  });
  updateDecorationsFor(ed);
}

async function syncBreakpointsForFile(path: string) {
  if (!inTauri || status === "idle") return;
  try {
    await invoke("dap_set_breakpoints", { path, lines: breakpointsForFile(breakpoints, path) });
  } catch { /* el adaptador puede estar cerrándose */ }
}

async function toggleBp(path: string, line: number) {
  breakpoints = toggleBreakpoint(breakpoints, path, line);
  saveBreakpoints(breakpoints);
  refreshAllDecorations();
  renderDebug();
  await syncBreakpointsForFile(path);
}

function logConsole(kind: DebugConsoleEntry["kind"], text: string) {
  consoleEntries = appendConsole(consoleEntries, { kind, text });
  renderConsole();
}

function renderConsole() {
  const box = document.getElementById("dbg-console");
  if (!box) return;
  box.innerHTML = "";
  if (!consoleEntries.length) {
    box.append(h("div", "dbg-empty", t("Sin salida de depuración todavía.")));
    return;
  }
  for (const entry of consoleEntries) {
    box.append(h("div", `dbg-console-line ${entry.kind}`, entry.text));
  }
  box.scrollTop = box.scrollHeight;
}

function renderVarNode(v: DapVariable): HTMLElement {
  const wrap = h("div");
  const row = h("div", "dbg-var");
  const expandable = v.variablesReference > 0;
  if (expandable) {
    const caret = h("span", "", expandedRefs.has(v.variablesReference) ? "▾" : "▸");
    row.style.cursor = "pointer";
    row.onclick = async () => {
      if (expandedRefs.has(v.variablesReference)) {
        expandedRefs.delete(v.variablesReference);
        renderVariables();
        return;
      }
      expandedRefs.add(v.variablesReference);
      if (inTauri && !varsByRef.has(v.variablesReference)) {
        try {
          const list = await invoke<DapVariable[]>("dap_variables", { variablesReference: v.variablesReference });
          varsByRef.set(v.variablesReference, list);
        } catch { /* sin detalles */ }
      }
      renderVariables();
    };
    row.append(caret);
  }
  row.append(h("span", "dbg-var-name", v.name), h("span", "", "="), h("span", "dbg-var-val", v.value));
  wrap.append(row);

  if (expandable && expandedRefs.has(v.variablesReference)) {
    const kids = h("div", "dbg-var-children");
    const list = varsByRef.get(v.variablesReference) ?? [];
    for (const child of list) kids.append(renderVarNode(child));
    wrap.append(kids);
  }
  return wrap;
}

function renderVariables() {
  const box = document.getElementById("dbg-vars");
  if (!box) return;
  box.innerHTML = "";
  if (status !== "paused" || !scopes.length) {
    box.append(h("div", "dbg-empty", status === "running" ? t("En ejecución…") : t("Detén la ejecución para inspeccionar variables.")));
    return;
  }
  for (const sc of scopes) {
    box.append(h("div", "dbg-scope", sc.name));
    const list = varsByRef.get(sc.variablesReference) ?? [];
    if (!list.length) {
      box.append(h("div", "dbg-empty", t("Sin variables en este ámbito.")));
      continue;
    }
    for (const v of list) box.append(renderVarNode(v));
  }
}

function renderStack() {
  const box = document.getElementById("dbg-stack");
  if (!box) return;
  box.innerHTML = "";
  if (status !== "paused" || !frames.length) {
    box.append(h("div", "dbg-empty", t("Sin marcos de pila activos.")));
    return;
  }
  for (const f of frames) {
    const btn = h("button", `dbg-row${f.id === activeFrameId ? " active" : ""}`);
    btn.type = "button";
    btn.append(h("span", "", f.name), h("span", "dbg-meta", formatFrameLocation(f)));
    btn.onclick = () => void selectFrame(f);
    box.append(btn);
  }
}

function renderBreakpoints() {
  const box = document.getElementById("dbg-bps");
  if (!box) return;
  box.innerHTML = "";
  const all = toDapBreakpoints(breakpoints);
  if (!all.length) {
    box.append(h("div", "dbg-empty", t("Haz clic en el margen del editor o pulsa F9 para añadir un punto de interrupción.")));
    return;
  }
  for (const { path, lines } of all) {
    for (const line of lines) {
      const row = h("div", "dbg-row");
      const label = h("span", "", `${baseName(path)}:${line}`);
      label.title = path;
      label.style.flex = "1";
      row.onclick = () => void openFileAt(path, line);
      const del = h("button", "dbg-del", "×");
      del.type = "button";
      del.title = t("Quitar punto de interrupción");
      del.onclick = (e) => {
        e.stopPropagation();
        breakpoints = removeBreakpoint(breakpoints, path, line);
        saveBreakpoints(breakpoints);
        refreshAllDecorations();
        renderDebug();
        void syncBreakpointsForFile(path);
      };
      row.append(h("span", "", "●"), label, del);
      box.append(row);
    }
  }
}

function renderDebug() {
  const badge = document.getElementById("debug-badge");
  if (badge) {
    const n = countBreakpoints(breakpoints);
    badge.hidden = status === "idle" && n === 0;
    badge.textContent = status !== "idle" ? "●" : String(n);
  }

  const sel = document.getElementById("dbg-config") as HTMLSelectElement | null;
  if (sel) {
    sel.innerHTML = "";
    configs.forEach((c, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = `${c.name}${c.source === "vscode" ? " (.vscode)" : ""}`;
      if (idx === selectedConfigIdx) opt.selected = true;
      sel.append(opt);
    });
  }

  const trustBox = document.getElementById("dbg-trust");
  if (trustBox) trustBox.hidden = !ws.root || trusted;

  const controls = document.getElementById("dbg-controls");
  if (controls) controls.hidden = status === "idle";

  const stEl = document.getElementById("dbg-status");
  if (stEl) {
    stEl.className = `dbg-status ${status}`;
    stEl.textContent = status === "paused" ? t("En pausa") : status === "running" ? t("En ejecución") : t("Detenido");
  }

  renderVariables();
  renderStack();
  renderBreakpoints();
  renderConsole();
}

async function selectFrame(frame: DapStackFrame) {
  activeFrameId = frame.id;
  if (frame.source) {
    pausedLoc = { path: frame.source, line: frame.line };
    await openFileAt(frame.source, frame.line);
    refreshAllDecorations();
  }
  scopes = [];
  varsByRef.clear();
  expandedRefs.clear();
  if (inTauri) {
    try {
      scopes = await invoke<DapScope[]>("dap_scopes", { frameId: frame.id });
      for (const sc of scopes) {
        if (!sc.expensive && sc.variablesReference > 0) {
          const list = await invoke<DapVariable[]>("dap_variables", { variablesReference: sc.variablesReference });
          varsByRef.set(sc.variablesReference, list);
        }
      }
    } catch { /* sin ámbitos */ }
  }
  renderDebug();
}

async function handleDapEvent(ev: DapEventPayload) {
  switch (ev.event) {
    case "stopped": {
      status = "paused";
      const tid = typeof ev.body.threadId === "number" ? ev.body.threadId : activeThreadId;
      activeThreadId = tid;
      const reason = typeof ev.body.reason === "string" ? ev.body.reason : "breakpoint";
      logConsole("info", t("Pausado ({reason}).", { reason }));
      try {
        frames = await invoke<DapStackFrame[]>("dap_stack_trace", { threadId: activeThreadId });
        if (frames.length > 0) await selectFrame(frames[0]);
        else renderDebug();
      } catch (e) {
        logConsole("error", String(e));
        renderDebug();
      }
      break;
    }
    case "continued": {
      status = "running";
      pausedLoc = null;
      frames = [];
      scopes = [];
      varsByRef.clear();
      refreshAllDecorations();
      renderDebug();
      break;
    }
    case "terminated":
    case "exited": {
      if (status !== "idle") {
        status = "idle";
        pausedLoc = null;
        frames = [];
        scopes = [];
        varsByRef.clear();
        activeFrameId = null;
        logConsole("info", t("Sesión de depuración finalizada."));
        refreshAllDecorations();
        renderDebug();
      }
      break;
    }
    case "output": {
      const cat = String(ev.body.category ?? "stdout");
      const out = String(ev.body.output ?? "").replace(/\r?\n$/, "");
      if (out) logConsole(cat === "stderr" ? "stderr" : "stdout", out);
      break;
    }
  }
}

export async function refreshDebugConfigs() {
  if (!inTauri || !ws.root) {
    configs = [];
    trusted = false;
    renderDebug();
    return;
  }
  try {
    const res = await invoke<DapConfigsResponse>("dap_list_configs", { activeFile: activePath() });
    trusted = res.trusted;
    configs = res.configs;
    if (selectedConfigIdx >= configs.length) selectedConfigIdx = 0;
  } catch {
    configs = [];
  }
  renderDebug();
}

export async function startOrContinueDebug() {
  if (status === "paused") {
    await invoke("dap_continue", { threadId: activeThreadId }).catch((e) => logConsole("error", String(e)));
    status = "running";
    pausedLoc = null;
    refreshAllDecorations();
    renderDebug();
    return;
  }
  if (!inTauri) return;
  if (!ws.root) {
    setStatus(t("Abre una carpeta antes de usar el depurador."));
    return;
  }
  if (!configs.length) await refreshDebugConfigs();
  const cfg = configs[selectedConfigIdx];
  if (!cfg) {
    setStatus(t("No hay ninguna configuración de depuración disponible."));
    return;
  }
  consoleEntries = [];
  logConsole("info", t("Iniciando depuración: {name}…", { name: cfg.name }));
  try {
    status = "running";
    renderDebug();
    await invoke("dap_launch", {
      config: cfg,
      activeFile: activePath(),
      breakpoints: toDapBreakpoints(breakpoints),
    });
  } catch (e) {
    status = "idle";
    logConsole("error", String(e));
    setStatus(String(e), 6000);
    renderDebug();
  }
}

export async function stopDebug() {
  if (!inTauri) return;
  await invoke("dap_stop").catch(() => {});
  status = "idle";
  pausedLoc = null;
  frames = [];
  scopes = [];
  varsByRef.clear();
  activeFrameId = null;
  refreshAllDecorations();
  renderDebug();
}

export async function stepOverDebug() {
  if (status === "paused") await invoke("dap_next", { threadId: activeThreadId }).catch((e) => logConsole("error", String(e)));
}

export async function stepIntoDebug() {
  if (status === "paused") await invoke("dap_step_in", { threadId: activeThreadId }).catch((e) => logConsole("error", String(e)));
}

export async function stepOutDebug() {
  if (status === "paused") await invoke("dap_step_out", { threadId: activeThreadId }).catch((e) => logConsole("error", String(e)));
}

export async function pauseDebug() {
  if (status === "running") await invoke("dap_pause", { threadId: activeThreadId }).catch((e) => logConsole("error", String(e)));
}

export function toggleCurrentBreakpoint() {
  const ed = focusedEditor();
  const pos = ed?.getPosition();
  const path = pathFromModel(ed?.getModel() ?? null);
  if (!pos || !path) return;
  void toggleBp(path, pos.lineNumber);
}

export function setDebugVisible(on: boolean) {
  if (on) void refreshDebugConfigs();
}

export function initDebug(onOpenFile: (path: string, line?: number) => Promise<void>) {
  openFileAt = onOpenFile;
  for (const ed of monaco.editor.getEditors()) wireEditor(ed);
  monaco.editor.onDidCreateEditor((ed) => wireEditor(ed));

  if (inTauri) {
    void listen<DapEventPayload>("dap-event", (e) => void handleDapEvent(e.payload));
  }

  const sel = document.getElementById("dbg-config") as HTMLSelectElement | null;
  if (sel) sel.onchange = () => { selectedConfigIdx = Number(sel.value) || 0; };

  const startBtn = document.getElementById("dbg-start");
  if (startBtn) startBtn.onclick = () => void startOrContinueDebug();

  const createBtn = document.getElementById("dbg-create-cfg");
  if (createBtn) {
    createBtn.onclick = async () => {
      if (!inTauri || !ws.root) return;
      try {
        const path = await invoke<string>("dap_create_launch_file");
        await openFileAt(path, 1);
        await refreshDebugConfigs();
      } catch (e) {
        setStatus(String(e), 5000);
      }
    };
  }

  const trustBtn = document.getElementById("dbg-trust-btn");
  if (trustBtn) {
    trustBtn.onclick = async () => {
      if (!inTauri) return;
      try {
        await invoke("dap_trust_workspace");
        await refreshDebugConfigs();
        setStatus(t("Carpeta marcada como de confianza para depurar."), 4000);
      } catch (e) {
        setStatus(String(e), 5000);
      }
    };
  }

  const bind = (id: string, fn: () => unknown) => {
    const el = document.getElementById(id);
    if (el) el.onclick = () => void fn();
  };
  bind("dbg-continue", startOrContinueDebug);
  bind("dbg-pause", pauseDebug);
  bind("dbg-next", stepOverDebug);
  bind("dbg-step-in", stepIntoDebug);
  bind("dbg-step-out", stepOutDebug);
  bind("dbg-stop", stopDebug);
  bind("dbg-bp-clear", () => {
    const prev = Object.keys(breakpoints);
    breakpoints = {};
    saveBreakpoints(breakpoints);
    refreshAllDecorations();
    renderDebug();
    for (const p of prev) void syncBreakpointsForFile(p);
  });

  const evalInput = document.getElementById("dbg-eval-input") as HTMLInputElement | null;
  if (evalInput) {
    evalInput.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      const expr = evalInput.value.trim();
      if (!expr) return;
      evalInput.value = "";
      logConsole("eval", `> ${expr}`);
      if (!inTauri || status === "idle") {
        logConsole("error", t("No hay ninguna sesión de depuración activa."));
        return;
      }
      try {
        const res = await invoke<DapEvalResult>("dap_evaluate", { expression: expr, frameId: activeFrameId });
        logConsole("stdout", res.type ? `${res.result} (${res.type})` : res.result);
      } catch (err) {
        logConsole("error", String(err));
      }
    };
  }

  renderDebug();
}
