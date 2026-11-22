import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { findOpenDoc, onDocSaved, setBeforeSave } from "./docs";
import { config, openFile } from "./groups";
import { setLspState } from "./lspState";
import { setStatus } from "./ui";
import { applyTextEdits, collectEdits } from "./lspEdits";
import { fileKey } from "./util";

type Json = any; // LSP messages are validated at the boundary where they are used.
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: number };
type ServerCaps = {
  signatureHelp: boolean;
  codeAction: boolean;
  codeActionResolve: boolean;
  inlayHint: boolean;
  documentSymbol: boolean;
  formatting: boolean;
  executeCommand: boolean;
};
type Session = {
  id: number;
  root: string;
  ready: boolean;
  incremental: boolean;
  caps: ServerCaps;
  next: number;
  pending: Map<number, Pending>;
  send: Promise<void>;
  models: Map<string, monaco.IDisposable>;
  openedAt: Map<string, number>;
  definitions: Map<string, Promise<monaco.languages.LocationLink[]>>;
};
let session: Session | null = null;
let generation = 0;
let transition: Promise<void> = Promise.resolve();
let workspaceRoot: string | null = null;
let listenersReady: Promise<void> | null = null;
let inlayRefresh: monaco.Emitter<void> | null = null;
const owner = "pulso-lsp";
const defaults = [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults];

function builtIn(enabled: boolean) {
  for (const d of defaults) d.setModeConfiguration({ completionItems: enabled, hovers: enabled, definitions: enabled, references: enabled, diagnostics: enabled, rename: enabled, documentSymbols: true, documentHighlights: true, documentRangeFormattingEdits: true, signatureHelp: true, onTypeFormattingEdits: true, codeActions: true, inlayHints: true });
}
function language(model: monaco.editor.ITextModel): string | null {
  const p = model.uri.path.toLowerCase();
  if (/\.tsx$/.test(p)) return "typescriptreact";
  if (/\.(ts|mts|cts)$/.test(p)) return "typescript";
  if (/\.jsx$/.test(p)) return "javascriptreact";
  if (/\.(js|mjs|cjs)$/.test(p)) return "javascript";
  return null;
}
const uri = (model: monaco.editor.ITextModel) => model.uri.toString();
const pos = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const range = (r: Json): monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });

