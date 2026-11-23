import { t } from "./i18n";
import { isLargeFile, largeFileOptions } from "./largeFile";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { cloneDoc, disposeDoc, docs, isDirty, loadDoc, onDocsChange, saveDoc, type Doc } from "./docs";
import { fileIcon } from "./icons";
import { editorOptions, state } from "./settings";
import { setStatus, showDialog, showMenu, type MenuItem } from "./ui";
import { $, baseName, dirName, fileKey, h } from "./util";
import { rel, ws } from "./workspace";

export interface Group {
  id: number;
  el: HTMLElement;
  tabsEl: HTMLElement;
  crumbsEl: HTMLElement;
  emptyEl: HTMLElement;
  hintEl: HTMLElement;
  editor: monaco.editor.IStandaloneCodeEditor;
  paths: string[];
  active: string | null;
  pinned: Set<string>;
  views: Map<string, monaco.editor.ICodeEditorViewState | null>;
  size: number;
  sig: string;
}

type Direction = "row" | "column";
type Zone = "left" | "right" | "top" | "bottom" | "center";

export const groups: Group[] = [];
let focusedGroup!: Group;
let direction: Direction = "row";
let nextId = 1;
const MAX_GROUPS = 4;
const closedStack: string[] = [];
const openRequests = new WeakMap<Group, number>();
const pendingOpens = new Map<string, number>();

const listeners = new Set<() => void>();
export const onGroupsChange = (f: () => void) => { listeners.add(f); };
const notify = () => listeners.forEach((f) => f());

/** El contenido de un grupo vacío lo dibuja main.ts (bienvenida, recientes…). */
export const config: {
  renderEmpty: (el: HTMLElement, full: boolean) => void;
  probeDefinition?: (model: monaco.editor.ITextModel, position: monaco.Position) => Promise<boolean>;
  goToDefinition?: (model: monaco.editor.ITextModel, position: monaco.Position, isCurrent?: () => boolean) => Promise<boolean>;
} = { renderEmpty: (_el, _full) => {} };

export const getFocused = () => focusedGroup;
export const focusedEditor = () => focusedGroup?.editor;
export const getDirection = () => direction;
export const activePath = () => focusedGroup?.active ?? null;

const TAB_MIME = "application/x-pulso-tab";
export const FILE_MIME = "application/x-pulso-file";

const ICON_SPLIT = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
const ICON_SPLIT_DOWN = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M14 3l7 7-2 1-3 3 .5 4.5-1.5 1.5-4-4-5.5 5.5-1-1L10 14l-4-4 1.5-1.5L12 9l3-3z"/></svg>';

