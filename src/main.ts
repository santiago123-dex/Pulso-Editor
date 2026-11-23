import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates, initUpdates } from "./updates";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { bus } from "./core/events";
import { createPrForActiveIssue } from "./workflow/issueWorkflow";
import { planCliOpen, type CliTarget } from "./cliOpen";
import { commands, initKeys, keyOf, register } from "./commands";
import { checkExternal, dirtyDocs, discardDirtyBackups, docs, flushBackups, offerRecovery, onDocSaved, saveDoc } from "./docs";
import { autoConnect, initToken } from "./github";
import { gitInfo, onGitChange, type GitInfo } from "./git";
import { collapseAll, highlight, initExplorer, newEntry, refreshGitDecorations, refreshTree, resetExplorer, revealInTree } from "./explorer";
import {
  activePath, applySettingsToEditors, closeActive, closeAllInGroup, closeAllTabs, closeGroup, closeOthers, config,
  focusGroup, focusedEditor, getFocused, initGroups, moveToNextGroup, nextTab, onGroupsChange, openFile,
  reopenClosed, rerenderEmpty, rerenderGroups, restore, saveActive, saveAll, serialize, splitGroup, toggleDirection, togglePin,
  type Layout,
} from "./groups";
import { fileIcon, loadIconManifest } from "./icons";
import { openBoard } from "./board";
import { initIssues, loadIssues } from "./issues";
import { initProblems, setProblemsVisible } from "./problems";
import { pickScript } from "./scripts";
import { initHistory, openHistoryTab, resetHistory, showFileHistory } from "./history";
import { initBlame, toggleBlame } from "./blame";
import { initPrs, newPull, resetPrs, setPrsVisible } from "./prs";
import { initAi, setAiVisible, startNewConversation } from "./aiChat";
import { customizeActivityBar, initActivityBar, resetActivityBar } from "./activityBar";
import { resetRepoChat, setChatVisible } from "./repoChat";
import { initLsp, setLspWorkspace } from "./lsp";
import { getLspState, lspDetail, lspLabel, onLspState } from "./lspState";
import { commitStaged, initScm, pickBranch, pullChanges, pushChanges, refreshScm, stage, unstage } from "./scm";
import { focusSearch, initSearch, searchInFolder } from "./search";
import { allThemes, applyTheme, commit, onSettingsChange, setTheme, state, syntaxOptionsFor } from "./settings";
import { adaptToMyTerminal, applyTerminalSettings, clearTerminal, initTerminal, killActiveTerminal, newTerminal, runInTerminal, toggleTerminal } from "./terminal";
import { openThemeGallery } from "./themeGallery";
import { createNav } from "./nav";
import { beat, initTitlebar, setNavState, setTitleLabel, setUnsaved, type MenuDef, type MenuEntry } from "./titlebar";
import { importFromFile, importInstalled, removeImported } from "./themeImport";
import { closeSettings, initSettingsPage, openSettings, syncSettingsUI, toggleSettings } from "./settingsPage";
import { hooks, quickPick, setDefaultStatus, setStatus, showDialog, type PickItem } from "./ui";
import { $, baseName, dirName, h, norm } from "./util";
import { addRecent, clearLastRoot, clearSession, createSessionPersister, getLastRoot, getRecent, loadSession, rel, removeRecent, saveSession, setLastRoot, ws } from "./workspace";

// La sesión se lee antes que nada: lo que ocurra durante el arranque no debe poder pisarla.
const startupSession = loadSession();
const startupLastRoot = getLastRoot();

function revealApp() {
  document.body.classList.add("ready");
  window.setTimeout(() => document.getElementById("splash")?.remove(), 450);
}
// Si algo se atasca, la pantalla de carga no se queda para siempre.
window.setTimeout(revealApp, 12000);

(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html") return new htmlWorker();
    return new editorWorker();
  },
};

// Monaco no conoce node_modules ni tsconfig: ocultamos los errores de módulos que no puede resolver.
const ts = monaco.languages.typescript;
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
  });
  defaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: [2307, 2792, 7016, 2688] });
}

const inTauri = "__TAURI_INTERNALS__" in window;
hooks.focusEditor = () => focusedEditor()?.focus();

// ---------- Vistas de la barra lateral ----------
type View = "explorer" | "search" | "git" | "issues" | "problems" | "chat" | "prs" | "ai";
let currentView: View = "explorer";