function send(s: Session, message: Json): Promise<void> {
  const operation = s.send.then(() => invoke<void>("lsp_send", { id: s.id, message }));
  s.send = operation.catch(() => {});
  return operation;
}
function notify(s: Session, method: string, params?: Json) {
  void send(s, { jsonrpc: "2.0", method, params }).catch((e) => fail(s, String(e)));
}
function request(s: Session, method: string, params: Json, token?: monaco.CancellationToken): Promise<Json> {
  const id = ++s.next;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { s.pending.delete(id); reject(new Error(`LSP: tiempo agotado (${method})`)); }, 15000);
    s.pending.set(id, { resolve, reject, timer });
    token?.onCancellationRequested(() => { if (s.pending.delete(id)) { clearTimeout(timer); notify(s, "$/cancelRequest", { id }); resolve(null); } });
    void send(s, { jsonrpc: "2.0", id, method, params }).catch((e) => {
      if (s.pending.delete(id)) { clearTimeout(timer); reject(e); }
      fail(s, String(e));
    });
  });
}
function clear(s: Session) {
  for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Servidor LSP cerrado")); }
  s.pending.clear();
  for (const d of s.models.values()) d.dispose();
  s.models.clear();
  for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, owner, []);
}
function fail(s: Session, error: string) {
  if (session !== s) return;
  session = null;
  clear(s);
  builtIn(true);
  setLspState({ kind: "stopped", reason: error });
  setStatus(`Inteligencia de proyecto no disponible: ${error}`, 12000);
  transition = transition.catch(() => {}).then(async () => { if (!session) await invoke("lsp_stop"); });
}
function openModel(s: Session, model: monaco.editor.ITextModel) {
  const lang = language(model);
  if (!s.ready || !lang || model.uri.scheme !== "file" || s.models.has(uri(model))) return;
  const documentUri = uri(model);
  s.openedAt.set(documentUri, Date.now());
  notify(s, "textDocument/didOpen", { textDocument: { uri: documentUri, languageId: lang, version: model.getVersionId(), text: model.getValue() } });
  const change = model.onDidChangeContent((event) => {
    s.definitions.clear();
    const contentChanges = s.incremental && !event.isFlush && !event.isEolChange
      ? event.changes.map((c) => ({ range: { start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 }, end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 } }, text: c.text }))
      : [{ text: model.getValue() }];
    notify(s, "textDocument/didChange", { textDocument: { uri: documentUri, version: model.getVersionId() }, contentChanges });
  });
  const dispose = model.onWillDispose(() => { change.dispose(); dispose.dispose(); s.models.delete(documentUri); s.openedAt.delete(documentUri); notify(s, "textDocument/didClose", { textDocument: { uri: documentUri } }); });
  s.models.set(documentUri, { dispose: () => { change.dispose(); dispose.dispose(); } });
}
function handleMessage(id: number, msg: Json) {
  const s = session;
  if (!s || s.id !== id || !msg || typeof msg !== "object") return;
  if (msg.method && msg.id !== undefined) {
    // Responder a solicitudes del servidor evita que este quede esperando indefinidamente.
    if (msg.method === "workspace/applyEdit") {
      void applyServerWorkspaceEdit(s, msg.params?.edit)
        .then((applied) => send(s, { jsonrpc: "2.0", id: msg.id, result: { applied } }))
        .catch((e) => send(s, { jsonrpc: "2.0", id: msg.id, result: { applied: false, failureReason: String(e) } }));
      return;
    }
    if (msg.method === "workspace/inlayHint/refresh") {
      inlayRefresh?.fire();
      void send(s, { jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => ({})) : null;
    void send(s, { jsonrpc: "2.0", id: msg.id, result });
  } else if (msg.method === "textDocument/publishDiagnostics") {
    const resource = monaco.Uri.parse(msg.params.uri);
    const model = monaco.editor.getModel(resource) ?? findOpenDoc(resource.fsPath)?.model;
    if (!model || !Array.isArray(msg.params.diagnostics)) return;
    if (typeof msg.params.version === "number" && msg.params.version < model.getVersionId()) return;
    monaco.editor.setModelMarkers(model, owner, msg.params.diagnostics.map((d: Json) => ({ ...range(d.range), message: d.message, severity: [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][(d.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Error, code: d.code === undefined ? undefined : String(d.code), source: d.source })));
  } else if (msg.id !== undefined && !msg.method) {
    const p = s.pending.get(msg.id);
    if (!p) return;
    s.pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  }
}
async function ensureListeners() {
  if (!listenersReady) listenersReady = (async () => {
    await listen<{ id: number; message: Json }>("lsp-message", (e) => handleMessage(e.payload.id, e.payload.message));
    await listen<{ id: number; error: string }>("lsp-exit", (e) => { if (session?.id === e.payload.id) fail(session, e.payload.error); });
  })();
  await listenersReady;
}

/** Cambiar de carpeta cierra el proceso anterior y sincroniza los modelos ya abiertos. */
export function setLspWorkspace(root: string | null) {
  workspaceRoot = root;
  const current = ++generation;
  const previous = session;
  session = null;
  if (previous) clear(previous);
  builtIn(true);
  setLspState(root ? { kind: "starting" } : { kind: "off" });
  transition = transition.catch(() => {}).then(async () => {
    await invoke("lsp_stop");
    if (!root || current !== generation) return;
    await ensureListeners();
    if (current !== generation) return;
    const id = await invoke<number>("lsp_start", { root });
    if (current !== generation) { await invoke("lsp_stop"); return; }
    const s: Session = {
      id,
      root,
      ready: false,
      incremental: false,
      caps: { signatureHelp: false, codeAction: false, codeActionResolve: false, inlayHint: false, documentSymbol: false, formatting: true, executeCommand: false },
      next: 0,
      pending: new Map(),
      send: Promise.resolve(),
      models: new Map(),
      openedAt: new Map(),
      definitions: new Map(),
    };
    session = s;
    try {
      const rootUri = monaco.Uri.file(root).toString();
      const hostPid = await invoke<number>("lsp_host_pid").catch(() => null);
      const result = await request(s, "initialize", {
        processId: hostPid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: root.split(/[\\/]/).pop() || root }],
        capabilities: {
          workspace: {
            configuration: true,
            applyEdit: true,
            executeCommand: { dynamicRegistration: false },
            inlayHint: { refreshSupport: true },
            workspaceEdit: { documentChanges: true },
          },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            completion: { completionItem: { snippetSupport: true, resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } }, contextSupport: true },
            codeAction: {
              codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
              resolveSupport: { properties: ["edit", "command"] },
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            inlayHint: { resolveSupport: { properties: ["tooltip", "textEdits"] } },
            rename: { prepareSupport: true },
            formatting: {},
          },
        },
        initializationOptions: {
          hostInfo: "Pulso",
          disableAutomaticTypingAcquisition: true,
          maxTsServerMemory: 1536,
          preferences: {
            includeInlayParameterNameHints: "literals",
            includeInlayParameterNameHintsWhenArgumentMatchesName: false,
            includeInlayEnumMemberValueHints: true,
          },
        },
      });
      if (session !== s || current !== generation) return;
      const caps = result?.capabilities;
      const sync = caps?.textDocumentSync;
      s.incremental = (typeof sync === "number" ? sync : sync?.change) === 2;
      s.caps = {
        signatureHelp: !!caps?.signatureHelpProvider,
        codeAction: !!caps?.codeActionProvider,
        codeActionResolve: !!caps?.codeActionProvider?.resolveProvider,
        inlayHint: !!caps?.inlayHintProvider,
        documentSymbol: !!caps?.documentSymbolProvider,
        formatting: caps?.documentFormattingProvider !== false,
        executeCommand: !!caps?.executeCommandProvider,
      };
      notify(s, "initialized", {});
      s.ready = true;
      builtIn(false);
      setLspState({ kind: "ready" });
      for (const model of monaco.editor.getModels()) openModel(s, model);
      setStatus("Inteligencia de TypeScript y JavaScript activada");
    } catch (e) { fail(s, String(e)); }
  }).catch((e) => { if (current === generation) { builtIn(true); setLspState({ kind: "stopped", reason: String(e) }); setStatus(String(e).startsWith("No se pudo iniciar") ? String(e) : `No se pudo iniciar LSP: ${e}`, 12000); } });
}

function active(model: monaco.editor.ITextModel) { return session?.ready && language(model) && session.models.has(uri(model)) ? session : null; }
function params(model: monaco.editor.ITextModel, position: monaco.Position) { return { textDocument: { uri: uri(model) }, position: pos(position) }; }
function safe<T>(p: Promise<T>, fallback: T): Promise<T> { return p.catch(() => fallback); }
const completionKinds = [monaco.languages.CompletionItemKind.Text, monaco.languages.CompletionItemKind.Method, monaco.languages.CompletionItemKind.Function, monaco.languages.CompletionItemKind.Constructor, monaco.languages.CompletionItemKind.Field, monaco.languages.CompletionItemKind.Variable, monaco.languages.CompletionItemKind.Class, monaco.languages.CompletionItemKind.Interface, monaco.languages.CompletionItemKind.Module, monaco.languages.CompletionItemKind.Property, monaco.languages.CompletionItemKind.Unit, monaco.languages.CompletionItemKind.Value, monaco.languages.CompletionItemKind.Enum, monaco.languages.CompletionItemKind.Keyword, monaco.languages.CompletionItemKind.Snippet, monaco.languages.CompletionItemKind.Color, monaco.languages.CompletionItemKind.File, monaco.languages.CompletionItemKind.Reference, monaco.languages.CompletionItemKind.Folder, monaco.languages.CompletionItemKind.EnumMember, monaco.languages.CompletionItemKind.Constant, monaco.languages.CompletionItemKind.Struct, monaco.languages.CompletionItemKind.Event, monaco.languages.CompletionItemKind.Operator, monaco.languages.CompletionItemKind.TypeParameter];
function markdown(value: Json): string { if (typeof value === "string") return value; if (Array.isArray(value)) return value.map(markdown).join("\n\n"); return value?.language ? `\`\`\`${value.language}\n${value.value}\n\`\`\`` : value?.value ?? ""; }
function locations(value: Json): monaco.languages.LocationLink[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter((x: Json) => x.uri || x.targetUri).map((x: Json) => ({ uri: monaco.Uri.parse(x.uri ?? x.targetUri), range: range(x.range ?? x.targetRange), targetSelectionRange: x.targetSelectionRange ? range(x.targetSelectionRange) : undefined, originSelectionRange: x.originSelectionRange ? range(x.originSelectionRange) : undefined }));
}

/** Espera el arranque y comparte la consulta del subrayado con el clic posterior. */
async function definition(model: monaco.editor.ITextModel, position: monaco.Position, indicate: boolean): Promise<monaco.languages.LocationLink[] | null> {
  const started = generation;
  if (!active(model) && language(model) && workspaceRoot) {
    if (indicate) setStatus("Iniciando inteligencia de código…");
    await transition;
  }
  if (started !== generation || model.isDisposed()) return null;
  const s = active(model);
  if (!s) return null;
  const word = model.getWordAtPosition(position);
  const at = word ? { lineNumber: position.lineNumber, column: word.startColumn } as monaco.Position : position;
  const key = `${uri(model)}:${model.getVersionId()}:${at.lineNumber}:${at.column}`;
  let promise = s.definitions.get(key);
  if (!promise) {
    promise = (async () => {
      let found: monaco.languages.LocationLink[] = [];
      const cold = Date.now() - (s.openedAt.get(uri(model)) ?? 0) < 12_000;
      for (const delay of cold ? [0, 200, 400, 800, 1200, 1800] : [0]) {
        if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
        if (session !== s || model.isDisposed()) return [];
        found = locations(await request(s, "textDocument/definition", params(model, at)));
        const first = found[0];
        const selection = first?.targetSelectionRange ?? first?.range;
        // Al arrancar tsserver puede devolver solo el import local mientras carga el proyecto.
        const localImport = first && selection && fileKey(first.uri.fsPath) === fileKey(model.uri.fsPath)
          && /^\s*import\b/.test(model.getLineContent(selection.startLineNumber));
        if (first && !localImport) break;
        if (localImport) found = [];
      }
      return found;
    })();
    s.definitions.set(key, promise);
    if (s.definitions.size > 100) s.definitions.delete(s.definitions.keys().next().value!);
    void promise.then((found) => { if (!found.length && s.definitions.get(key) === promise) s.definitions.delete(key); }, () => { if (s.definitions.get(key) === promise) s.definitions.delete(key); });
  }
  if (indicate) setStatus("Buscando definición…");
  return promise;
}

const slash = (p: string) => p.replace(/\\/g, "/");
const lspRange = (r: monaco.IRange) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const lspSeverity = (s: number) => (s === 8 ? 1 : s === 4 ? 2 : s === 2 ? 3 : 4);
const EXEC_CMD = "pulso.lsp.executeCommand";

function bridgeCommand(cmd: Json): monaco.languages.Command | undefined {
  if (!cmd || typeof cmd.command !== "string") return undefined;
  return { id: EXEC_CMD, title: typeof cmd.title === "string" ? cmd.title : cmd.command, arguments: [cmd.command, Array.isArray(cmd.arguments) ? cmd.arguments : []] };
}

function toMonacoWorkspaceEdit(edit: Json): monaco.languages.WorkspaceEdit {
  const byUri = collectEdits(edit);
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [u, list] of byUri) {
    const target = monaco.Uri.parse(u);
    const open = target.scheme === "file" ? findOpenDoc(slash(target.fsPath)) : undefined;
    const resource = open ? open.model.uri : target;
    for (const e of list) edits.push({ resource, textEdit: { range: range(e.range), text: e.newText }, versionId: undefined });
  }
  return { edits };
}

