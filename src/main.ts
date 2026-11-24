import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { lang, t, translateStatic } from "./i18n";
import { connectProvider } from "./ai/providers";
import { showAgentConfig, trustProject } from "./ai/agentConfig";
import { showAgentMemory } from "./ai/memory";
import { showPermissionRules } from "./ai/permissions";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates, initUpdates } from "./updates";
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
  activePath, applySettingsToEditors, clearClosedTabs, closeActive, closeAllInGroup, closeAllTabs, closeGroup, closeOthers, config,
  focusGroup, focusedEditor, getFocused, initGroups, moveToNextGroup, nextTab, onGroupsChange, openFile,
  reopenClosed, rerenderEmpty, rerenderGroups, restore, saveActive, saveAll, serialize, splitGroup, toggleDirection, togglePin,
  type Layout,
} from "./groups";
import { fileIcon, loadIconManifest } from "./icons";
import { closeBoard, openBoard } from "./board";
import { closeDiff } from "./diffView";
import { closePreview, openPreviewFor } from "./preview";
import { isOnboardingDone, openOnboarding, shouldShowOnboarding } from "./onboarding";
import { initIssues, loadIssues } from "./issues";
import { initProblems, resetProjectProblems, runProjectProblemsCheck, setProblemsVisible } from "./problems";
import { initTestsView, resetTestsView, runAllTests, setTestsVisible } from "./testsView";
import { initDebug, setDebugVisible, startOrContinueDebug, stepIntoDebug, stepOutDebug, stepOverDebug, stopDebug, toggleCurrentBreakpoint } from "./debugView";
import { initConflictHelper } from "./conflictHelper";
import { initInlineCompletions, resetInlineAiBackoff } from "./inlineCompletion";
import { pickScript } from "./scripts";
import { initHistory, openHistoryTab, resetHistory, showFileHistory } from "./history";
import { initBlame, toggleBlame } from "./blame";
import { initPrs, newPull, resetPrs, setPrsVisible } from "./prs";
import { hasRunningAiForWorkspace, initAi, resetAi, setAiVisible, startNewConversation, stopRunningAiForWorkspace } from "./aiChat";
import { customizeActivityBar, initActivityBar, resetActivityBar } from "./activityBar";
import { resetRepoChat, setChatVisible } from "./repoChat";
import { initLsp, setLspWorkspace } from "./lsp";
import { getLspState, lspDetail, lspLabel, onLspState } from "./lspState";
import { amendLastCommit, commitStaged, deleteBranch, initScm, pickBranch, pullChanges, pushChanges, refreshScm, renameBranch, resetScm, stage, unstage } from "./scm";
import { focusSearch, initSearch, resetSearch, searchInFolder } from "./search";
import { allThemes, applyTheme, commit, onSettingsChange, setTheme, state, syntaxOptionsFor } from "./settings";
import { adaptToMyTerminal, applyTerminalSettings, clearTerminal, initTerminal, killActiveTerminal, newTerminal, runInTerminal, toggleTerminal } from "./terminal";
import { openThemeGallery } from "./themeGallery";
import { createNav } from "./nav";
import { beat, initTitlebar, setNavState, setTitleLabel, setUnsaved, type MenuDef, type MenuEntry } from "./titlebar";
import { importFromFile, importInstalled, removeImported } from "./themeImport";
import { closeSettings, initSettingsPage, openSettings, syncSettingsUI, toggleSettings } from "./settingsPage";
import { hooks, quickPick, setDefaultStatus, setStatus, showDialog, type PickItem } from "./ui";
import { $, baseName, dirName, h, norm } from "./util";
import { addRecent, clearLastRoot, clearSession, createSessionPersister, getLastRoot, getRecent, loadProjectLayout, loadSession, rel, removeRecent, saveProjectLayout, saveSession, setLastRoot, ws } from "./workspace";

// Los textos fijos de index.html, en el idioma elegido, antes de que nada se pinte encima.
translateStatic(document.body);
// Los mensajes que nacen en Rust (errores de archivos, Git, terminal…) siguen el mismo idioma.
if ("__TAURI_INTERNALS__" in window) void invoke("i18n_set_lang", { lang: lang() }).catch(() => {});

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
    // TypeScript/JavaScript usan el servidor LSP nativo de Pulso (evita cargar los ~6 MB de ts.worker).
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html") return new htmlWorker();
    return new editorWorker();
  },
};

// La validación de TypeScript/JavaScript corre en el servidor LSP propio de Pulso.
const ts = monaco.languages.typescript;
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.setEagerModelSync(false);
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
}

const inTauri = "__TAURI_INTERNALS__" in window;
hooks.focusEditor = () => focusedEditor()?.focus();

// ---------- Vistas de la barra lateral ----------
type View = "explorer" | "search" | "git" | "issues" | "problems" | "tests" | "debug" | "chat" | "prs" | "ai";
let currentView: View = "explorer";

