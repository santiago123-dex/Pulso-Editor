import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { eventKey } from "./commands";
import { commit, currentTheme, state } from "./settings";
import { detectPrefs, hasAnythingToAdapt, planAdaptation, resolveScheme, shellIdFor, type Adaptation, type Detected, type ShellInfo } from "./terminalPrefs";
import { hooks, setStatus, showDialog, showMenu } from "./ui";
import { $, h, terminalFontStack } from "./util";
import { ws } from "./workspace";

export type { ShellInfo };

interface Term {
  id: number;
  label: string;
  xterm: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  exited: boolean;
}

const inTauri = "__TAURI_INTERNALS__" in window;
let order: Term[] = [];
const byId = new Map<number, Term>();
let active: Term | null = null;
let counter = 0;
let shells: ShellInfo[] | null = null;
let listening = false;
/** Salida que llega antes de que `term_spawn` devuelva el id (p. ej. el primer prompt). */
const early = new Map<number, Uint8Array[]>();
const earlyExit = new Map<number, number>();

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function listShells(): Promise<ShellInfo[]> {
  if (!shells) {
    try { shells = await invoke<ShellInfo[]>("term_shells"); } catch { shells = []; }
  }
  return shells;
}

async function preferredShell(): Promise<ShellInfo | undefined> {
  const list = await listShells();
  return list.find((s) => s.id === state.settings.terminalShell) ?? list[0];
}

async function ensureListening() {
  if (listening) return;
  listening = true;
  await listen<{ id: number; data: string }>("term-data", (e) => {
    const bytes = decode(e.payload.data);
    const t = byId.get(e.payload.id);
    if (t) t.xterm.write(bytes);
    else early.set(e.payload.id, [...(early.get(e.payload.id) ?? []), bytes]);
  });
  await listen<{ id: number; code: number }>("term-exit", (e) => {
    const t = byId.get(e.payload.id);
    if (t) onExit(t, e.payload.code);
    else earlyExit.set(e.payload.id, e.payload.code);
  });
}

// ---------- Panel ----------
export const isPanelOpen = () => !$("panel").hidden;
export const terminalCount = () => order.length;

function showPanel(show: boolean) {
  $("panel").hidden = !show;
  if (show) requestAnimationFrame(() => { active?.fit.fit(); });
}

export function hidePanel() {
  showPanel(false);
  hooks.focusEditor();
}

function renderTabs() {
  const bar = $("term-tabs");
  bar.replaceChildren();
  for (const t of order) {
    const tab = h("div", "term-tab" + (t === active ? " active" : "") + (t.exited ? " exited" : ""));
    tab.title = t.label;
    tab.append(h("span", "term-glyph", ">_"), h("span", "term-label", t.label));
    const close = h("span", "term-close", "×");
    close.title = "Terminar esta terminal";
    close.onclick = (e) => { e.stopPropagation(); closeTerm(t); };
    tab.append(close);
    tab.onclick = () => activateTerm(t);
    tab.onauxclick = (e) => { if (e.button === 1) closeTerm(t); };
    bar.append(tab);
  }
}

function activateTerm(t: Term) {
  active = t;
  for (const o of order) o.el.hidden = o !== t;
  renderTabs();
  requestAnimationFrame(() => {
    t.fit.fit();
    t.xterm.refresh(0, t.xterm.rows - 1);
    t.xterm.focus();
  });
}

function closeTerm(t: Term) {
  const idx = order.indexOf(t);
  void invoke("term_kill", { id: t.id }).catch(() => {});
  byId.delete(t.id);
  order = order.filter((o) => o !== t);
  t.xterm.dispose();
  t.el.remove();
  if (active === t) {
    active = order[Math.min(idx, order.length - 1)] ?? null;
    if (active) activateTerm(active);
  }
  renderTabs();
  if (!order.length) hidePanel();
}

function onExit(t: Term, code: number) {
  t.exited = true;
  // Un `exit` normal cierra la terminal; si falló se deja el mensaje a la vista.
  if (code === 0) { closeTerm(t); return; }
  t.xterm.write(`\r\n\x1b[2m[El proceso terminó con el código ${code}]\x1b[0m\r\n`);
  renderTabs();
}