async function writeClosedEdits(closed: { path: string; text: string; mtime: number }[]): Promise<void> {
  const written: string[] = [];
  for (const f of closed) {
    try { await invoke("write_file", { path: f.path, contents: f.text, expectedMtime: f.mtime }); written.push(f.path); }
    catch (e) {
      const done = written.length ? ` Ya se escribieron: ${written.map((w) => w.split("/").pop()).join(", ")}.` : "";
      throw new Error(`No se pudo escribir ${f.path.split("/").pop()}: ${String(e).replace(/^CONFLICT$/, "cambió en el disco")}.${done}`);
    }
  }
}

async function prepareWorkspaceEdits(workspaceEdit: Json) {
  const byUri = collectEdits(workspaceEdit);
  const openEdits: { model: monaco.editor.ITextModel; edit: monaco.languages.IWorkspaceTextEdit; textEdit: monaco.editor.ISingleEditOperation }[] = [];
  const closed: { path: string; text: string; mtime: number }[] = [];
  for (const [u, list] of byUri) {
    const target = monaco.Uri.parse(u);
    if (target.scheme !== "file") throw new Error(`El servidor pidió editar un recurso que no es un archivo (${u})`);
    const path = slash(target.fsPath);
    const open = findOpenDoc(path);
    const model = open?.model ?? monaco.editor.getModel(target);
    if (model) {
      for (const e of list) {
        const rg = range(e.range);
        openEdits.push({ model, edit: { resource: model.uri, textEdit: { range: rg, text: e.newText }, versionId: undefined }, textEdit: { range: rg, text: e.newText } });
      }
    } else {
      const mtime = await invoke<number>("file_mtime", { path });
      const text = applyTextEdits(await invoke<string>("read_file", { path }), list);
      closed.push({ path, text, mtime });
    }
  }
  return { files: byUri.size, openEdits, closed };
}