// ---------- Creación y diseño ----------
function createGroup(at: number): Group {
  const el = h("div", "group");
  const tabsEl = h("div", "tabs");
  const crumbsEl = h("div", "crumbs");
  const body = h("div", "gbody");
  const code = h("div", "gcode");
  const emptyEl = h("div", "gempty");
  const hintEl = h("div", "drop-hint");
  hintEl.hidden = true;
  body.append(code, emptyEl, hintEl);
  el.append(tabsEl, crumbsEl, body);

  const editor = monaco.editor.create(code, {
    automaticLayout: true,
    padding: { top: 8 },
    renderLineHighlight: "all",
    smoothScrolling: true,
    bracketPairColorization: { enabled: true },
    scrollBeyondLastLine: false,
    dropIntoEditor: { enabled: false },
    model: null,
    ...editorOptions(state.settings),
  });

  // En WebView2 el texto puede volver a dibujarse entre mouse-down y mouse-up;
  // conservar la posición inicial evita perder el gesto de ir a definición.
  let definitionClick: { position: monaco.Position; x: number; y: number } | null = null;
  let navigationGeneration = 0;
  let hoverGeneration = 0;
  let hoverKey = "";
  let hoverTimer = 0;
  let pointer: { x: number; y: number } | null = null;
  let modifierHeld = false;
  const definitionDecoration = editor.createDecorationsCollection();
  const definitionModifier = (e: MouseEvent) => /Mac/i.test(navigator.platform) ? e.metaKey : e.ctrlKey;
  const clearDefinitionHover = () => {
    hoverGeneration++;
    hoverKey = "";
    clearTimeout(hoverTimer);
    code.classList.remove("pulso-definition-ready");
    definitionDecoration.clear();
  };
  const updateDefinitionHover = () => {
    if (!pointer || !modifierHeld || !config.probeDefinition) { clearDefinitionHover(); return; }
    const model = editor.getModel();
    const target = editor.getTargetAtClientPoint(pointer.x, pointer.y);
    const position = target?.position;
    const word = position && model?.getWordAtPosition(position);
    if (!model || target?.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !position || !word) { clearDefinitionHover(); return; }
    const key = `${model.uri.toString()}:${model.getVersionId()}:${position.lineNumber}:${word.startColumn}`;
    if (key === hoverKey) return;
    clearDefinitionHover();
    hoverKey = key;
    // La mano aparece al instante sobre cualquier palabra con Ctrl; el subrayado espera a confirmar la definición.
    code.classList.add("pulso-definition-ready");
    const current = hoverGeneration;
    hoverTimer = window.setTimeout(() => {
      void config.probeDefinition!(model, position).then((found) => {
        if (!found || current !== hoverGeneration || editor.getModel() !== model || !modifierHeld) return;
        definitionDecoration.set([{ range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), options: { inlineClassName: "pulso-definition-link" } }]);
      }).catch(() => {});
    }, 100);
  };
  code.addEventListener("mousemove", (e) => { pointer = { x: e.clientX, y: e.clientY }; modifierHeld = definitionModifier(e); updateDefinitionHover(); });
  code.addEventListener("mouseleave", () => { pointer = null; clearDefinitionHover(); });
  const modifierDown = (e: KeyboardEvent) => {
    if (e.key === (/Mac/i.test(navigator.platform) ? "Meta" : "Control")) { modifierHeld = true; updateDefinitionHover(); }
  };
  const modifierUp = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") { modifierHeld = false; clearDefinitionHover(); }
  };
  const windowBlur = () => { modifierHeld = false; clearDefinitionHover(); };
  window.addEventListener("keydown", modifierDown);
  window.addEventListener("keyup", modifierUp);
  window.addEventListener("blur", windowBlur);
  // Los archivos muy grandes pierden el resaltado de corchetes y coincidencias para que escribir siga fluido.
  let large: boolean | null = null;
  const syncLargeMode = () => {
    const now = isLargeFile(editor.getModel()?.getValueLength() ?? 0);
    if (now === large) return;
    large = now;
    editor.updateOptions(largeFileOptions(now));
  };
  editor.onDidChangeModel(() => { navigationGeneration++; clearDefinitionHover(); syncLargeMode(); });
  editor.onDidChangeModelContent(() => syncLargeMode());
  editor.onDidChangeModelContent(clearDefinitionHover);
  editor.onDidScrollChange(clearDefinitionHover);
  editor.onDidDispose(() => {
    clearDefinitionHover();
    window.removeEventListener("keydown", modifierDown);
    window.removeEventListener("keyup", modifierUp);
    window.removeEventListener("blur", windowBlur);
  });
  code.addEventListener("mousedown", (e) => {
    definitionClick = null;
    if (e.button !== 0 || !definitionModifier(e) || e.altKey || e.shiftKey) return;
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
    const position = target?.position;
    if (target?.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !position || !editor.getModel()?.getWordAtPosition(position)) return;
    definitionClick = { position, x: e.clientX, y: e.clientY };
    navigationGeneration++;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  code.addEventListener("mouseup", (e) => {
    const click = definitionClick;
    definitionClick = null;
    if (!click || e.button !== 0 || !definitionModifier(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (Math.hypot(e.clientX - click.x, e.clientY - click.y) > 5) return;
    editor.setPosition(click.position);
    editor.focus();
    const model = editor.getModel();
    if (!model) return;
    const current = navigationGeneration;
    const version = model.getVersionId();
    void (async () => {
      const handled = await config.goToDefinition?.(model, click.position, () => current === navigationGeneration && editor.getModel() === model && model.getVersionId() === version);
      if (!handled) await editor.getAction("editor.action.revealDefinition")?.run();
    })().catch((error) => setStatus(t("No se pudo ir a la definición: {error}", { error: String(error) })));
  }, true);

  const g: Group = {
    id: nextId++, el, tabsEl, crumbsEl, emptyEl, hintEl, editor,
    paths: [], active: null, pinned: new Set(), views: new Map(), size: 1, sig: "",
  };
  editor.onDidFocusEditorText(() => setFocused(g));
  editor.onDidChangeCursorPosition(() => { navigationGeneration++; notify(); });
  el.addEventListener("mousedown", () => setFocused(g), true);
  attachDnD(g, body);
  groups.splice(at, 0, g);
  layout();
  return g;
}

function layout() {
  const c = $("groups");
  c.dataset.dir = direction;
  c.replaceChildren();
  groups.forEach((g, i) => {
    if (i) c.append(makeSash(i));
    g.el.style.flex = `${g.size} 1 0`;
    c.append(g.el);
  });
  groups.forEach(render);
}

function makeSash(i: number): HTMLElement {
  const sash = h("div", "sash");
  sash.onmousedown = (e) => {
    e.preventDefault();
    const a = groups[i - 1], b = groups[i];
    const horiz = direction === "row";
    const start = horiz ? e.clientX : e.clientY;
    groups.forEach((g) => { g.size = horiz ? g.el.offsetWidth : g.el.offsetHeight; });
    const sa = a.size, sb = b.size;
    const min = 140;
    sash.classList.add("dragging");
    const move = (ev: MouseEvent) => {
      const d = Math.max(min - sa, Math.min(sb - min, (horiz ? ev.clientX : ev.clientY) - start));
      a.size = sa + d;
      b.size = sb - d;
      groups.forEach((g) => { g.el.style.flex = `${g.size} 1 0`; });
    };
    const up = () => {
      sash.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return sash;
}

export function initGroups() {
  setFocused(createGroup(0));
}

export function setFocused(g: Group) {
  const changed = focusedGroup !== g;
  focusedGroup = g;
  groups.forEach((x) => x.el.classList.toggle("focused", x === g));
  if (changed) notify();
}

// ---------- Dibujo de pestañas y migas ----------
function render(g: Group) {
  renderTabs(g);
  renderCrumbs(g);
  const empty = g.paths.length === 0;
  g.emptyEl.hidden = !empty;
  if (empty) {
    g.emptyEl.replaceChildren();
    config.renderEmpty(g.emptyEl, groups.length === 1);
  }
}

const dirtySig = (g: Group) => g.paths.map((p) => (docs.get(p) && isDirty(docs.get(p)!) ? 1 : 0)).join("");

function renderTabs(g: Group) {
  g.sig = dirtySig(g);
  const bar = g.tabsEl;
  bar.replaceChildren();
  const names = g.paths.map(baseName);
  g.paths.forEach((path, i) => {
    const d = docs.get(path);
    if (!d) return;
    const pinned = g.pinned.has(path);
    const tab = h("div", "tab" + (path === g.active ? " active" : "") + (isDirty(d) ? " dirty" : "") + (pinned ? " pinned" : ""));
    tab.dataset.path = path;
    tab.title = path;
    tab.draggable = true;
    tab.append(fileIcon(names[i]), h("span", "tlabel", names[i]));
    if (names.filter((n) => n === names[i]).length > 1) {
      tab.append(h("span", "tdir", rel(dirName(path)).split("/").pop() ?? ""));
    }
    const close = h("span", "close");
    if (pinned) {
      close.innerHTML = ICON_PIN;
      close.title = t("Desfijar");
      close.onclick = (e) => { e.stopPropagation(); togglePin(g, path); };
    } else {
      close.append(h("span", "x", "×"));
      close.title = t("Cerrar");
      close.onclick = (e) => { e.stopPropagation(); void closeTab(g, path); };
    }
    tab.append(close);
    tab.onclick = () => activate(g, path);
    tab.onauxclick = (e) => { if (e.button === 1 && !pinned) void closeTab(g, path); };
    tab.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, tabMenu(g, path)); };
    tab.ondragstart = (e) => {
      e.dataTransfer?.setData(TAB_MIME, JSON.stringify({ gid: g.id, path }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      tab.classList.add("dragging");
    };
    tab.ondragend = () => tab.classList.remove("dragging");
    bar.append(tab);
  });

  const actions = h("div", "tab-actions");
  const split = h("button", "icon-btn");
  split.innerHTML = direction === "row" ? ICON_SPLIT : ICON_SPLIT_DOWN;
  split.title = t("Dividir el editor");
  split.onclick = () => { const n = splitGroup(g.active); n?.editor.focus(); };
  actions.append(split);
  if (groups.length > 1) {
    const x = h("button", "icon-btn");
    x.innerHTML = ICON_CLOSE;
    x.title = t("Cerrar grupo");
    x.onclick = () => { void closeGroup(g); };
    actions.append(x);
  }
  bar.append(actions);
  bar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderCrumbs(g: Group) {
  g.crumbsEl.replaceChildren();
  if (!g.active) return;
  const parts = rel(g.active).split("/").filter(Boolean);
  parts.forEach((part, i) => {
    if (i) g.crumbsEl.append(h("span", "sep", "›"));
    g.crumbsEl.append(h("span", "crumb", part));
  });
}

function tabMenu(g: Group, path: string): MenuItem[] {
  const i = g.paths.indexOf(path);
  return [
    { label: t("Cerrar"), run: () => void closeTab(g, path) },
    { label: t("Cerrar las demás"), run: () => void closeMany(g, g.paths.filter((p) => p !== path)) },
    { label: t("Cerrar las de la derecha"), disabled: i === g.paths.length - 1, run: () => void closeMany(g, g.paths.slice(i + 1)) },
    { label: t("Cerrar todas"), run: () => void closeMany(g, [...g.paths]) },
    "sep",
    { label: g.pinned.has(path) ? t("Desfijar") : t("Fijar"), run: () => togglePin(g, path) },
    { label: t("Abrir en un grupo nuevo"), run: () => { const n = splitGroup(path); n?.editor.focus(); } },
    "sep",
    { label: t("Copiar ruta"), run: () => void navigator.clipboard.writeText(path) },
    { label: t("Copiar ruta relativa"), run: () => void navigator.clipboard.writeText(rel(path)) },
    { label: t("Mostrar en el explorador de archivos"), run: () => void invoke("reveal_in_explorer", { path }) },
  ];
}

// ---------- Apertura, activación y cierre ----------
export function activate(g: Group, path: string | null) {
  openRequests.set(g, (openRequests.get(g) ?? 0) + 1);
  if (g.active) g.views.set(g.active, g.editor.saveViewState());
  g.active = path;
  const d = path ? docs.get(path) : undefined;
  g.editor.setModel(d ? d.model : null);
  const view = path ? g.views.get(path) : null;
  if (view) g.editor.restoreViewState(view);
  render(g);
  setFocused(g);
  notify();
}

export interface OpenOpts { line?: number; col?: number; len?: number; group?: Group; focus?: boolean }

export async function openFile(path: string, o: OpenOpts = {}): Promise<void> {
  const g = o.group ?? focusedGroup;
  const root = ws.root;
  const request = (openRequests.get(g) ?? 0) + 1;
  openRequests.set(g, request);
  const key = fileKey(path);
  pendingOpens.set(key, (pendingOpens.get(key) ?? 0) + 1);
  try {
    path = (await loadDoc(path)).path;
  } catch (e) {
    const msg = String(e);
    setStatus(t("No se pudo abrir {file}: {error}", { file: baseName(path), error: /utf-?8/i.test(msg) ? t("no es un archivo de texto") : msg }));
    return;
  } finally {
    const remaining = (pendingOpens.get(key) ?? 1) - 1;
    if (remaining) pendingOpens.set(key, remaining); else pendingOpens.delete(key);
  }
  if (openRequests.get(g) !== request || !groups.includes(g) || ws.root !== root) {
    if (!pendingOpens.has(key) && !inAnyGroup(path)) disposeDoc(path);
    return;
  }
  if (!g.paths.includes(path)) {
    let i = g.active ? g.paths.indexOf(g.active) + 1 : g.paths.length;
    i = Math.max(i, g.pinned.size);
    g.paths.splice(i, 0, path);
  }
  activate(g, path);
  if (o.line) {
    const col = o.col ?? 1;
    const range = new monaco.Range(o.line, col, o.line, col + (o.len ?? 0));
    g.editor.setSelection(range);
    g.editor.revealRangeInCenter(range);
  }
  if (o.focus !== false) g.editor.focus();
}

const inAnyGroup = (path: string, except?: Group) => groups.some((x) => x !== except && x.paths.includes(path));

function releaseIfUnused(path: string) {
  if (!inAnyGroup(path)) disposeDoc(path);
}

function removeFromGroup(g: Group, path: string) {
  const idx = g.paths.indexOf(path);
  if (idx < 0) return;
  g.paths.splice(idx, 1);
  g.pinned.delete(path);
  g.views.delete(path);
  if (g.paths.length === 0 && groups.length > 1) { removeGroup(g); return; }
  if (g.active === path) activate(g, g.paths[Math.min(idx, g.paths.length - 1)] ?? null);
  else { render(g); notify(); }
}

export async function closeTab(g: Group, path: string, force = false): Promise<boolean> {
  const d = docs.get(path);
  if (!force && d && isDirty(d) && !inAnyGroup(path, g)) {
    const r = await showDialog({
      title: t("¿Guardar los cambios?"),
      message: t("{file} tiene cambios sin guardar.", { file: baseName(path) }),
      buttons: [
        { label: t("Guardar"), value: "save", primary: true },
        { label: t("No guardar"), value: "discard", danger: true },
        { label: t("Cancelar"), value: "cancel" },
      ],
    });
    if (r === "cancel") return false;
    if (r === "save" && !(await saveDoc(d))) return false;
  }
  if (!force) {
    closedStack.push(path);
    if (closedStack.length > 50) closedStack.shift();
  }
  removeFromGroup(g, path);
  releaseIfUnused(path);
  return true;
}

async function closeMany(g: Group, paths: string[]): Promise<boolean> {
  for (const p of paths) if (!(await closeTab(g, p))) return false;
  return true;
}

/** Cierra todas las pestañas de todos los grupos; false si el usuario cancela. */
export async function closeAllTabs(): Promise<boolean> {
  for (const g of groups) openRequests.set(g, (openRequests.get(g) ?? 0) + 1);
  for (const g of [...groups]) if (!(await closeMany(g, [...g.paths]))) return false;
  return true;
}

export async function closeGroup(g: Group): Promise<boolean> {
  if (!(await closeMany(g, [...g.paths]))) return false;
  if (groups.includes(g) && groups.length > 1) removeGroup(g);
  return true;
}

function removeGroup(g: Group) {
  const idx = groups.indexOf(g);
  if (idx < 0) return;
  groups.splice(idx, 1);
  const leftover = g.paths.slice();
  g.editor.dispose();
  g.el.remove();
  if (focusedGroup === g) focusedGroup = groups[Math.max(0, idx - 1)];
  layout();
  leftover.forEach(releaseIfUnused);
  setFocused(focusedGroup);
  notify();
}

export async function reopenClosed() {
  const p = closedStack.pop();
  if (p) await openFile(p);
}

export function closeActive() {
  const g = focusedGroup;
  if (g?.active && !g.pinned.has(g.active)) return closeTab(g, g.active);
  return Promise.resolve(false);
}

export function closeOthers() {
  const g = focusedGroup;
  if (g?.active) return closeMany(g, g.paths.filter((p) => p !== g.active));
  return Promise.resolve(false);
}

export function closeAllInGroup() {
  return closeMany(focusedGroup, [...focusedGroup.paths]);
}

export function nextTab(step: number) {
  const g = focusedGroup;
  if (g.paths.length < 2 || !g.active) return;
  const i = (g.paths.indexOf(g.active) + step + g.paths.length) % g.paths.length;
  activate(g, g.paths[i]);
  g.editor.focus();
}

export function togglePin(g: Group, path: string) {
  if (g.pinned.has(path)) g.pinned.delete(path); else g.pinned.add(path);
  g.paths = [...g.paths.filter((p) => g.pinned.has(p)), ...g.paths.filter((p) => !g.pinned.has(p))];
  render(g);
  notify();
}

// ---------- Dividir y mover ----------
/** Crea un grupo a la derecha (o debajo). `path` undefined = archivo activo, null = vacío. */
export function splitGroup(path?: string | null): Group | null {
  if (groups.length >= MAX_GROUPS) { setStatus(t("Máximo de grupos de editores alcanzado")); return null; }
  const base = focusedGroup;
  const p = path === undefined ? base.active : path;
  const g = createGroup(groups.indexOf(base) + 1);
  if (p) { g.paths.push(p); activate(g, p); } else setFocused(g);
  return g;
}

export function toggleDirection() {
  direction = direction === "row" ? "column" : "row";
  groups.forEach((g) => { g.size = 1; });
  layout();
  notify();
}

export function focusGroup(i: number) {
  const g = groups[i];
  if (g) { setFocused(g); g.editor.focus(); }
}

export function moveToNextGroup() {
  const g = focusedGroup;
  if (!g.active) return;
  let target = groups[groups.indexOf(g) + 1] ?? groups[groups.indexOf(g) - 1];
  if (!target) target = splitGroup(null) as Group;
  if (target) { moveTab(g, target, g.active); target.editor.focus(); }
}

/** Mueve una pestaña a otro grupo (o la reordena dentro del mismo). */
export function moveTab(from: Group, to: Group, path: string, before: string | null = null) {
  const place = () => {
    to.paths = to.paths.filter((p) => p !== path);
    const idx = before ? to.paths.indexOf(before) : -1;
    to.paths.splice(idx < 0 ? to.paths.length : idx, 0, path);
    to.paths = [...to.paths.filter((p) => to.pinned.has(p)), ...to.paths.filter((p) => !to.pinned.has(p))];
  };
  if (from === to) {
    place();
    render(to);
    return;
  }
  place();
  activate(to, path);
  removeFromGroup(from, path);
}

// ---------- Arrastrar y soltar ----------
function attachDnD(g: Group, body: HTMLElement) {
  const accepts = (e: DragEvent) =>
    !!e.dataTransfer && (e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(FILE_MIME));

  const zoneOf = (e: DragEvent): Zone => {
    const r = body.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    if (direction === "row") { if (fx < 0.25) return "left"; if (fx > 0.75) return "right"; }
    else { if (fy < 0.25) return "top"; if (fy > 0.75) return "bottom"; }
    return "center";
  };

  body.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    g.hintEl.hidden = false;
    g.hintEl.className = `drop-hint h-${groups.length >= MAX_GROUPS ? "center" : zoneOf(e)}`;
  }, true);
  body.addEventListener("dragleave", (e) => {
    if (!(e.relatedTarget instanceof Node) || !body.contains(e.relatedTarget)) g.hintEl.hidden = true;
  }, true);
  body.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    g.hintEl.hidden = true;
    let zone = zoneOf(e);
    if (groups.length >= MAX_GROUPS) zone = "center";
    void handleDrop(e, g, zone, null);
  }, true);

  g.tabsEl.addEventListener("dragover", (e) => { if (accepts(e)) e.preventDefault(); });
  g.tabsEl.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".tab");
    let before: string | null = null;
    if (tab) {
      const r = tab.getBoundingClientRect();
      const next = tab.nextElementSibling as HTMLElement | null;
      before = e.clientX < r.left + r.width / 2 ? tab.dataset.path ?? null : next?.dataset.path ?? null;
    }
    void handleDrop(e, g, "center", before);
  });
}