function showView(view: View | "settings") {
  if (view === "settings") { toggleSettings(); return; }
  closeSettings();
  const app = $("app");
  if (view === currentView && !app.classList.contains("no-sidebar")) { app.classList.add("no-sidebar"); setProblemsVisible(false); setChatVisible(false); setPrsVisible(false); setAiVisible(false); return; }
  app.classList.remove("no-sidebar");
  currentView = view;
  document.querySelectorAll<HTMLElement>(".act[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  for (const v of ["explorer", "search", "git", "issues", "problems", "chat", "prs", "ai"] as View[]) $(`view-${v}`).hidden = v !== view;
  setProblemsVisible(view === "problems");
  setChatVisible(view === "chat");
  setPrsVisible(view === "prs");
  setAiVisible(view === "ai");
  if (view === "issues") void loadIssues();
  if (view === "git") void refreshScm();
}
initActivityBar({
  onSelect: (view) => showView(view as View | "settings"),
  activeView: () => currentView,
});

const resizer = $("resizer");
resizer.onmousedown = (e) => {
  e.preventDefault();
  resizer.classList.add("dragging");
  const move = (ev: MouseEvent) => $("app").style.setProperty("--sidebar-w", `${Math.min(600, Math.max(180, ev.clientX - 48))}px`);
  const up = () => {
    resizer.classList.remove("dragging");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};

// ---------- Carpeta de trabajo y sesión ----------
const persister = createSessionPersister(() => saveSession({ root: ws.root, layout: serialize() }));
const persist = () => persister.schedule();

async function openWorkspace(raw: string, layout?: Layout | null): Promise<boolean> {
  const path = norm(raw).replace(/\/+$/, "");
  if (ws.root !== path && !(await closeAllTabs())) return false;
  try {
    if (inTauri) await invoke("set_workspace_root", { path });
    await invoke("list_dir", { path });
  } catch (e) {
    if (inTauri) await invoke("set_workspace_root", { path: ws.root }).catch(() => {});
    setStatus(`No se pudo abrir la carpeta: ${e}`);
    removeRecent(path);
    return false;
  }
  const changedWorkspace = ws.root !== path;
  ws.root = path;
  if (inTauri && changedWorkspace) setLspWorkspace(path);
  setLastRoot(path);
  addRecent(path);
  resetExplorer();
  if (changedWorkspace) {
    resetHistory();
    resetPrs();
    resetRepoChat();
  }
  $("tree-empty").hidden = true;
  const fn = $("folder-name");
  fn.textContent = baseName(path);
  fn.classList.add("on");
  setDefaultStatus(path);
  await refreshTree();
  if (layout) await restore(layout);
  void loadIssues();
  rerenderEmpty();
  updateStatus();
  persist();
  return true;
}

// ---------- Línea de comandos: `pulso archivo`, `pulso carpeta`, `pulso -g archivo:línea` ----------
async function applyCliTargets(targets: CliTarget[]) {
  if (!targets.length) return;
  const plan = planCliOpen(targets, ws.root);
  if (plan.folder && !(await openWorkspace(plan.folder))) return;
  for (const f of plan.files) await openFile(f.path, { line: f.line, col: f.col });
  if (plan.missing.length) setStatus(`No existe: ${plan.missing.join(", ")}`, 8000);
}

async function installCliCommand() {
  try { setStatus(await invoke<string>("install_cli_command"), 10000); }
  catch (e) { setStatus(`No se pudo instalar el comando pulso: ${e}`, 10000); }
}

async function closeWorkspace() {
  if (!(await closeAllTabs())) return;
  ws.root = null;
  if (inTauri) {
    setLspWorkspace(null);
    await invoke("set_workspace_root", { path: null }).catch(() => {});
  }
  resetExplorer();
  resetHistory();
  resetPrs();
  resetRepoChat();
  await refreshTree();
  setDefaultStatus("Listo");
  setStatus("Carpeta cerrada");
  void loadIssues();
  rerenderEmpty();
  clearSession();
  clearLastRoot();
  updateStatus();
}

async function pickFolder() {
  if (!inTauri) { setStatus("Abrir carpeta solo funciona en la ventana de Pulso Editor (npx tauri dev)."); return; }
  try {
    const dir = await open({ directory: true });
    if (typeof dir === "string") await openWorkspace(dir);
  } catch (e) {
    setStatus(`No se pudo abrir la carpeta: ${e}`);
  }
}

// ---------- Barra de estado y título ----------
function updateStatus() {
  const g = getFocused();
  const path = g?.active;
  const d = path ? docs.get(path) : undefined;
  const ed = g?.editor;
  const pos = ed?.getPosition();
  const selection = ed?.getSelection();
  const chars = d && selection && !selection.isEmpty() ? d.model.getValueInRange(selection).length : 0;
  $("status-pos").textContent = d && pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${chars ? ` (${chars} seleccionados)` : ""}` : "";
  $("status-indent").textContent = d ? `Espacios: ${d.model.getOptions().tabSize}` : "";
  $("status-lang").textContent = d ? d.model.getLanguageId() : "";
  $("status-eol").textContent = d ? (d.model.getEOL() === "\r\n" ? "CRLF" : "LF") : "";
  $("status-enc").textContent = d ? "UTF-8" : "";
  $("status-wrap").textContent = d ? (state.settings.wordWrap ? "Ajuste: sí" : "Ajuste: no") : "";
  const title = [path ? baseName(path) : "", ws.root ? baseName(ws.root) : "", "Pulso Editor"].filter(Boolean).join(" — ");
  document.title = title;
  setTitleLabel(ws.root ? baseName(ws.root) : "Pulso");
  setUnsaved(dirtyDocs().length);
  if (inTauri) void getCurrentWindow().setTitle(title).catch(() => {});
}

function paintLsp() {
  const s = getLspState();
  const el = $("status-lsp");
  el.textContent = lspLabel(s);
  el.hidden = s.kind === "off";
  el.dataset.state = s.kind;
}
onLspState(paintLsp);
paintLsp();
$("status-lsp").onclick = async () => {
  const s = getLspState();
  const r = await showDialog({
    title: "Servidor de lenguaje",
    message: lspDetail(s),
    buttons: [{ label: "Cerrar", value: "close" }, ...(ws.root ? [{ label: "Reiniciar", value: "restart" }] : [])],
  });
  if (r === "restart" && ws.root) setLspWorkspace(ws.root);
};
$("status-wrap").onclick = () => commands.find((c) => c.id === "pref.wrap")?.run();
$("status-eol").onclick = () => {
  const p = activePath();
  const d = p ? docs.get(p) : undefined;
  if (!d) return;
  d.model.pushEOL(d.model.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
  updateStatus();
};

// Historial de navegación: las flechas de la barra de título van atrás y adelante entre archivos y posiciones.
const nav = createNav(async ({ path, line }) => { await openFile(path, { line, col: 1 }); });
nav.onChange(() => setNavState(nav.canBack(), nav.canForward()));

let lastActive: string | null = null;
onGroupsChange(() => {
  updateStatus();
  persist();
  const p = activePath();
  if (p !== lastActive) { lastActive = p; highlight(p); closeSettings(); }
  const pos = getFocused()?.editor.getPosition();
  if (p && pos) nav.record({ path: p, line: pos.lineNumber });
});

// ---------- Pantalla de bienvenida ----------
const kbdRow = (label: string, id: string) => {
  const c = commands.find((x) => x.id === id);
  const li = h("li");
  li.append(h("span", "", label));
  for (const part of (c ? keyOf(c) : "").split("+").filter(Boolean)) li.append(h("kbd", "", part));
  return li;
};

config.renderEmpty = (el, full) => {
  if (!full) {
    el.append(h("div", "gempty-small", "Grupo vacío. Arrastra una pestaña aquí o abre un archivo con Ctrl+P."));
    return;
  }
  const wrap = h("div", "welcome");
  const logo = h("img", "wlogo");
  logo.src = "/logo.png";
  logo.alt = "Pulso";
  logo.draggable = false;
  wrap.append(logo, h("h1", "", "Pulso"), h("p", "tagline", "Editor de código con issues, tableros y repos integrados."));
  const list = h("ul", "shortcuts");
  list.append(
    kbdRow("Abrir carpeta", "file.openFolder"),
    kbdRow("Abrir archivo", "palette.files"),
    kbdRow("Paleta de comandos", "palette.commands"),
    kbdRow("Buscar en archivos", "view.search"),
    kbdRow("Dividir el editor", "layout.split"),
    kbdRow("Configuración", "view.settings"),
  );
  wrap.append(list);
  const recent = getRecent().filter((p) => p !== ws.root).slice(0, 5);
  if (recent.length) {
    wrap.append(h("h2", "", "Recientes"));
    const rl = h("ul", "recent");
    for (const p of recent) {
      const li = h("li");
      li.append(h("span", "r-name", baseName(p)), h("span", "r-dir", dirName(p)));
      li.onclick = () => void openWorkspace(p);
      rl.append(li);
    }
    wrap.append(rl);
  }
  el.append(wrap);
};

// ---------- Selectores rápidos ----------
function quickOpenFiles() {
  if (!ws.root) { setStatus("Abre una carpeta primero"); return; }
  quickPick({
    placeholder: "Buscar archivo por nombre…",
    load: async () => {
      const files = await invoke<string[]>("list_files", { path: ws.root });
      return files
        .map((p) => ({ p, r: rel(p) }))
        .sort((a, b) => a.r.localeCompare(b.r))
        .map<PickItem>(({ p, r }) => ({
          label: baseName(p),
          detail: dirName(r),
          icon: fileIcon(baseName(p)),
          run: () => openFile(p),
        }));
    },
  });
}

function openPalette() {
  quickPick({
    placeholder: "Escribe un comando…",
    load: () => {
      const items: PickItem[] = commands.map((c) => ({ label: c.label, hint: keyOf(c), keywords: c.keywords, run: c.run }));
      const ed = focusedEditor();
      if (ed) {
        for (const a of ed.getSupportedActions()) {
          if (!a.isSupported()) continue;
          items.push({ label: `Editor: ${a.label}`, run: () => { ed.focus(); return a.run(); } });
        }
      }
      return items;
    },
  });
}

function pickSyntax() {
  quickPick({
    placeholder: "Colores del código…",
    load: () => [["auto", "Los del tema"], ...syntaxOptionsFor(state.settings.theme)].map<PickItem>(([id, label]) => ({
      label,
      detail: id === state.settings.syntaxTheme ? "actual" : "",
      run: () => { state.settings.syntaxTheme = id; commit(); syncSettingsUI(); },
    })),
  });
}

function pickRecent() {
  quickPick({
    placeholder: "Abrir carpeta reciente…",
    empty: "Aún no hay carpetas recientes",
    load: () => getRecent().map<PickItem>((p) => ({ label: baseName(p), detail: dirName(p), run: () => void openWorkspace(p) })),
  });
}

// ---------- Comandos y atajos ----------
type BoolKey = "minimap" | "wordWrap" | "lineNumbers" | "whitespace" | "ligatures" | "autoSave" | "formatOnSave";
const toggle = (key: BoolKey, name: string) => () => {
  state.settings[key] = !state.settings[key];
  commit();
  syncSettingsUI();
  setStatus(`${name}: ${state.settings[key] ? "activado" : "desactivado"}`);
};
const zoom = (delta: number) => () => {
  state.settings.fontSize = delta === 0 ? 14 : Math.min(32, Math.max(9, state.settings.fontSize + delta));
  commit();
  syncSettingsUI();
};
/** Ejecuta en la terminal el texto seleccionado (o la línea actual si no hay selección). */
function runSelectionInTerminal() {
  const ed = focusedEditor();
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel) { setStatus("Abre un archivo y selecciona lo que quieras ejecutar"); return; }
  const text = sel.isEmpty() ? model.getLineContent(sel.startLineNumber) : model.getValueInRange(sel);
  if (text.trim()) void runInTerminal(text);
}

function terminalHere() {
  const p = activePath();
  void newTerminal(p ? { cwd: dirName(p) } : {});
}

async function toggleFullscreen() {
  if (!inTauri) return;
  const w = getCurrentWindow();
  await w.setFullscreen(!(await w.isFullscreen()));
}
const selectionText = () => {
  const ed = focusedEditor();
  const s = ed?.getSelection();
  const m = ed?.getModel();
  return s && m && !s.isEmpty() && s.startLineNumber === s.endLineNumber ? m.getValueInRange(s) : "";
};

register(
  { id: "file.openFolder", label: "Archivo: Abrir carpeta…", key: "Ctrl+O", run: pickFolder },
  { id: "cli.install", label: "Instalar el comando «pulso» en la terminal", run: installCliCommand },
  { id: "app.checkUpdates", label: "Ayuda: Buscar actualizaciones", keywords: "update actualizar versión nueva", run: () => checkForUpdates(true) },
  { id: "file.openRecent", label: "Archivo: Abrir carpeta reciente…", run: pickRecent },
  { id: "file.closeFolder", label: "Archivo: Cerrar carpeta", run: closeWorkspace },
  { id: "file.newFile", label: "Archivo: Nuevo archivo…", key: "Ctrl+N", run: () => newEntry("file") },
  { id: "file.newFolder", label: "Archivo: Nueva carpeta…", run: () => newEntry("folder") },
  { id: "file.save", label: "Archivo: Guardar", key: "Ctrl+S", run: saveActive },
  { id: "file.saveAll", label: "Archivo: Guardar todo", key: "Ctrl+Shift+S", run: () => void saveAll() },
  { id: "file.reveal", label: "Archivo: Mostrar el archivo activo en el explorador", run: () => { const p = activePath(); if (p) { showView("explorer"); void revealInTree(p); } } },

  { id: "tab.close", label: "Pestaña: Cerrar", key: "Ctrl+W", run: () => void closeActive() },
  { id: "tab.closeOthers", label: "Pestaña: Cerrar las demás", run: () => void closeOthers() },
  { id: "tab.closeAll", label: "Pestaña: Cerrar todas las del grupo", run: () => void closeAllInGroup() },
  { id: "tab.reopen", label: "Pestaña: Reabrir la última cerrada", key: "Ctrl+Shift+T", run: () => void reopenClosed() },
  { id: "nav.back", label: "Ir: Atrás", key: "Alt+ArrowLeft", keywords: "back atrás historial", run: () => void nav.back() },
  { id: "nav.forward", label: "Ir: Adelante", key: "Alt+ArrowRight", keywords: "forward adelante historial", run: () => void nav.forward() },
  { id: "tab.next", label: "Pestaña: Siguiente", key: "Ctrl+Tab", run: () => nextTab(1) },
  { id: "tab.prev", label: "Pestaña: Anterior", key: "Ctrl+Shift+Tab", run: () => nextTab(-1) },
  { id: "tab.pin", label: "Pestaña: Fijar o desfijar", run: () => { const g = getFocused(); if (g.active) togglePin(g, g.active); } },

  { id: "layout.split", label: "Diseño: Dividir el editor", key: "Ctrl+Shift+D", run: () => { splitGroup()?.editor.focus(); } },
  { id: "layout.orientation", label: "Diseño: Cambiar orientación (lado a lado / apilado)", run: toggleDirection },
  { id: "layout.closeGroup", label: "Diseño: Cerrar el grupo de editores", run: () => void closeGroup(getFocused()) },
  { id: "layout.moveTab", label: "Diseño: Mover la pestaña al otro grupo", key: "Ctrl+Alt+ArrowRight", run: moveToNextGroup },
  { id: "layout.focus1", label: "Diseño: Ir al grupo 1", key: "Ctrl+1", run: () => focusGroup(0) },
  { id: "layout.focus2", label: "Diseño: Ir al grupo 2", key: "Ctrl+2", run: () => focusGroup(1) },
  { id: "layout.focus3", label: "Diseño: Ir al grupo 3", key: "Ctrl+3", run: () => focusGroup(2) },
  { id: "layout.focus4", label: "Diseño: Ir al grupo 4", key: "Ctrl+4", run: () => focusGroup(3) },

  { id: "view.sidebar", label: "Ver: Mostrar u ocultar la barra lateral", key: "Ctrl+B", run: () => { $("app").classList.toggle("no-sidebar"); } },
  { id: "view.activityCustomize", label: "Ver: Organizar botones de la barra lateral…", keywords: "barra lateral actividad iconos ordenar ocultar personalizar", run: customizeActivityBar },
  { id: "view.activityReset", label: "Ver: Restablecer botones de la barra lateral", keywords: "barra lateral actividad iconos restablecer orden", run: resetActivityBar },
  { id: "view.explorer", label: "Ver: Explorador", key: "Ctrl+Shift+E", run: () => showView("explorer") },
  { id: "view.search", label: "Ver: Buscar en archivos", key: "Ctrl+Shift+F", run: () => { showView("search"); focusSearch(selectionText()); } },
  { id: "view.git", label: "Ver: Control de código fuente (Git)", key: "Ctrl+Shift+G", keywords: "git source control commit cambios stage preparar", run: () => showView("git") },
  { id: "git.history", label: "Git: Historial de commits", keywords: "git historial log commits", run: () => { showView("git"); openHistoryTab(); } },
  { id: "git.blame", label: "Git: Alternar culpa (blame) en línea", keywords: "git blame culpa autor linea quien", run: toggleBlame },
  { id: "git.fileHistory", label: "Git: Historial del archivo activo", keywords: "git historial archivo file history log", run: () => { showView("git"); showFileHistory(); } },
  { id: "git.commit", label: "Git: Confirmar los cambios preparados (commit)", keywords: "git commit confirmar", run: () => { showView("git"); void commitStaged(); } },
  { id: "git.branch", label: "Git: Cambiar de rama o crear una nueva…", keywords: "git branch rama checkout switch crear", run: () => void pickBranch() },
  { id: "git.pull", label: "Git: Traer cambios del remoto (pull)", keywords: "git pull traer descargar", run: () => void pullChanges() },
  { id: "git.push", label: "Git: Subir commits al remoto (push)", keywords: "git push subir enviar", run: () => void pushChanges() },
  { id: "git.stageAll", label: "Git: Preparar todos los cambios", keywords: "git stage add preparar todo", run: () => void stage([]) },
  { id: "git.unstageAll", label: "Git: Quitar todo de lo preparado", keywords: "git unstage reset quitar", run: () => void unstage([]) },
  { id: "task.script", label: "Tareas: Ejecutar un script de package.json", keywords: "npm run script tarea test build dev pnpm yarn bun", run: () => void pickScript() },
  { id: "view.ai", label: "Ver: Asistente de IA", keywords: "ia ai asistente claude chat inteligencia artificial", run: () => showView("ai") },
  { id: "ai.new", label: "Asistente de IA: Nueva conversación", keywords: "ia ai claude nueva conversacion", run: () => { showView("ai"); startNewConversation(); } },
  { id: "view.prs", label: "Ver: Pull requests", keywords: "pull request pr github revisar", run: () => showView("prs") },
  { id: "git.newPull", label: "Git: Nueva pull request desde la rama actual", keywords: "pull request pr crear github", run: () => { showView("prs"); void newPull(); } },
  { id: "workflow.createPr", label: "Flujo: Crear pull request para la issue activa", keywords: "flujo issue pr pull request cerrar closes", run: () => { showView("prs"); void createPrForActiveIssue(); } },
  { id: "view.chat", label: "Ver: Chat del equipo", keywords: "chat mensajes equipo conversacion", run: () => showView("chat") },
  { id: "view.problems", label: "Ver: Problemas (errores y avisos)", key: "Ctrl+Shift+M", keywords: "problems errores avisos diagnosticos", run: () => showView("problems") },
  { id: "view.issues", label: "Ver: Issues de GitHub", key: "Ctrl+Shift+I", run: () => showView("issues") },
  { id: "view.board", label: "Issues: Abrir el tablero kanban", keywords: "kanban tablero board issues github", run: () => void openBoard() },
  { id: "view.settings", label: "Ver: Configuración", key: "Ctrl+,", run: () => showView("settings") },
  { id: "view.zoomIn", label: "Ver: Aumentar la fuente", key: "Ctrl+=", run: zoom(1) },
  { id: "view.zoomOut", label: "Ver: Reducir la fuente", key: "Ctrl+-", run: zoom(-1) },
  { id: "view.zoomReset", label: "Ver: Restablecer el tamaño de fuente", key: "Ctrl+0", run: zoom(0) },

  { id: "view.fullscreen", label: "Ver: Pantalla completa", key: "F11", run: toggleFullscreen },
  { id: "terminal.toggle", label: "Terminal: Mostrar u ocultar", key: "Ctrl+J", keywords: "terminal consola shell cmd powershell", run: () => void toggleTerminal() },
  { id: "terminal.new", label: "Terminal: Nueva terminal", key: "Ctrl+Shift+J", keywords: "terminal consola shell", run: () => void newTerminal() },
  { id: "terminal.adapt", label: "Terminal: Adaptar a mi terminal (VS Code / Windows Terminal)…", keywords: "terminal adaptar fuente colores esquema tema", run: () => void adaptToMyTerminal() },
  { id: "terminal.clear", label: "Terminal: Limpiar", keywords: "terminal clear limpiar", run: clearTerminal },
  { id: "terminal.kill", label: "Terminal: Terminar la terminal activa", keywords: "terminal kill cerrar", run: killActiveTerminal },
  { id: "terminal.runSelection", label: "Terminal: Ejecutar la selección en la terminal", keywords: "terminal run ejecutar", run: runSelectionInTerminal },
  { id: "terminal.here", label: "Terminal: Nueva terminal en la carpeta del archivo activo", keywords: "terminal carpeta aquí", run: terminalHere },
  { id: "palette.commands", label: "Paleta de comandos", key: "Ctrl+Shift+P", run: openPalette },
  { id: "palette.files", label: "Ir a un archivo…", key: "Ctrl+P", run: quickOpenFiles },
  { id: "lsp.restart", label: "Lenguaje: Reiniciar inteligencia de TypeScript y JavaScript", keywords: "lsp typescript javascript servidor lenguaje", run: () => { if (inTauri && ws.root) setLspWorkspace(ws.root); else setStatus("Abre una carpeta para iniciar el servidor de lenguaje"); } },

  { id: "pref.theme", label: "Preferencias: Tema de color…", keywords: "theme tema temas color colores apariencia", run: openThemeGallery },
  { id: "pref.syntax", label: "Preferencias: Colores del código…", keywords: "syntax sintaxis highlight colores", run: pickSyntax },
  { id: "pref.importTheme", label: "Preferencias: Importar tema de VS Code instalado…", keywords: "import vscode theme importar", run: importInstalled },
  { id: "pref.importThemeFile", label: "Preferencias: Importar archivo de tema (.json)…", run: () => void importFromFile() },
  { id: "pref.removeTheme", label: "Preferencias: Quitar un tema importado…", run: removeImported },
  { id: "pref.wrap", label: "Preferencias: Alternar ajuste de línea", key: "Alt+Z", keywords: "toggle word wrap ajuste línea envolver wrap", run: toggle("wordWrap", "Ajuste de línea") },
  { id: "pref.minimap", label: "Preferencias: Minimapa", run: toggle("minimap", "Minimapa") },
  { id: "pref.lines", label: "Preferencias: Números de línea", run: toggle("lineNumbers", "Números de línea") },
  { id: "pref.whitespace", label: "Preferencias: Mostrar espacios", run: toggle("whitespace", "Mostrar espacios") },
  { id: "pref.ligatures", label: "Preferencias: Ligaduras de fuente", run: toggle("ligatures", "Ligaduras") },
  { id: "pref.autosave", label: "Preferencias: Autoguardado", run: toggle("autoSave", "Autoguardado") },
  { id: "pref.formatonsave", label: "Preferencias: Formatear al guardar", keywords: "format formatear guardar", run: toggle("formatOnSave", "Formatear al guardar") },

  { id: "explorer.refresh", label: "Explorador: Actualizar", run: () => void refreshTree() },
  { id: "explorer.collapse", label: "Explorador: Contraer todo", run: collapseAll },
);

initKeys();

// ---------- Barra de título: menús ----------
/** Acción de Monaco sobre el editor con foco (deshacer, comentar, ir a línea…). */
const editorAction = (label: string, id: string, hint = ""): MenuEntry => ({
  label, hint,
  run: () => {
    const e = focusedEditor();
    if (!e) { setStatus("Abre un archivo para usar esta acción"); return; }
    e.focus();
    const a = e.getAction(id);
    if (a) void a.run(); else e.trigger("menu", id, null);
  },
});

const pasteEntry: MenuEntry = {
  label: "Pegar", hint: "Ctrl+V",
  run: async () => {
    const e = focusedEditor();
    if (!e) return;
    try {
      const text = await navigator.clipboard.readText();
      e.focus();
      e.trigger("menu", "type", { text });
    } catch {
      setStatus("No se pudo leer el portapapeles desde el menú; usa Ctrl+V");
    }
  },
};

const MENUS: MenuDef[] = [
  { label: "Archivo", items: [
    { cmd: "file.openFolder", label: "Abrir carpeta…" },
    { cmd: "file.openRecent", label: "Abrir carpeta reciente…" },
    { cmd: "file.closeFolder", label: "Cerrar carpeta" },
    "sep",
    { cmd: "file.newFile", label: "Nuevo archivo…" },
    { cmd: "file.newFolder", label: "Nueva carpeta…" },
    "sep",
    { cmd: "file.save", label: "Guardar" },
    { cmd: "file.saveAll", label: "Guardar todo" },
    "sep",
    { cmd: "tab.close", label: "Cerrar pestaña" },
    { cmd: "tab.reopen", label: "Reabrir la última pestaña cerrada" },
    { cmd: "tab.closeAll", label: "Cerrar todas las pestañas del grupo" },
    "sep",
    { label: "Salir", hint: "Alt+F4", run: () => { if (inTauri) void getCurrentWindow().close(); } },
  ] },
  { label: "Editar", items: [
    editorAction("Deshacer", "undo", "Ctrl+Z"),
    editorAction("Rehacer", "redo", "Ctrl+Y"),
    "sep",
    editorAction("Cortar", "editor.action.clipboardCutAction", "Ctrl+X"),
    editorAction("Copiar", "editor.action.clipboardCopyAction", "Ctrl+C"),
    pasteEntry,
    "sep",
    editorAction("Buscar", "actions.find", "Ctrl+F"),
    editorAction("Reemplazar", "editor.action.startFindReplace", "Ctrl+H"),
    { cmd: "view.search", label: "Buscar en archivos" },
    "sep",
    editorAction("Alternar comentario de línea", "editor.action.commentLine", "Ctrl+/"),
    editorAction("Formatear el documento", "editor.action.formatDocument", "Shift+Alt+F"),
  ] },
  { label: "Selección", items: [
    editorAction("Seleccionar todo", "editor.action.selectAll", "Ctrl+A"),
    editorAction("Expandir la selección", "editor.action.smartSelect.expand", "Shift+Alt+\u2192"),
    editorAction("Reducir la selección", "editor.action.smartSelect.shrink", "Shift+Alt+\u2190"),
    "sep",
    editorAction("Copiar línea arriba", "editor.action.copyLinesUpAction", "Shift+Alt+\u2191"),
    editorAction("Copiar línea abajo", "editor.action.copyLinesDownAction", "Shift+Alt+\u2193"),
    editorAction("Mover línea arriba", "editor.action.moveLinesUpAction", "Alt+\u2191"),
    editorAction("Mover línea abajo", "editor.action.moveLinesDownAction", "Alt+\u2193"),
    "sep",
    editorAction("Añadir cursor arriba", "editor.action.insertCursorAbove", "Ctrl+Alt+\u2191"),
    editorAction("Añadir cursor abajo", "editor.action.insertCursorBelow", "Ctrl+Alt+\u2193"),
    editorAction("Seleccionar todas las apariciones", "editor.action.selectHighlights", "Ctrl+Shift+L"),
  ] },
  { label: "Ver", items: [
    { cmd: "palette.commands", label: "Paleta de comandos…" },
    "sep",
    { cmd: "view.explorer", label: "Explorador" },
    { cmd: "view.search", label: "Buscar" },
    { cmd: "view.git", label: "Control de código fuente" },
    { cmd: "view.issues", label: "Issues de GitHub" },
    { cmd: "view.board", label: "Tablero kanban de issues" },
    { cmd: "view.settings", label: "Configuración" },
    "sep",
    { cmd: "layout.split", label: "Dividir el editor" },
    { cmd: "layout.orientation", label: "Cambiar la orientación de los grupos" },
    { cmd: "view.sidebar", label: "Mostrar u ocultar la barra lateral" },
    { cmd: "terminal.toggle", label: "Terminal" },
    "sep",
    { cmd: "pref.wrap", label: "Alternar ajuste de línea" },
    { cmd: "pref.minimap", label: "Minimapa" },
    { cmd: "view.zoomIn", label: "Aumentar la fuente" },
    { cmd: "view.zoomOut", label: "Reducir la fuente" },
    { cmd: "view.zoomReset", label: "Restablecer el tamaño de fuente" },
    "sep",
    { cmd: "pref.theme", label: "Tema de color…" },
    { cmd: "view.fullscreen", label: "Pantalla completa" },
  ] },
  { label: "Ir a", items: [
    { cmd: "palette.files", label: "Ir a archivo…" },
    editorAction("Ir a línea…", "editor.action.gotoLine", "Ctrl+G"),
    editorAction("Ir a símbolo del archivo…", "editor.action.quickOutline", "Ctrl+Shift+O"),
    "sep",
    editorAction("Ir a la definición", "editor.action.revealDefinition", "F12"),
    editorAction("Buscar referencias", "editor.action.goToReferences", "Shift+F12"),
    "sep",
    { cmd: "nav.back", label: "Atrás" },
    { cmd: "nav.forward", label: "Adelante" },
    "sep",
    { cmd: "tab.next", label: "Pestaña siguiente" },
    { cmd: "tab.prev", label: "Pestaña anterior" },
    { cmd: "layout.focus1", label: "Grupo de editores 1" },
    { cmd: "layout.focus2", label: "Grupo de editores 2" },
  ] },
  { label: "Terminal", items: [
    { cmd: "terminal.new", label: "Nueva terminal" },
    { cmd: "terminal.toggle", label: "Mostrar u ocultar la terminal" },
    "sep",
    { cmd: "terminal.here", label: "Nueva terminal en la carpeta del archivo" },
    { cmd: "terminal.runSelection", label: "Ejecutar la selección en la terminal" },
    "sep",
    { cmd: "terminal.clear", label: "Limpiar la terminal" },
    { cmd: "terminal.kill", label: "Terminar la terminal activa" },
  ] },
  { label: "Ayuda", items: [
    { cmd: "palette.commands", label: "Mostrar todos los comandos" },
    { cmd: "view.settings", label: "Configuración y atajos de teclado" },
    { cmd: "app.checkUpdates", label: "Buscar actualizaciones" },
    "sep",
    { label: "Acerca de Pulso", run: async () => { const version = inTauri ? await getVersion().catch(() => "") : ""; void showDialog({
      title: "Pulso Editor",
      message: `Versión ${version || "desconocida"}\n\nEditor de código con issues, tableros y repos integrados.\nHecho con Tauri 2 y Monaco Editor.`,
      buttons: [{ label: "Cerrar", value: "ok", primary: true }],
    }); } },
  ] },
];

initTitlebar({
  menus: MENUS,
  onTitleClick: () => { void commands.find((c) => c.id === (ws.root ? "palette.files" : "palette.commands"))?.run(); },
  onBack: () => void nav.back(),
  onForward: () => void nav.forward(),
});
setNavState(nav.canBack(), nav.canForward());

// ---------- Inicio ----------
let lastTheme = state.settings.theme;
onSettingsChange(() => {
  applySettingsToEditors();
  updateStatus();
  applyTerminalSettings();
  rerenderEmpty();
  if (state.settings.theme !== lastTheme) {
    lastTheme = state.settings.theme;
    rerenderGroups();
    if (ws.root) void refreshTree();
  }
});

let treeTimer = 0;
onDocSaved(() => {
  beat();
  clearTimeout(treeTimer);
  treeTimer = window.setTimeout(() => { if (ws.root) void refreshGitDecorations(); }, 1500);
});

const BRANCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/></svg>';
function paintBranch(info: GitInfo | null) {
  const el = $("status-branch");
  el.hidden = !info;
  if (!info) return;
  el.innerHTML = BRANCH_ICON;
  el.append(`${info.branch}${info.dirty ? "*" : ""}${info.ahead ? ` ↑${info.ahead}` : ""}${info.behind ? ` ↓${info.behind}` : ""}`);
  el.title = info.dirty ? "Hay cambios sin confirmar" : "Sin cambios pendientes";
}
onGitChange(paintBranch);
$("status-branch").onclick = () => void pickBranch();
$("statusbar").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLElement && e.target.classList.contains("clickable")) {
    e.preventDefault();
    e.target.click();
  }
});
paintBranch(gitInfo());

initLsp();
initGroups();
initExplorer({
  onOpenFolder: pickFolder,
  onSearchIn: (path) => { showView("search"); searchInFolder(path); },
  onOpenTerminal: (dir) => void newTerminal({ cwd: dir }),
});
initSearch();
initTerminal();
initIssues();
initScm();
initHistory();
initBlame();
initPrs();
initAi();
bus.on("issue-workflow-start", () => showView("ai"));
initProblems(() => showView("problems"));
initSettingsPage(() => void loadIssues());
syncSettingsUI();
commit();
updateStatus();

document.addEventListener("contextmenu", (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });

window.addEventListener("blur", flushBackups);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushBackups(); });

window.addEventListener("focus", () => {
  if (!ws.root) return;
  void checkExternal();
  void refreshTree();
});

if (inTauri) {
  void getCurrentWindow().onCloseRequested(async (event) => {
    persister.flush();
    const dirty = dirtyDocs();
    if (!dirty.length) return;
    event.preventDefault();
    const r = await showDialog({
      title: "Hay cambios sin guardar",
      message: dirty.map((d) => `• ${baseName(d.path)}`).slice(0, 8).join("\n") + (dirty.length > 8 ? `\n… y ${dirty.length - 8} más` : ""),
      buttons: [
        { label: "Cancelar", value: "cancel" },
        { label: "Salir sin guardar", value: "discard", danger: true },
        { label: "Guardar todo y salir", value: "save", primary: true },
      ],
    });
    if (r === "cancel") return;
    if (r === "save") for (const d of dirty) if (!(await saveDoc(d))) return;
    if (r === "discard") await discardDirtyBackups();
    persister.flush();
    await getCurrentWindow().destroy();
  });
}

void (async () => {
  try {
    await loadIconManifest();
    await initToken();
    void autoConnect().then((login) => { if (login) setStatus(`Conectado a GitHub como ${login} (con la sesión de Git de este equipo)`, 6000); });
    syncSettingsUI();
    rerenderGroups();
    if (!inTauri) return;
    // Sin sesión guardada se reabre la última carpeta usada, como hacen los editores habituales.
    const cliTargets = await invoke<CliTarget[]>("cli_startup_targets").catch(() => [] as CliTarget[]);
    const root = cliTargets.some((t) => t.kind === "dir") ? null : startupSession?.root ?? startupLastRoot;
    if (root) {
      const ok = await openWorkspace(root, startupSession?.root ? (startupSession.layout as Layout) : null);
      if (!ok) { clearSession(); clearLastRoot(); }
    }
    // El aviso de recuperación espera una respuesta: la pantalla de carga debe retirarse antes,
    // o quedaría tapándolo hasta el límite de 12 s.
    persister.markReady();
    revealApp();
    // Si se vuelve a lanzar `pulso ...`, la instancia única nos manda las rutas por aquí.
    await listen<CliTarget[]>("cli-open", (e) => void applyCliTargets(e.payload));
    await applyCliTargets(cliTargets);
    await offerRecovery(openFile);
    // Antes de instalar una versión nueva (Pulso se cierra): guardar lo pendiente o no instalar.
    initUpdates(async () => {
      for (const d of dirtyDocs()) if (!(await saveDoc(d))) return false;
      persister.flush();
      return true;
    });
  } finally {
    persister.markReady();
    revealApp();
  }
})();