async function applyServerWorkspaceEdit(_s: Session, workspaceEdit: Json): Promise<boolean> {
  if (!workspaceEdit) return false;
  const { openEdits, closed } = await prepareWorkspaceEdits(workspaceEdit);
  await writeClosedEdits(closed);
  const byModel = new Map<monaco.editor.ITextModel, monaco.editor.ISingleEditOperation[]>();
  for (const item of openEdits) {
    const list = byModel.get(item.model) ?? [];
    list.push(item.textEdit);
    byModel.set(item.model, list);
  }
  for (const [model, ops] of byModel) model.pushEditOperations([], ops, () => null);
  return true;
}

/**
 * Pide el renombrado al servidor. Los archivos abiertos se editan en el editor (quedan sin guardar y se pueden deshacer);
 * los cerrados se escriben en el disco, y solo si todos se pueden calcular antes de escribir ninguno.
 */
async function renameEdits(s: Session, model: monaco.editor.ITextModel, position: monaco.Position, newName: string, token: monaco.CancellationToken): Promise<monaco.languages.WorkspaceEdit & monaco.languages.Rejection> {
  const result = await request(s, "textDocument/rename", { ...params(model, position), newName }, token);
  const { files, openEdits, closed } = await prepareWorkspaceEdits(result);
  if (token.isCancellationRequested) return { edits: [] };
  await writeClosedEdits(closed);
  const edits = openEdits.map((o) => o.edit);
  setStatus(`Renombrado en ${files} archivo${files === 1 ? "" : "s"}${closed.length ? ` (${closed.length} guardado${closed.length === 1 ? "" : "s"} en disco)` : ""}${edits.length ? ". Los archivos abiertos quedan sin guardar" : ""}`, 6000);
  return { edits };
}