async function handleDrop(e: DragEvent, g: Group, zone: Zone, before: string | null) {
  const dt = e.dataTransfer!;
  const tabData = dt.getData(TAB_MIME);
  const fileData = dt.getData(FILE_MIME);
  let from: Group | undefined;
  let path = fileData;
  if (tabData) {
    const p = JSON.parse(tabData) as { gid: number; path: string };
    from = groups.find((x) => x.id === p.gid);
    path = p.path;
  }
  if (!path) return;
  let target = g;
  if (zone !== "center") {
    target = createGroup(groups.indexOf(g) + (zone === "right" || zone === "bottom" ? 1 : 0));
  }
  if (from) moveTab(from, target, path, before);
  else {
    await openFile(path, { group: target });
    if (before) moveTab(target, target, path, before);
  }
}

// ---------- Renombrar / eliminar rutas abiertas ----------
export function renamePaths(oldP: string, newP: string) {
  const affected = Array.from(docs.keys()).filter((p) => p === oldP || p.startsWith(oldP + "/"));
  for (const p of affected) {
    const np = newP + p.slice(oldP.length);
    const nd: Doc = cloneDoc(docs.get(p)!, np);
    for (const g of groups) {
      const i = g.paths.indexOf(p);
      if (i < 0) continue;
      g.paths[i] = np;
      if (g.pinned.delete(p)) g.pinned.add(np);
      g.views.delete(p);
      if (g.active === p) { g.active = np; g.editor.setModel(nd.model); }
    }
    disposeDoc(p);
  }
  for (let i = 0; i < closedStack.length; i++) {
    if (closedStack[i] === oldP || closedStack[i].startsWith(oldP + "/")) closedStack[i] = newP + closedStack[i].slice(oldP.length);
  }
  groups.forEach(render);
  notify();
}