// ---------- Crear terminales ----------
/** Lo que el usuario ya tiene en otras terminales (se rellena al iniciar). */
let detected: Detected | null = null;

const fontOptions = () => ({
  fontFamily: terminalFontStack(state.settings.terminalFont, state.settings.fontFamily, [], detected?.nerd ?? []),
  fontSize: state.settings.terminalFontSize || Math.max(10, state.settings.fontSize - 1),
  cursorStyle: state.settings.terminalCursor,
});

const currentScheme = () => resolveScheme(state.settings.terminalScheme, detected, currentTheme());

/** Aplica fuente, tamaño, colores, shell y cursor detectados en otras terminales del usuario. */
export function applyAdaptation(plan: Adaptation) {
  const s = state.settings;
  if (plan.font) s.terminalFont = plan.font;
  if (plan.size) s.terminalFontSize = plan.size;
  if (plan.scheme) s.terminalScheme = plan.scheme;
  if (plan.shell) s.terminalShell = plan.shell;
  if (plan.cursor) s.terminalCursor = plan.cursor;
  s.terminalAdapted = true;
  commit();
}

/** Muestra lo que se encontró y, si el usuario acepta, lo aplica. Devuelve true si se aplicó algo. */
export async function adaptToMyTerminal(): Promise<boolean> {
  detected = await detectPrefs();
  const plan = planAdaptation(detected, await listShells());
  if (!plan.summary.length) {
    setStatus("No encontré configuración de terminal en VS Code ni en Windows Terminal");
    return false;
  }
  const r = await showDialog({
    title: "Adaptar la terminal a la tuya",
    message: "Encontré esta configuración en tus otras terminales:\n\n" + plan.summary.map((l) => "\u2022 " + l).join("\n") + "\n\n¿Quieres que Pulso la use?",
    buttons: [
      { label: "No, gracias", value: "no" },
      { label: "Usar la mía", value: "yes", primary: true },
    ],
  });
  if (r !== "yes") return false;
  applyAdaptation(plan);
  setStatus("Terminal adaptada a tu configuración");
  return true;
}

/** La primera vez que se abre una terminal se ofrece adaptarla (una sola vez). */
async function offerAdaptationOnce() {
  if (state.settings.terminalAdapted) return;
  detected = await detectPrefs();
  const list = await listShells();
  if (hasAnythingToAdapt(detected, list)) await adaptToMyTerminal();
  state.settings.terminalAdapted = true;
  commit();
}

export async function newTerminal(opts: { shell?: ShellInfo; cwd?: string } = {}): Promise<boolean> {
  if (!inTauri) { setStatus("La terminal solo funciona en la ventana de Pulso Editor."); return false; }
  await offerAdaptationOnce();
  const shell = opts.shell ?? (await preferredShell());
  if (!shell) { setStatus("No se encontró ninguna shell instalada."); return false; }
  await ensureListening();
  showPanel(true);

  const el = h("div", "term-pane");
  for (const o of order) o.el.hidden = true;
  $("term-body").append(el);
  const xterm = new Terminal({
    ...fontOptions(),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: currentScheme(),
    windowsPty: navigator.userAgent.includes("Windows") ? { backend: "conpty" } : undefined,
  });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  fit.fit();

  let id: number;
  try {
    id = await invoke<number>("term_spawn", {
      shell: shell.path,
      args: shell.args,
      cwd: opts.cwd ?? ws.root ?? null,
      cols: xterm.cols,
      rows: xterm.rows,
    });
  } catch (e) {
    xterm.dispose();
    el.remove();
    if (!order.length) showPanel(false);
    setStatus(`No se pudo abrir la terminal: ${e}`);
    return false;
  }

  const t: Term = { id, label: `${shell.label} ${++counter}`, xterm, fit, el, exited: false };
  byId.set(id, t);
  order.push(t);

  xterm.onData((d) => { void invoke("term_write", { id, data: d }).catch(() => {}); });
  xterm.onResize(({ cols, rows }) => { void invoke("term_resize", { id, cols, rows }).catch(() => {}); });
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = eventKey(e);
    if (k === "Ctrl+Shift+C" || (k === "Ctrl+C" && xterm.hasSelection())) { copySelection(t); return false; }
    if (k === "Ctrl+Shift+V") { void pasteInto(t); return false; }
    return true;
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Copiar", hint: "Ctrl+Shift+C", disabled: !xterm.hasSelection(), run: () => copySelection(t) },
      { label: "Pegar", hint: "Ctrl+Shift+V", run: () => void pasteInto(t) },
      { label: "Seleccionar todo", run: () => xterm.selectAll() },
      "sep",
      { label: "Limpiar", run: () => xterm.clear() },
      { label: "Nueva terminal", run: () => void newTerminal() },
    ]);
  });

  for (const chunk of early.get(id) ?? []) xterm.write(chunk);
  early.delete(id);
  activateTerm(t);
  const code = earlyExit.get(id);
  if (code !== undefined) { earlyExit.delete(id); onExit(t, code); }
  return true;
}