/** Ediciones de formato que propone el servidor para todo el documento. */
async function formatEdits(s: Session, model: monaco.editor.ITextModel, token?: monaco.CancellationToken): Promise<monaco.languages.TextEdit[]> {
  const o = model.getOptions();
  const edits = await request(s, "textDocument/formatting", { textDocument: { uri: uri(model) }, options: { tabSize: o.tabSize, insertSpaces: o.insertSpaces } }, token);
  return (Array.isArray(edits) ? edits : []).map((e: Json) => ({ range: range(e.range), text: e.newText }));
}

function toDocumentSymbols(items: Json): monaco.languages.DocumentSymbol[] {
  if (!Array.isArray(items)) return [];
  const mapOne = (x: Json): monaco.languages.DocumentSymbol | null => {
    const rg = x.range ?? x.location?.range;
    if (!rg || typeof x.name !== "string") return null;
    const sel = x.selectionRange ?? rg;
    return {
      name: x.name,
      detail: typeof x.detail === "string" ? x.detail : "",
      kind: Math.max(0, (x.kind ?? 1) - 1),
      tags: Array.isArray(x.tags) ? x.tags : [],
      containerName: typeof x.containerName === "string" ? x.containerName : undefined,
      range: range(rg),
      selectionRange: range(sel),
      children: Array.isArray(x.children) ? x.children.map(mapOne).filter((c: Json): c is monaco.languages.DocumentSymbol => !!c) : undefined,
    };
  };
  return items.map(mapOne).filter((s): s is monaco.languages.DocumentSymbol => !!s);
}