/** Cierra sin preguntar las pestañas de una ruta eliminada. */
export async function removePaths(target: string) {
  const match = (p: string) => p === target || p.startsWith(target + "/");
  for (const g of [...groups]) {
    for (const p of [...g.paths]) if (match(p) && groups.includes(g)) await closeTab(g, p, true);
  }
  for (let i = closedStack.length - 1; i >= 0; i--) if (match(closedStack[i])) closedStack.splice(i, 1);
}

// ---------- Guardado ----------
export async function saveActive() {
  const p = focusedGroup?.active;
  const d = p ? docs.get(p) : undefined;
  if (d) await saveDoc(d);
}

export async function saveAll(): Promise<boolean> {
  for (const d of Array.from(docs.values())) {
    if (isDirty(d) && !(await saveDoc(d))) return false;
  }
  return true;
}

// ---------- Configuración y sesión ----------
export function applySettingsToEditors() {
  groups.forEach((g) => g.editor.updateOptions(editorOptions(state.settings)));
  docs.forEach((d) => d.model.updateOptions({ tabSize: state.settings.tabSize }));
}

export function rerenderGroups() {
  groups.forEach(render);
}

export function rerenderEmpty() {
  groups.forEach((g) => { if (!g.paths.length) render(g); });
}

export interface Layout {
  dir: Direction;
  focus: number;
  groups: { paths: string[]; active: string | null; pinned: string[] }[];
}