function copySelection(t: Term) {
  const text = t.xterm.getSelection();
  if (text) void navigator.clipboard.writeText(text).catch(() => setStatus("No se pudo copiar al portapapeles"));
}

async function pasteInto(t: Term) {
  try { t.xterm.paste(await navigator.clipboard.readText()); } catch { setStatus("No se pudo leer el portapapeles"); }
}

// ---------- Acciones públicas ----------
export async function toggleTerminal() {
  if (isPanelOpen()) { hidePanel(); return; }
  if (!order.length) { await newTerminal(); return; }
  showPanel(true);
  if (active) activateTerm(active);
}

export function clearTerminal() { active?.xterm.clear(); }

export function killActiveTerminal() { if (active) closeTerm(active); }

export function focusTerminal() { active?.xterm.focus(); }

/** Escribe texto en la terminal activa (creándola si hace falta) y lo ejecuta. */
export async function runInTerminal(text: string) {
  if (!order.length && !(await newTerminal())) return;
  showPanel(true);
  const lines = text.replace(/\r?\n/g, "\r");
  await invoke("term_write", { id: active!.id, data: lines.endsWith("\r") ? lines : lines + "\r" }).catch(() => {});
  active?.xterm.focus();
}

/** Aplica el tema y la fuente actuales a todas las terminales abiertas. */
export function applyTerminalSettings() {
  const theme = currentScheme();
  for (const t of order) {
    t.xterm.options.theme = theme;
    Object.assign(t.xterm.options, fontOptions());
    if (t === active) requestAnimationFrame(() => t.fit.fit());
  }
}

// ---------- Inicio ----------
export function initTerminal() {
  void detectPrefs().then((d) => { detected = d; applyTerminalSettings(); });
  // Si la ventana se recargó, las shells de antes ya no tienen pestaña: se cierran.
  if (inTauri) void invoke("term_kill_all").catch(() => {});
  $("term-new").onclick = () => void newTerminal();
  $("term-hide").onclick = hidePanel;
  $("term-shells").onclick = async (e) => {
    const r = ($("term-shells") as HTMLElement).getBoundingClientRect();
    const list = await listShells();
    e.stopPropagation();
    showMenu(r.left, r.top - 8 - list.length * 28, list.map((s) => ({
      label: s.label + (s.id === (state.settings.terminalShell || list[0]?.id) ? "  ✓" : ""),
      run: () => void newTerminal({ shell: s }),
    })));
  };

  let maximized = false;
  $("term-max").onclick = () => {
    maximized = !maximized;
    const parent = $("panel").parentElement!;
    document.documentElement.style.setProperty("--panel-h", maximized ? `${Math.round(parent.clientHeight * 0.75)}px` : "280px");
    requestAnimationFrame(() => active?.fit.fit());
  };

  // Arrastrar el borde superior para cambiar la altura.
  $("panel-sash").onmousedown = (e) => {
    e.preventDefault();
    const parent = $("panel").parentElement!;
    const sash = $("panel-sash");
    sash.classList.add("dragging");
    const move = (ev: MouseEvent) => {
      const box = parent.getBoundingClientRect();
      const height = Math.max(100, Math.min(box.height - 120, box.bottom - ev.clientY));
      document.documentElement.style.setProperty("--panel-h", `${height}px`);
    };
    const up = () => {
      sash.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      active?.fit.fit();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (isPanelOpen()) active?.fit.fit(); });
  }).observe($("term-body"));
}