function toCodeAction(raw: Json): monaco.languages.CodeAction & { _lsp?: Json } {
  if (raw && typeof raw.command === "string" && !raw.edit && !raw.kind) {
    return { title: String(raw.title ?? raw.command), command: bridgeCommand(raw), _lsp: raw };
  }
  return {
    title: String(raw?.title ?? "Acción"),
    kind: typeof raw?.kind === "string" ? raw.kind : undefined,
    isPreferred: raw?.isPreferred === true,
    disabled: typeof raw?.disabled?.reason === "string" ? raw.disabled.reason : undefined,
    edit: raw?.edit ? toMonacoWorkspaceEdit(raw.edit) : undefined,
    command: raw?.command ? bridgeCommand(raw.command) : undefined,
    _lsp: raw,
  };
}

function toInlayHints(raw: Json): monaco.languages.InlayHint[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h: Json) => h?.position).map((h: Json) => ({
    position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
    label: Array.isArray(h.label)
      ? h.label.map((p: Json) => ({ label: String(p.value ?? p.label ?? ""), tooltip: p.tooltip ? { value: markdown(p.tooltip) } : undefined, command: p.command ? bridgeCommand(p.command) : undefined }))
      : String(h.label ?? ""),
    kind: h.kind === 1 || h.kind === 2 ? h.kind : undefined,
    tooltip: h.tooltip ? { value: markdown(h.tooltip) } : undefined,
    paddingLeft: h.paddingLeft === true,
    paddingRight: h.paddingRight === true,
  }));
}