export function serialize(): Layout {
  return {
    dir: direction,
    focus: groups.indexOf(focusedGroup),
    groups: groups.map((g) => ({ paths: [...g.paths], active: g.active, pinned: [...g.pinned] })),
  };
}

export async function restore(data: Layout | null | undefined) {
  if (!data?.groups?.length) return;
  direction = data.dir === "column" ? "column" : "row";
  while (groups.length < Math.min(data.groups.length, MAX_GROUPS)) createGroup(groups.length);
  layout();
  for (let i = 0; i < groups.length && i < data.groups.length; i++) {
    const g = groups[i], s = data.groups[i];
    for (const p of s.paths) {
      try {
        const d = await loadDoc(p);
        if (!g.paths.includes(d.path)) g.paths.push(d.path);
      } catch { /* el archivo ya no existe */ }
    }
    for (const p of s.pinned) {
      const canonical = g.paths.find((path) => fileKey(path) === fileKey(p));
      if (canonical) g.pinned.add(canonical);
    }
    const active = s.active ? g.paths.find((path) => fileKey(path) === fileKey(s.active!)) : undefined;
    activate(g, active ?? g.paths[0] ?? null);
  }
  for (const g of [...groups]) if (!g.paths.length && groups.length > 1) removeGroup(g);
  setFocused(groups[data.focus] ?? groups[0]);
}

onDocsChange(() => {
  let changed = false;
  for (const g of groups) if (dirtySig(g) !== g.sig) { renderTabs(g); changed = true; }
  if (changed) notify();
});