function showView(view: View | "settings") {
  if (view === "settings") { toggleSettings(); return; }
  closeSettings();
  const app = $("app");
  if (view === currentView && !app.classList.contains("no-sidebar")) { app.classList.add("no-sidebar"); setProblemsVisible(false); setTestsVisible(false); setDebugVisible(false); setChatVisible(false); setPrsVisible(false); setAiVisible(false); return; }
  app.classList.remove("no-sidebar");
  currentView = view;
  document.querySelectorAll<HTMLElement>(".act[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  for (const v of ["explorer", "search", "git", "issues", "problems", "tests", "debug", "chat", "prs", "ai"] as View[]) $(`view-${v}`).hidden = v !== view;
  setProblemsVisible(view === "problems");
  setTestsVisible(view === "tests");
  setDebugVisible(view === "debug");
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
const isMainWindow = () => !inTauri || getCurrentWindow().label === "main";
const persister = createSessionPersister(() => {
  const layout = serialize();
  if (ws.root) saveProjectLayout(ws.root, layout);
  if (isMainWindow()) saveSession({ root: ws.root, layout });
});
const persist = () => persister.schedule();

async function confirmLeaveRunningAi(closing: boolean): Promise<boolean> {
  if (!ws.root || !hasRunningAiForWorkspace(ws.root)) return true;
  const r = await showDialog({
    title: t("El asistente de IA sigue respondiendo"),
    message: closing
      ? t("Hay una conversación de IA en curso en «{folder}». ¿Qué quieres hacer antes de cerrar la carpeta?", { folder: baseName(ws.root) })
      : t("Hay una conversación de IA en curso en «{folder}». ¿Qué quieres hacer antes de cambiar de proyecto?", { folder: baseName(ws.root) }),
    buttons: [
      { label: t("Cancelar"), value: "cancel" },
      { label: t("Detener y continuar"), value: "stop", danger: true },
      { label: t("Dejar en segundo plano"), value: "bg", primary: true },
    ],
  });
  if (r === "cancel") return false;
  if (r === "stop") await stopRunningAiForWorkspace(ws.root);
  return true;
}

async function openWorkspace(raw: string, layout?: Layout | null): Promise<boolean> {
  const path = norm(raw).replace(/\/+$/, "");
  const changedWorkspace = ws.root !== path;
  if (changedWorkspace) {
    if (!(await confirmLeaveRunningAi(false))) return false;
    if (ws.root) saveProjectLayout(ws.root, serialize());
    if (!(await closeAllTabs())) return false;
  }
  try {
    if (inTauri) await invoke("set_workspace_root", { path });
    await invoke("list_dir", { path });
  } catch (e) {
    if (inTauri) await invoke("set_workspace_root", { path: ws.root }).catch(() => {});
    setStatus(t("No se pudo abrir la carpeta: {error}", { error: String(e) }));
    removeRecent(path);
    return false;
  }
  ws.root = path;
  if (inTauri && changedWorkspace) setLspWorkspace(path);
  if (isMainWindow()) setLastRoot(path);
  addRecent(path);
  resetExplorer();
  if (changedWorkspace) {
    resetSearch();
    resetScm();
    resetHistory();
    resetPrs();
    resetProjectProblems();
    resetTestsView();
    resetRepoChat();
    resetAi();
    closeBoard();
    closeDiff();
    closePreview();
    nav.reset();
    clearClosedTabs();
  }
  $("tree-empty").hidden = true;
  const fn = $("folder-name");
  fn.textContent = baseName(path);
  fn.classList.add("on");
  setDefaultStatus(path);
  await refreshTree();
  const nextLayout = layout !== undefined ? layout : (loadProjectLayout(path) as Layout | null);
  if (nextLayout) await restore(nextLayout);
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
  if (plan.missing.length) setStatus(t("No existe: {paths}", { paths: plan.missing.join(", ") }), 8000);
}

async function installCliCommand() {
  try { setStatus(await invoke<string>("install_cli_command"), 10000); }
  catch (e) { setStatus(t("No se pudo instalar el comando pulso: {error}", { error: String(e) }), 10000); }
}

async function closeWorkspace() {
  if (!(await confirmLeaveRunningAi(true))) return;
  if (ws.root) saveProjectLayout(ws.root, serialize());
  if (!(await closeAllTabs())) return;
  ws.root = null;
  if (inTauri) {
    setLspWorkspace(null);
    await invoke("set_workspace_root", { path: null }).catch(() => {});
  }
  resetExplorer();
  resetSearch();
  resetScm();
  resetHistory();
  resetPrs();
  resetProjectProblems();
  resetTestsView();
  resetRepoChat();
  resetAi();
  closeBoard();
  closeDiff();
  closePreview();
  nav.reset();
  clearClosedTabs();
  await refreshTree();
  setDefaultStatus(t("Listo"));
  setStatus(t("Carpeta cerrada"));
  void loadIssues();
  rerenderEmpty();
  clearSession();
  clearLastRoot();
  updateStatus();
}

async function pickFolder() {
  if (!inTauri) { setStatus(t("Abrir carpeta solo funciona en la ventana de Pulso Editor (npx tauri dev).")); return; }
  try {
    const dir = await invoke<string | null>("pick_workspace_folder");
    if (typeof dir === "string") await openWorkspace(dir);
  } catch (e) {
    setStatus(t("No se pudo abrir la carpeta: {error}", { error: String(e) }));
  }
}

async function pickFolderNewWindow() {
  if (!inTauri) { setStatus(t("Abrir carpeta solo funciona en la ventana de Pulso Editor (npx tauri dev).")); return; }
  try {
    const dir = await invoke<string | null>("pick_workspace_folder");
    if (typeof dir === "string") await invoke("open_new_window", { path: dir });
  } catch (e) {
    setStatus(t("No se pudo abrir la nueva ventana: {error}", { error: String(e) }));
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
  $("status-pos").textContent = d && pos ? t("Ln {line}, Col {col}", { line: pos.lineNumber, col: pos.column }) + (chars ? " " + t("({count} seleccionados)", { count: chars }) : "") : "";
  $("status-indent").textContent = d ? t("Espacios: {size}", { size: d.model.getOptions().tabSize }) : "";
  $("status-lang").textContent = d ? d.model.getLanguageId() : "";
  $("status-eol").textContent = d ? (d.model.getEOL() === "\r\n" ? "CRLF" : "LF") : "";
  $("status-enc").textContent = d ? "UTF-8" : "";
  $("status-wrap").textContent = d ? (state.settings.wordWrap ? t("Ajuste: sí") : t("Ajuste: no")) : "";
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
    title: t("Servidor de lenguaje"),
    message: lspDetail(s),
    buttons: [{ label: t("Cerrar"), value: "close" }, ...(ws.root ? [{ label: t("Reiniciar"), value: "restart" }] : [])],
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
    el.append(h("div", "gempty-small", t("Grupo vacío. Arrastra una pestaña aquí o abre un archivo con Ctrl+P.")));
    return;
  }
  const wrap = h("div", "welcome");
  const logo = h("img", "wlogo");
  logo.src = "/logo.png";
  logo.alt = "Pulso";
  logo.draggable = false;
  wrap.append(logo, h("h1", "", "Pulso"), h("p", "tagline", t("Editor de código con issues, tableros y repos integrados.")));
  const list = h("ul", "shortcuts");
  list.append(
    kbdRow(t("Abrir carpeta"), "file.openFolder"),
    kbdRow(t("Abrir archivo"), "palette.files"),
    kbdRow(t("Paleta de comandos"), "palette.commands"),
    kbdRow(t("Buscar en archivos"), "view.search"),
    kbdRow(t("Dividir el editor"), "layout.split"),
    kbdRow(t("Configuración"), "view.settings"),
  );
  wrap.append(list);
  const recent = getRecent().filter((p) => p !== ws.root).slice(0, 5);
  if (recent.length) {
    wrap.append(h("h2", "", t("Recientes")));
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
  if (!ws.root) { setStatus(t("Abre una carpeta primero")); return; }
  quickPick({
    placeholder: t("Buscar archivo por nombre…"),
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
    placeholder: t("Escribe un comando…"),
    load: () => {
      const items: PickItem[] = commands.map((c) => ({ label: c.label, hint: keyOf(c), keywords: c.keywords, run: c.run }));
      const ed = focusedEditor();
      if (ed) {
        for (const a of ed.getSupportedActions()) {
          if (!a.isSupported()) continue;
          items.push({ label: t("Editor: {action}", { action: a.label }), run: () => { ed.focus(); return a.run(); } });
        }
      }
      return items;
    },
  });
}

function pickSyntax() {
  quickPick({
    placeholder: t("Colores del código…"),
    load: () => [["auto", t("Los del tema")], ...syntaxOptionsFor(state.settings.theme)].map<PickItem>(([id, label]) => ({
      label,
      detail: id === state.settings.syntaxTheme ? "actual" : "",
      run: () => { state.settings.syntaxTheme = id; commit(); syncSettingsUI(); },
    })),
  });
}

function pickRecent() {
  quickPick({
    placeholder: t("Abrir carpeta reciente…"),
    empty: t("Aún no hay carpetas recientes"),
    load: () => getRecent().map<PickItem>((p) => ({ label: baseName(p), detail: dirName(p), run: () => void openWorkspace(p) })),
  });
}

// ---------- Comandos y atajos ----------
type BoolKey = "minimap" | "wordWrap" | "lineNumbers" | "whitespace" | "ligatures" | "autoSave" | "formatOnSave" | "inlineAiEnabled";
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
  if (!ed || !model || !sel) { setStatus(t("Abre un archivo y selecciona lo que quieras ejecutar")); return; }
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

async function copyDiagnostics() {
  try {
    const s = getLspState();
    const lsp = `${s.kind} (${lspLabel(s)})`;
    const report = inTauri
      ? await invoke<string>("diag_collect", { lspStatus: lsp, lang: lang() })
      : `Pulso Editor (web)\nLanguage: ${lang()}\nLSP: ${lsp}\n`;
    await navigator.clipboard.writeText(report);
    setStatus(t("Información de diagnóstico copiada al portapapeles"), 4500);
  } catch (e) {
    setStatus(t("No se pudo copiar el diagnóstico: {error}", { error: String(e) }), 5000);
  }
}

register(
  { id: "file.openFolder", label: t("Archivo: Abrir carpeta…"), key: "Ctrl+O", run: pickFolder },
  { id: "file.openFolderNewWindow", label: t("Archivo: Abrir carpeta en una nueva ventana…"), run: pickFolderNewWindow },
  { id: "cli.install", label: t("Instalar el comando «pulso» en la terminal"), run: installCliCommand },
  { id: "app.checkUpdates", label: t("Ayuda: Buscar actualizaciones"), keywords: "update actualizar versión nueva", run: () => checkForUpdates(true) },
  { id: "app.copyDiagnostics", label: t("Ayuda: Copiar información de diagnóstico"), keywords: "diagnostico log soporte bug error version", run: () => void copyDiagnostics() },
  { id: "app.onboarding", label: t("Ayuda: Asistente de bienvenida"), keywords: "bienvenida inicio configurar tema idioma github onboarding", run: () => openOnboarding({ onOpenFolder: pickFolder }) },
  { id: "ai.permissionRules", label: t("IA: Comandos permitidos para este proyecto…"), keywords: "ai ia permisos comandos reglas permitir aprobar approve permissions", run: showPermissionRules },
  { id: "ai.agentConfig", label: t("IA: Ver instrucciones, skills y agentes del proyecto…"), keywords: "ai ia agente skills subagentes instrucciones agents.md claude.md comandos", run: showAgentConfig },
  { id: "ai.memory", label: t("IA: Memoria del agente en este proyecto…"), keywords: "ai ia agente memoria notas recuerda", run: showAgentMemory },
  { id: "ai.trustProject", label: t("IA: Confiar en este proyecto…"), keywords: "ai ia confiar confianza trust proyecto agents.md", run: () => void trustProject() },
  { id: "ai.connectProvider", label: t("IA: Conectar un proveedor de modelos…"), keywords: "ai ia modelos provider proveedor api key clave openai anthropic openrouter models.dev", run: () => connectProvider() },
  { id: "file.openRecent", label: t("Archivo: Abrir carpeta reciente…"), run: pickRecent },
  { id: "file.closeFolder", label: t("Archivo: Cerrar carpeta"), run: closeWorkspace },
  { id: "file.newFile", label: t("Archivo: Nuevo archivo…"), key: "Ctrl+N", run: () => newEntry("file") },
  { id: "file.newFolder", label: t("Archivo: Nueva carpeta…"), run: () => newEntry("folder") },
  { id: "file.save", label: t("Archivo: Guardar"), key: "Ctrl+S", run: saveActive },
  { id: "file.saveAll", label: t("Archivo: Guardar todo"), key: "Ctrl+Shift+S", run: () => void saveAll() },
  { id: "file.reveal", label: t("Archivo: Mostrar el archivo activo en el explorador"), run: () => { const p = activePath(); if (p) { showView("explorer"); void revealInTree(p); } } },

  { id: "tab.close", label: t("Pestaña: Cerrar"), key: "Ctrl+W", run: () => void closeActive() },
  { id: "tab.closeOthers", label: t("Pestaña: Cerrar las demás"), run: () => void closeOthers() },
  { id: "tab.closeAll", label: t("Pestaña: Cerrar todas las del grupo"), run: () => void closeAllInGroup() },
  { id: "tab.reopen", label: t("Pestaña: Reabrir la última cerrada"), key: "Ctrl+Shift+T", run: () => void reopenClosed() },
  { id: "nav.back", label: t("Ir: Atrás"), key: "Alt+ArrowLeft", keywords: "back atrás historial", run: () => void nav.back() },
  { id: "nav.forward", label: t("Ir: Adelante"), key: "Alt+ArrowRight", keywords: "forward adelante historial", run: () => void nav.forward() },
  { id: "tab.next", label: t("Pestaña: Siguiente"), key: "Ctrl+Tab", run: () => nextTab(1) },
  { id: "tab.prev", label: t("Pestaña: Anterior"), key: "Ctrl+Shift+Tab", run: () => nextTab(-1) },
  { id: "tab.pin", label: t("Pestaña: Fijar o desfijar"), run: () => { const g = getFocused(); if (g.active) togglePin(g, g.active); } },

  { id: "layout.split", label: t("Diseño: Dividir el editor"), key: "Ctrl+Shift+D", run: () => { splitGroup()?.editor.focus(); } },
  { id: "layout.orientation", label: t("Diseño: Cambiar orientación (lado a lado / apilado)"), run: toggleDirection },
  { id: "layout.closeGroup", label: t("Diseño: Cerrar el grupo de editores"), run: () => void closeGroup(getFocused()) },
  { id: "layout.moveTab", label: t("Diseño: Mover la pestaña al otro grupo"), key: "Ctrl+Alt+ArrowRight", run: moveToNextGroup },
  { id: "layout.focus1", label: t("Diseño: Ir al grupo 1"), key: "Ctrl+1", run: () => focusGroup(0) },
  { id: "layout.focus2", label: t("Diseño: Ir al grupo 2"), key: "Ctrl+2", run: () => focusGroup(1) },
  { id: "layout.focus3", label: t("Diseño: Ir al grupo 3"), key: "Ctrl+3", run: () => focusGroup(2) },
  { id: "layout.focus4", label: t("Diseño: Ir al grupo 4"), key: "Ctrl+4", run: () => focusGroup(3) },

  { id: "view.sidebar", label: t("Ver: Mostrar u ocultar la barra lateral"), key: "Ctrl+B", run: () => { $("app").classList.toggle("no-sidebar"); } },
  { id: "view.activityCustomize", label: t("Ver: Organizar botones de la barra lateral…"), keywords: "barra lateral actividad iconos ordenar ocultar personalizar", run: customizeActivityBar },
  { id: "view.activityReset", label: t("Ver: Restablecer botones de la barra lateral"), keywords: "barra lateral actividad iconos restablecer orden", run: resetActivityBar },
  { id: "view.explorer", label: t("Ver: Explorador"), key: "Ctrl+Shift+E", run: () => showView("explorer") },
  { id: "view.search", label: t("Ver: Buscar en archivos"), key: "Ctrl+Shift+F", run: () => { showView("search"); focusSearch(selectionText()); } },
  { id: "view.git", label: t("Ver: Control de código fuente (Git)"), key: "Ctrl+Shift+G", keywords: "git source control commit cambios stage preparar", run: () => showView("git") },
  { id: "git.history", label: t("Git: Historial de commits"), keywords: "git historial log commits", run: () => { showView("git"); openHistoryTab(); } },
  { id: "git.blame", label: t("Git: Alternar culpa (blame) en línea"), keywords: "git blame culpa autor linea quien", run: toggleBlame },
  { id: "git.fileHistory", label: t("Git: Historial del archivo activo"), keywords: "git historial archivo file history log", run: () => { showView("git"); showFileHistory(); } },
  { id: "git.commit", label: t("Git: Confirmar los cambios preparados (commit)"), keywords: "git commit confirmar", run: () => { showView("git"); void commitStaged(); } },
  { id: "git.amend", label: t("Git: Corregir el último commit (amend)"), keywords: "git commit amend corregir ultimo", run: () => { showView("git"); void amendLastCommit(); } },
  { id: "git.branch", label: t("Git: Cambiar de rama o crear una nueva…"), keywords: "git branch rama checkout switch crear", run: () => void pickBranch() },
  { id: "git.renameBranch", label: t("Git: Renombrar una rama local…"), keywords: "git branch rama rename renombrar", run: () => void renameBranch() },
  { id: "git.deleteBranch", label: t("Git: Eliminar una rama local…"), keywords: "git branch rama delete eliminar borrar", run: () => void deleteBranch() },
  { id: "git.pull", label: t("Git: Traer cambios del remoto (pull)"), keywords: "git pull traer descargar", run: () => void pullChanges() },
  { id: "git.push", label: t("Git: Subir commits al remoto (push)"), keywords: "git push subir enviar", run: () => void pushChanges() },
  { id: "git.stageAll", label: t("Git: Preparar todos los cambios"), keywords: "git stage add preparar todo", run: () => void stage([]) },
  { id: "git.unstageAll", label: t("Git: Quitar todo de lo preparado"), keywords: "git unstage reset quitar", run: () => void unstage([]) },
  { id: "task.script", label: t("Tareas: Ejecutar un script de package.json"), keywords: "npm run script tarea test build dev pnpm yarn bun", run: () => void pickScript() },
  { id: "view.ai", label: t("Ver: Asistente de IA"), keywords: "ia ai asistente claude chat inteligencia artificial", run: () => showView("ai") },
  { id: "ai.new", label: t("Asistente de IA: Nueva conversación"), keywords: "ia ai claude nueva conversacion", run: () => { showView("ai"); startNewConversation(); } },
  { id: "view.prs", label: t("Ver: Pull requests"), keywords: "pull request pr github revisar", run: () => showView("prs") },
  { id: "git.newPull", label: t("Git: Nueva pull request desde la rama actual"), keywords: "pull request pr crear github", run: () => { showView("prs"); void newPull(); } },
  { id: "workflow.createPr", label: t("Flujo: Crear pull request para la issue activa"), keywords: "flujo issue pr pull request cerrar closes", run: () => { showView("prs"); void createPrForActiveIssue(); } },
  { id: "view.chat", label: t("Ver: Chat del equipo"), keywords: "chat mensajes equipo conversacion", run: () => showView("chat") },
  { id: "view.problems", label: t("Ver: Problemas (errores y avisos)"), key: "Ctrl+Shift+M", keywords: "problems errores avisos diagnosticos", run: () => showView("problems") },
  { id: "problems.project", label: t("Problemas: Analizar todo el proyecto"), keywords: "problems proyecto tsc cargo ruff diagnosticos", run: () => { showView("problems"); void runProjectProblemsCheck(); } },
  { id: "view.tests", label: t("Ver: Pruebas"), keywords: "tests pruebas vitest jest cargo pytest", run: () => showView("tests") },
  { id: "tests.runAll", label: t("Pruebas: Ejecutar todas las pruebas"), keywords: "tests pruebas correr ejecutar vitest jest cargo pytest", run: () => { showView("tests"); void runAllTests(); } },
  { id: "view.issues", label: t("Ver: Issues de GitHub"), key: "Ctrl+Shift+I", run: () => showView("issues") },
  { id: "view.board", label: t("Issues: Abrir el tablero kanban"), keywords: "kanban tablero board issues github", run: () => void openBoard() },
  { id: "view.preview", label: t("Ver: Vista previa de Markdown o imagen"), key: "Ctrl+Shift+V", keywords: "preview vista previa markdown imagen svg png", run: () => void openPreviewFor(activePath()) },
  { id: "view.settings", label: t("Ver: Configuración"), key: "Ctrl+,", run: () => showView("settings") },
  { id: "view.zoomIn", label: t("Ver: Aumentar la fuente"), key: "Ctrl+=", run: zoom(1) },
  { id: "view.zoomOut", label: t("Ver: Reducir la fuente"), key: "Ctrl+-", run: zoom(-1) },
  { id: "view.zoomReset", label: t("Ver: Restablecer el tamaño de fuente"), key: "Ctrl+0", run: zoom(0) },

  { id: "view.fullscreen", label: t("Ver: Pantalla completa"), key: "F11", run: toggleFullscreen },
  { id: "terminal.toggle", label: t("Terminal: Mostrar u ocultar"), key: "Ctrl+J", keywords: "terminal consola shell cmd powershell", run: () => void toggleTerminal() },
  { id: "terminal.new", label: t("Terminal: Nueva terminal"), key: "Ctrl+Shift+J", keywords: "terminal consola shell", run: () => void newTerminal() },
  { id: "terminal.adapt", label: t("Terminal: Adaptar a mi terminal (VS Code / Windows Terminal)…"), keywords: "terminal adaptar fuente colores esquema tema", run: () => void adaptToMyTerminal() },
  { id: "terminal.clear", label: t("Terminal: Limpiar"), keywords: "terminal clear limpiar", run: clearTerminal },
  { id: "terminal.kill", label: t("Terminal: Terminar la terminal activa"), keywords: "terminal kill cerrar", run: killActiveTerminal },
  { id: "terminal.runSelection", label: t("Terminal: Ejecutar la selección en la terminal"), keywords: "terminal run ejecutar", run: runSelectionInTerminal },
  { id: "terminal.here", label: t("Terminal: Nueva terminal en la carpeta del archivo activo"), keywords: "terminal carpeta aquí", run: terminalHere },
  { id: "palette.commands", label: t("Paleta de comandos"), key: "Ctrl+Shift+P", run: openPalette },
  { id: "palette.files", label: t("Ir a un archivo…"), key: "Ctrl+P", run: quickOpenFiles },
  { id: "lsp.restart", label: t("Lenguaje: Reiniciar inteligencia de TypeScript y JavaScript"), keywords: "lsp typescript javascript servidor lenguaje", run: () => { if (inTauri && ws.root) setLspWorkspace(ws.root); else setStatus(t("Abre una carpeta para iniciar el servidor de lenguaje")); } },

  { id: "pref.theme", label: t("Preferencias: Tema de color…"), keywords: "theme tema temas color colores apariencia", run: openThemeGallery },
  { id: "pref.syntax", label: t("Preferencias: Colores del código…"), keywords: "syntax sintaxis highlight colores", run: pickSyntax },
  { id: "pref.importTheme", label: t("Preferencias: Importar tema de VS Code instalado…"), keywords: "import vscode theme importar", run: importInstalled },
  { id: "pref.importThemeFile", label: t("Preferencias: Importar archivo de tema (.json)…"), run: () => void importFromFile() },
  { id: "pref.removeTheme", label: t("Preferencias: Quitar un tema importado…"), run: removeImported },
  { id: "pref.wrap", label: t("Preferencias: Alternar ajuste de línea"), key: "Alt+Z", keywords: "toggle word wrap ajuste línea envolver wrap", run: toggle("wordWrap", t("Ajuste de línea")) },
  { id: "pref.minimap", label: t("Preferencias: Minimapa"), run: toggle("minimap", t("Minimapa")) },
  { id: "pref.lines", label: t("Preferencias: Números de línea"), run: toggle("lineNumbers", t("Números de línea")) },
  { id: "pref.whitespace", label: t("Preferencias: Mostrar espacios"), run: toggle("whitespace", t("Mostrar espacios")) },
  { id: "pref.ligatures", label: t("Preferencias: Ligaduras de fuente"), run: toggle("ligatures", t("Ligaduras")) },
  { id: "pref.autosave", label: t("Preferencias: Autoguardado"), run: toggle("autoSave", t("Autoguardado")) },
  { id: "pref.formatonsave", label: t("Preferencias: Formatear al guardar"), keywords: "format formatear guardar", run: toggle("formatOnSave", t("Formatear al guardar")) },
  { id: "pref.inlineai", label: t("IA: Alternar autocompletado en línea (Ollama)"), keywords: "ia ollama autocompletado fantasma tab inline", run: () => { resetInlineAiBackoff(); toggle("inlineAiEnabled", t("Autocompletado de IA en línea"))(); } },

  { id: "explorer.refresh", label: t("Explorador: Actualizar"), run: () => void refreshTree() },
  { id: "explorer.collapse", label: t("Explorador: Contraer todo"), run: collapseAll },
  { id: "view.debug", label: t("Ver: Depurador"), keywords: "debug depurar breakpoint dap variables", run: () => showView("debug") },
  { id: "debug.start", label: t("Depurador: Iniciar o continuar"), key: "F5", keywords: "debug depurar ejecutar continuar", run: () => { showView("debug"); void startOrContinueDebug(); } },
  { id: "debug.stop", label: t("Depurador: Detener"), key: "Shift+F5", keywords: "debug detener parar", run: () => void stopDebug() },
  { id: "debug.stepOver", label: t("Depurador: Paso por encima"), key: "F10", keywords: "debug step over paso", run: () => void stepOverDebug() },
  { id: "debug.stepInto", label: t("Depurador: Entrar en función"), key: "Shift+F10", keywords: "debug step into entrar", run: () => void stepIntoDebug() },
  { id: "debug.stepOut", label: t("Depurador: Salir de función"), key: "Shift+F11", keywords: "debug step out salir", run: () => void stepOutDebug() },
  { id: "debug.toggleBreakpoint", label: t("Depurador: Alternar punto de interrupción"), key: "F9", keywords: "debug breakpoint punto interrupcion", run: toggleCurrentBreakpoint },
);

initKeys();

// ---------- Barra de título: menús ----------
/** Acción de Monaco sobre el editor con foco (deshacer, comentar, ir a línea…). */
const editorAction = (label: string, id: string, hint = ""): MenuEntry => ({
  label, hint,
  run: () => {
    const e = focusedEditor();
    if (!e) { setStatus(t("Abre un archivo para usar esta acción")); return; }
    e.focus();
    const a = e.getAction(id);
    if (a) void a.run(); else e.trigger("menu", id, null);
  },
});

const pasteEntry: MenuEntry = {
  label: t("Pegar"), hint: "Ctrl+V",
  run: async () => {
    const e = focusedEditor();
    if (!e) return;
    try {
      const text = await navigator.clipboard.readText();
      e.focus();
      e.trigger("menu", "type", { text });
    } catch {
      setStatus(t("No se pudo leer el portapapeles desde el menú; usa Ctrl+V"));
    }
  },
};

const MENUS: MenuDef[] = [
  { label: t("Archivo"), items: [
    { cmd: "file.openFolder", label: t("Abrir carpeta…") },
    { cmd: "file.openFolderNewWindow", label: t("Abrir carpeta en nueva ventana…") },
    { cmd: "file.openRecent", label: t("Abrir carpeta reciente…") },
    { cmd: "file.closeFolder", label: t("Cerrar carpeta") },
    "sep",
    { cmd: "file.newFile", label: t("Nuevo archivo…") },
    { cmd: "file.newFolder", label: t("Nueva carpeta…") },
    "sep",
    { cmd: "file.save", label: t("Guardar") },
    { cmd: "file.saveAll", label: t("Guardar todo") },
    "sep",
    { cmd: "tab.close", label: t("Cerrar pestaña") },
    { cmd: "tab.reopen", label: t("Reabrir la última pestaña cerrada") },
    { cmd: "tab.closeAll", label: t("Cerrar todas las pestañas del grupo") },
    "sep",
    { label: t("Salir"), hint: "Alt+F4", run: () => { if (inTauri) void getCurrentWindow().close(); } },
  ] },
  { label: t("Editar"), items: [
    editorAction(t("Deshacer"), "undo", "Ctrl+Z"),
    editorAction(t("Rehacer"), "redo", "Ctrl+Y"),
    "sep",
    editorAction(t("Cortar"), "editor.action.clipboardCutAction", "Ctrl+X"),
    editorAction(t("Copiar"), "editor.action.clipboardCopyAction", "Ctrl+C"),
    pasteEntry,
    "sep",
    editorAction(t("Buscar"), "actions.find", "Ctrl+F"),
    editorAction(t("Reemplazar"), "editor.action.startFindReplace", "Ctrl+H"),
    { cmd: "view.search", label: t("Buscar en archivos") },
    "sep",
    editorAction(t("Alternar comentario de línea"), "editor.action.commentLine", "Ctrl+/"),
    editorAction(t("Formatear el documento"), "editor.action.formatDocument", "Shift+Alt+F"),
  ] },
  { label: t("Selección"), items: [
    editorAction(t("Seleccionar todo"), "editor.action.selectAll", "Ctrl+A"),
    editorAction(t("Expandir la selección"), "editor.action.smartSelect.expand", "Shift+Alt+\u2192"),
    editorAction(t("Reducir la selección"), "editor.action.smartSelect.shrink", "Shift+Alt+\u2190"),
    "sep",
    editorAction(t("Copiar línea arriba"), "editor.action.copyLinesUpAction", "Shift+Alt+\u2191"),
    editorAction(t("Copiar línea abajo"), "editor.action.copyLinesDownAction", "Shift+Alt+\u2193"),
    editorAction(t("Mover línea arriba"), "editor.action.moveLinesUpAction", "Alt+\u2191"),
    editorAction(t("Mover línea abajo"), "editor.action.moveLinesDownAction", "Alt+\u2193"),
    "sep",
    editorAction(t("Añadir cursor arriba"), "editor.action.insertCursorAbove", "Ctrl+Alt+\u2191"),
    editorAction(t("Añadir cursor abajo"), "editor.action.insertCursorBelow", "Ctrl+Alt+\u2193"),
    editorAction(t("Seleccionar todas las apariciones"), "editor.action.selectHighlights", "Ctrl+Shift+L"),
  ] },
  { label: t("Ver"), items: [
    { cmd: "palette.commands", label: t("Paleta de comandos…") },
    "sep",
    { cmd: "view.explorer", label: t("Explorador") },
    { cmd: "view.search", label: t("Buscar") },
    { cmd: "view.git", label: t("Control de código fuente") },
    { cmd: "view.issues", label: t("Issues de GitHub") },
    { cmd: "view.board", label: t("Tablero kanban de issues") },
    { cmd: "view.settings", label: t("Configuración") },
    "sep",
    { cmd: "layout.split", label: t("Dividir el editor") },
    { cmd: "layout.orientation", label: t("Cambiar la orientación de los grupos") },
    { cmd: "view.sidebar", label: t("Mostrar u ocultar la barra lateral") },
    { cmd: "terminal.toggle", label: t("Terminal") },
    "sep",
    { cmd: "pref.wrap", label: t("Alternar ajuste de línea") },
    { cmd: "pref.minimap", label: t("Minimapa") },
    { cmd: "view.zoomIn", label: t("Aumentar la fuente") },
    { cmd: "view.zoomOut", label: t("Reducir la fuente") },
    { cmd: "view.zoomReset", label: t("Restablecer el tamaño de fuente") },
    "sep",
    { cmd: "pref.theme", label: t("Tema de color…") },
    { cmd: "view.fullscreen", label: t("Pantalla completa") },
  ] },
  { label: t("Ir a"), items: [
    { cmd: "palette.files", label: t("Ir a archivo…") },
    editorAction(t("Ir a línea…"), "editor.action.gotoLine", "Ctrl+G"),
    editorAction(t("Ir a símbolo del archivo…"), "editor.action.quickOutline", "Ctrl+Shift+O"),
    "sep",
    editorAction(t("Ir a la definición"), "editor.action.revealDefinition", "F12"),
    editorAction(t("Buscar referencias"), "editor.action.goToReferences", "Shift+F12"),
    "sep",
    { cmd: "nav.back", label: t("Atrás") },
    { cmd: "nav.forward", label: t("Adelante") },
    "sep",
    { cmd: "tab.next", label: t("Pestaña siguiente") },
    { cmd: "tab.prev", label: t("Pestaña anterior") },
    { cmd: "layout.focus1", label: t("Grupo de editores 1") },
    { cmd: "layout.focus2", label: t("Grupo de editores 2") },
  ] },
  { label: t("Terminal"), items: [
    { cmd: "terminal.new", label: t("Nueva terminal") },
    { cmd: "terminal.toggle", label: t("Mostrar u ocultar la terminal") },
    "sep",
    { cmd: "terminal.here", label: t("Nueva terminal en la carpeta del archivo") },
    { cmd: "terminal.runSelection", label: t("Ejecutar la selección en la terminal") },
    "sep",
    { cmd: "terminal.clear", label: t("Limpiar la terminal") },
    { cmd: "terminal.kill", label: t("Terminar la terminal activa") },
  ] },
  { label: t("Ayuda"), items: [
    { cmd: "palette.commands", label: t("Mostrar todos los comandos") },
    { cmd: "view.settings", label: t("Configuración y atajos de teclado") },
    { cmd: "app.checkUpdates", label: t("Buscar actualizaciones") },
    { cmd: "app.copyDiagnostics", label: t("Copiar información de diagnóstico") },
    { cmd: "app.onboarding", label: t("Asistente de bienvenida") },
    "sep",
    { label: t("Acerca de Pulso"), run: async () => { const version = inTauri ? await getVersion().catch(() => "") : ""; void showDialog({
      title: "Pulso Editor",
      message: t("Versión {version}", { version: version || t("desconocida") }) + "\n\n" + t("Editor de código con issues, tableros y repos integrados.") + "\n" + t("Hecho con Tauri 2 y Monaco Editor."),
      buttons: [{ label: t("Cerrar"), value: "ok", primary: true }],
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
  el.title = info.dirty ? t("Hay cambios sin confirmar") : t("Sin cambios pendientes");
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
initTestsView();
initDebug((path, line) => openFile(path, line ? { line } : undefined));
initConflictHelper();
initInlineCompletions();
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
      title: t("Hay cambios sin guardar"),
      message: dirty.map((d) => `• ${baseName(d.path)}`).slice(0, 8).join("\n") + (dirty.length > 8 ? "\n" + t("… y {count} más", { count: dirty.length - 8 }) : ""),
      buttons: [
        { label: t("Cancelar"), value: "cancel" },
        { label: t("Salir sin guardar"), value: "discard", danger: true },
        { label: t("Guardar todo y salir"), value: "save", primary: true },
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
    void autoConnect().then((login) => { if (login) setStatus(t("Conectado a GitHub como {login} (con la sesión de Git de este equipo)", { login }), 6000); });
    syncSettingsUI();
    rerenderGroups();
    if (!inTauri) return;
    const windowFolder = new URLSearchParams(window.location.search).get("folder");
    const mainWin = isMainWindow();
    // Sin sesión guardada se reabre la última carpeta usada, como hacen los editores habituales.
    const cliTargets = mainWin ? await invoke<CliTarget[]>("cli_startup_targets").catch(() => [] as CliTarget[]) : [];
    const root = windowFolder
      ? windowFolder
      : cliTargets.some((t) => t.kind === "dir")
        ? null
        : mainWin
          ? (startupSession?.root ?? startupLastRoot)
          : null;
    if (root) {
      const initialLayout = windowFolder
        ? undefined
        : (startupSession?.root ? (startupSession.layout as Layout) : undefined);
      const ok = await openWorkspace(root, initialLayout);
      if (!ok && mainWin && !windowFolder) { clearSession(); clearLastRoot(); }
    }
    // El aviso de recuperación espera una respuesta: la pantalla de carga debe retirarse antes,
    // o quedaría tapándolo hasta el límite de 12 s.
    persister.markReady();
    revealApp();
    if (mainWin) {
      // Si se vuelve a lanzar `pulso ...`, la instancia única nos manda las rutas por aquí.
      await listen<CliTarget[]>("cli-open", (e) => void applyCliTargets(e.payload));
      await applyCliTargets(cliTargets);
      await offerRecovery(openFile);
      if (shouldShowOnboarding({ done: isOnboardingDone(), hasRecent: getRecent().length > 0, hasRoot: !!ws.root })) {
        openOnboarding({ onOpenFolder: pickFolder });
      }
      // Antes de instalar una versión nueva (Pulso se cierra): guardar lo pendiente o no instalar.
      initUpdates(async () => {
        for (const d of dirtyDocs()) if (!(await saveDoc(d))) return false;
        persister.flush();
        return true;
      });
    }
  } finally {
    persister.markReady();
    revealApp();
  }
})();