export function initLsp() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (!inlayRefresh && typeof monaco.Emitter === "function") inlayRefresh = new monaco.Emitter<void>();
  monaco.editor.registerCommand?.(EXEC_CMD, (_accessor, command: string, args?: unknown[]) => {
    const s = session;
    if (!s?.ready || !command) return Promise.resolve();
    return safe(request(s, "workspace/executeCommand", { command, arguments: args ?? [] }), null);
  });
  config.probeDefinition = async (model, position) => !!(await definition(model, position, false))?.length;
  config.goToDefinition = async (model, position, isCurrent = () => true) => {
    const result = await definition(model, position, true);
    if (!isCurrent() || model.isDisposed()) return true;
    if (!result) return false;
    const target = result[0];
    if (!target || target.uri.scheme !== "file") {
      setStatus("No se encontró una definición para este símbolo");
      return true;
    }
    const selection = target.targetSelectionRange ?? target.range;
    await openFile(target.uri.fsPath.replace(/\\/g, "/"), { line: selection.startLineNumber, col: selection.startColumn });
    return true;
  };
  monaco.editor.onDidCreateModel((model) => { if (session) openModel(session, model); });
  // «Formatear al guardar»: si el texto cambió mientras el servidor respondía, las ediciones ya no encajan y se descartan.
  setBeforeSave(async (d) => {
    const s = session;
    if (!s || !active(d.model) || !s.caps.formatting) return;
    const version = d.model.getVersionId();
    const edits = await Promise.race([formatEdits(s, d.model), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("el servidor tardó demasiado")), 4000))]);
    if (!edits.length || d.model.getVersionId() !== version) return;
    d.model.pushEditOperations([], edits, () => null);
  });
  onDocSaved((path) => { const s = session, model = monaco.editor.getModel(monaco.Uri.file(path)); if (s && model && active(model)) notify(s, "textDocument/didSave", { textDocument: { uri: uri(model) } }); });
  monaco.editor.registerEditorOpener({ openCodeEditor: async (_source, resource, selection) => {
    if (resource.scheme !== "file") return false;
    const start = selection && ("startLineNumber" in selection ? { line: selection.startLineNumber, col: selection.startColumn } : { line: selection.lineNumber, col: selection.column });
    await openFile(resource.fsPath.replace(/\\/g, "/"), start || {});
    return true;
  } });
  for (const lang of ["typescript", "javascript"]) {
    monaco.languages.registerHoverProvider(lang, { provideHover: (model, position, token) => {
      const s = active(model); if (!s) return null;
      return safe(request(s, "textDocument/hover", params(model, position), token).then((v) => v ? { range: v.range ? range(v.range) : undefined, contents: [{ value: markdown(v.contents) }] } : null), null);
    } });
    monaco.languages.registerDefinitionProvider(lang, { provideDefinition: (model, position, token) => { const s = active(model); return s ? safe(request(s, "textDocument/definition", params(model, position), token).then(locations), []) : null; } });
    monaco.languages.registerReferenceProvider(lang, { provideReferences: (model, position, context, token) => { const s = active(model); return s ? safe(request(s, "textDocument/references", { ...params(model, position), context }, token).then(locations), []) : null; } });
    // Con esquema además de lenguaje, este proveedor puntúa más que el de Monaco y siempre se prefiere.
    monaco.languages.registerRenameProvider({ language: lang, scheme: "file", exclusive: true }, {
      resolveRenameLocation: async (model, position, token) => {
        const s = active(model);
        if (!s) return { range: model.getWordAtPosition(position) ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: model.getWordAtPosition(position)!.startColumn, endColumn: model.getWordAtPosition(position)!.endColumn } : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "La inteligencia de lenguaje no está activa" };
        const r = await safe(request(s, "textDocument/prepareRename", params(model, position), token), null);
        const target = r && (r.range ?? (r.start ? r : null));
        if (!target) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "No se puede renombrar lo que hay bajo el cursor" };
        const rg = range(target);
        return { range: rg, text: r.placeholder ?? model.getValueInRange(rg) };
      },
      provideRenameEdits: async (model, position, newName, token) => {
        const s = active(model);
        if (!s) return { edits: [], rejectReason: "La inteligencia de lenguaje no está activa" };
        try { return await renameEdits(s, model, position, newName, token); }
        catch (e) { return { edits: [], rejectReason: e instanceof Error ? e.message : String(e) }; }
      },
    });
    monaco.languages.registerDocumentFormattingEditProvider(lang, { displayName: "Servidor de lenguaje", provideDocumentFormattingEdits: (model, _options, token) => { const s = active(model); return s && s.caps.formatting ? safe(formatEdits(s, model, token), []) : []; } });
    monaco.languages.registerSignatureHelpProvider?.(lang, {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp: (model, position, token, context) => {
        const s = active(model); if (!s || !s.caps.signatureHelp) return null;
        return safe(request(s, "textDocument/signatureHelp", { ...params(model, position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } }, token).then((v) => v?.signatures?.length ? {
          value: {
            signatures: v.signatures.map((sig: Json) => ({
              label: String(sig.label ?? ""),
              documentation: sig.documentation ? { value: markdown(sig.documentation) } : undefined,
              parameters: Array.isArray(sig.parameters) ? sig.parameters.map((p: Json) => ({ label: p.label, documentation: p.documentation ? { value: markdown(p.documentation) } : undefined })) : [],
              activeParameter: typeof sig.activeParameter === "number" ? sig.activeParameter : undefined,
            })),
            activeSignature: typeof v.activeSignature === "number" ? v.activeSignature : 0,
            activeParameter: typeof v.activeParameter === "number" ? v.activeParameter : 0,
          },
          dispose() {},
        } : null), null);
      },
    });
    monaco.languages.registerCodeActionProvider?.(lang, {
      provideCodeActions: (model, selRange, context, token) => {
        const s = active(model); if (!s || !s.caps.codeAction) return { actions: [], dispose() {} };
        const markers = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) =>
          m.endLineNumber >= selRange.startLineNumber && m.startLineNumber <= selRange.endLineNumber
        );
        const diagnostics = markers.map((m) => ({
          range: lspRange({ startLineNumber: m.startLineNumber, startColumn: m.startColumn, endLineNumber: m.endLineNumber, endColumn: m.endColumn }),
          message: m.message,
          severity: lspSeverity(m.severity),
          code: typeof m.code === "object" && m.code ? m.code.value : m.code,
          source: m.source,
        }));
        const ctx: Json = { diagnostics, triggerKind: context.trigger === 2 ? 2 : 1 };
        if (context.only) ctx.only = [context.only];
        return safe(request(s, "textDocument/codeAction", { textDocument: { uri: uri(model) }, range: lspRange(selRange), context: ctx }, token).then((v) => ({
          actions: (Array.isArray(v) ? v : []).map(toCodeAction),
          dispose() {},
        })), { actions: [], dispose() {} });
      },
      resolveCodeAction: (action, token) => {
        const s = session; const raw = (action as Json)._lsp;
        if (!s?.ready || !s.caps.codeActionResolve || !raw) return action;
        return safe(request(s, "codeAction/resolve", raw, token).then((v) => ({
          ...action,
          edit: v?.edit ? toMonacoWorkspaceEdit(v.edit) : action.edit,
          command: v?.command ? bridgeCommand(v.command) : action.command,
        })), action);
      },
    }, { providedCodeActionKinds: ["quickfix", "refactor", "source", "source.organizeImports"] });
    monaco.languages.registerDocumentSymbolProvider?.(lang, {
      displayName: "Servidor de lenguaje",
      provideDocumentSymbols: (model, token) => {
        const s = active(model); if (!s || !s.caps.documentSymbol) return [];
        return safe(request(s, "textDocument/documentSymbol", { textDocument: { uri: uri(model) } }, token).then(toDocumentSymbols), []);
      },
    });
    monaco.languages.registerInlayHintsProvider?.(lang, {
      displayName: "Servidor de lenguaje",
      onDidChangeInlayHints: inlayRefresh?.event,
      provideInlayHints: (model, hintRange, token) => {
        const s = active(model); if (!s || !s.caps.inlayHint) return { hints: [], dispose() {} };
        return safe(request(s, "textDocument/inlayHint", { textDocument: { uri: uri(model) }, range: lspRange(hintRange) }, token).then((v) => ({
          hints: toInlayHints(v),
          dispose() {},
        })), { hints: [], dispose() {} });
      },
    });
    monaco.languages.registerCompletionItemProvider(lang, { triggerCharacters: [".", "\"", "'", "/", "@"], provideCompletionItems: (model, position, _context, token) => {
      const s = active(model); if (!s) return null;
      const word = model.getWordUntilPosition(position);
      const defaultRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return safe(request(s, "textDocument/completion", params(model, position), token).then((v) => ({ suggestions: (Array.isArray(v) ? v : v?.items ?? []).map((item: Json) => ({ label: item.label, kind: completionKinds[(item.kind ?? 1) - 1] ?? monaco.languages.CompletionItemKind.Text, detail: item.detail, documentation: item.documentation ? { value: markdown(item.documentation) } : undefined, sortText: item.sortText, filterText: item.filterText, insertText: item.textEdit?.newText ?? item.insertText ?? item.label, insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, range: item.textEdit?.range ? range(item.textEdit.range) : defaultRange, additionalTextEdits: item.additionalTextEdits?.map((e: Json) => ({ range: range(e.range), text: e.newText })), _lsp: item })), incomplete: !!v?.isIncomplete })), { suggestions: [] });
    }, resolveCompletionItem: (item, token) => {
      const s = session; const raw = (item as Json)._lsp; if (!s?.ready || !raw) return item;
      return safe(request(s, "completionItem/resolve", raw, token).then((v) => ({ ...item, detail: v.detail ?? item.detail, documentation: v.documentation ? { value: markdown(v.documentation) } : item.documentation, additionalTextEdits: v.additionalTextEdits?.map((e: Json) => ({ range: range(e.range), text: e.newText })) ?? item.additionalTextEdits })), item);
    } });
  }
}
