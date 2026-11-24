import { t } from "./i18n";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { findOpenDoc, onDocSaved, setBeforeSave } from "./docs";
import { config, openFile } from "./groups";
import { setLspState } from "./lspState";
import { setStatus } from "./ui";
import { applyTextEdits, collectEdits } from "./lspEdits";
import { fileKey } from "./util";
import { diagnosticsStillValid, lspConfiguration } from "./lspConfig";
import {
  LSP_MONACO_LANGUAGES,
  LSP_SERVER_LABEL,
  LSP_SERVER_SHORT,
  lspMarkerOwner,
  lspTargetForPath,
  type LspServerId,
} from "./lspRegistry";

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
  server: LspServerId;
  owner: string;
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
  /** El servidor nativo de TypeScript 7 no envía diagnósticos: hay que pedirlos (`textDocument/diagnostic`). */
  pull: boolean;
  /** Un cambio en un archivo puede cambiar los errores de otros: se vuelven a pedir los de todos. */
  pullInterFile: boolean;
  pullQueue: Set<monaco.editor.ITextModel>;
  pullTimer: number;
};
/** Respuesta de `lsp_start`: qué servidor quedó en marcha. */
type Started = { id: number; mode: "native" | "compat" | "external"; tsserver: string | null; notice: string | null };
const sessions = new Map<LspServerId, Session>();
const startingServers = new Map<LspServerId, Promise<void>>();
const failedServers = new Set<LspServerId>();
let generation = 0;
let transition: Promise<void> = Promise.resolve();
let workspaceRoot: string | null = null;
let listenersReady: Promise<void> | null = null;
let inlayRefresh: monaco.Emitter<void> | null = null;
const defaults = [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults];

function builtIn(enabled: boolean) {
  for (const d of defaults)
    d.setModeConfiguration({
      completionItems: enabled,
      hovers: enabled,
      definitions: enabled,
      references: enabled,
      diagnostics: enabled,
      rename: enabled,
      documentSymbols: true,
      documentHighlights: true,
      documentRangeFormattingEdits: true,
      signatureHelp: true,
      onTypeFormattingEdits: true,
      codeActions: true,
      inlayHints: true,
    });
}
const targetOf = (model: monaco.editor.ITextModel) => lspTargetForPath(model.uri.path);
const uri = (model: monaco.editor.ITextModel) => model.uri.toString();
const pos = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const range = (r: Json): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

function syncLspStatus() {
  if (!workspaceRoot) {
    setLspState({ kind: "off" });
    return;
  }
  const ready = [...sessions.values()].filter((s) => s.ready).map((s) => LSP_SERVER_SHORT[s.server]);
  if (ready.length) {
    setLspState({ kind: "ready", servers: ready });
    return;
  }
  if (startingServers.size > 0) {
    setLspState({ kind: "starting" });
    return;
  }
}

function sessionById(id: number): Session | null {
  for (const s of sessions.values()) if (s.id === id) return s;
  return null;
}

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
    const timer = window.setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(t("LSP: tiempo agotado ({method})", { method })));
    }, 15000);
    s.pending.set(id, { resolve, reject, timer });
    token?.onCancellationRequested(() => {
      if (s.pending.delete(id)) {
        clearTimeout(timer);
        notify(s, "$/cancelRequest", { id });
        resolve(null);
      }
    });
    void send(s, { jsonrpc: "2.0", id, method, params }).catch((e) => {
      if (s.pending.delete(id)) {
        clearTimeout(timer);
        reject(e);
      }
      fail(s, String(e));
    });
  });
}
function setMarkers(s: Session, model: monaco.editor.ITextModel, diagnostics: Json[]) {
  monaco.editor.setModelMarkers(
    model,
    s.owner,
    diagnostics.map((d: Json) => ({
      ...range(d.range),
      message: d.message,
      severity:
        [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][
          (d.severity ?? 1) - 1
        ] ?? monaco.MarkerSeverity.Error,
      code: d.code === undefined ? undefined : String(d.code),
      source: d.source,
    })),
  );
}
/** Pide los diagnósticos poco después del último cambio. Sin `model`, los de todos los abiertos. */
function schedulePull(s: Session, model?: monaco.editor.ITextModel) {
  if (!s.pull) return;
  if (model && !s.pullInterFile) s.pullQueue.add(model);
  else for (const m of monaco.editor.getModels()) if (s.models.has(uri(m))) s.pullQueue.add(m);
  clearTimeout(s.pullTimer);
  s.pullTimer = window.setTimeout(() => {
    const models = [...s.pullQueue];
    s.pullQueue.clear();
    for (const m of models) void pullDiagnostics(s, m);
  }, 300);
}
async function pullDiagnostics(s: Session, model: monaco.editor.ITextModel) {
  if (sessions.get(s.server) !== s || model.isDisposed() || !s.models.has(uri(model))) return;
  const version = model.getVersionId();
  const result = await request(s, "textDocument/diagnostic", { textDocument: { uri: uri(model) } }).catch(() => null);
  // Si el documento cambió mientras tanto, ya hay otra petición en camino con la versión nueva.
  if (sessions.get(s.server) !== s || !diagnosticsStillValid(version, model.isDisposed() ? -1 : model.getVersionId(), model.isDisposed()))
    return;
  if (result?.kind === "full" && Array.isArray(result.items)) setMarkers(s, model, result.items);
}
function clear(s: Session) {
  clearTimeout(s.pullTimer);
  s.pullQueue.clear();
  for (const p of s.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(t("Servidor LSP cerrado")));
  }
  s.pending.clear();
  for (const d of s.models.values()) d.dispose();
  s.models.clear();
  for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, s.owner, []);
}
function fail(s: Session, error: string) {
  if (sessions.get(s.server) !== s) return;
  sessions.delete(s.server);
  failedServers.add(s.server);
  clear(s);
  if (s.server === "typescript") builtIn(true);
  if (sessions.size === 0) setLspState({ kind: "stopped", reason: error });
  else syncLspStatus();
  setStatus(t("Inteligencia de proyecto no disponible: {error}", { error }), 12000);
  const key = s.server;
  transition = transition
    .catch(() => {})
    .then(async () => {
      if (!sessions.has(key)) await invoke("lsp_stop", { server: key }).catch(() => {});
    });
}
function openModel(s: Session, model: monaco.editor.ITextModel) {
  const target = targetOf(model);
  if (!s.ready || !target || target.server !== s.server || model.uri.scheme !== "file" || s.models.has(uri(model))) return;
  const documentUri = uri(model);
  s.openedAt.set(documentUri, Date.now());
  notify(s, "textDocument/didOpen", {
    textDocument: { uri: documentUri, languageId: target.languageId, version: model.getVersionId(), text: model.getValue() },
  });
  const change = model.onDidChangeContent((event) => {
    s.definitions.clear();
    const contentChanges =
      s.incremental && !event.isFlush && !event.isEolChange
        ? event.changes.map((c) => ({
            range: {
              start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
              end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
            },
            text: c.text,
          }))
        : [{ text: model.getValue() }];
    notify(s, "textDocument/didChange", { textDocument: { uri: documentUri, version: model.getVersionId() }, contentChanges });
    schedulePull(s, model);
  });
  const dispose = model.onWillDispose(() => {
    change.dispose();
    dispose.dispose();
    s.models.delete(documentUri);
    s.openedAt.delete(documentUri);
    notify(s, "textDocument/didClose", { textDocument: { uri: documentUri } });
  });
  s.models.set(documentUri, {
    dispose: () => {
      change.dispose();
      dispose.dispose();
    },
  });
  schedulePull(s, model);
}
function handleMessage(id: number, msg: Json) {
  const s = sessionById(id);
  if (!s || !msg || typeof msg !== "object") return;
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
    if (msg.method === "workspace/diagnostic/refresh") schedulePull(s);
    const result =
      msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map((item: Json) => lspConfiguration(item?.section)) : null;
    void send(s, { jsonrpc: "2.0", id: msg.id, result });
  } else if (msg.method === "textDocument/publishDiagnostics") {
    const resource = monaco.Uri.parse(msg.params.uri);
    const model = monaco.editor.getModel(resource) ?? findOpenDoc(resource.fsPath)?.model;
    if (!model || !Array.isArray(msg.params.diagnostics)) return;
    if (typeof msg.params.version === "number" && msg.params.version < model.getVersionId()) return;
    setMarkers(s, model, msg.params.diagnostics);
  } else if (msg.id !== undefined && !msg.method) {
    const p = s.pending.get(msg.id);
    if (!p) return;
    s.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
}
async function ensureListeners() {
  if (!listenersReady)
    listenersReady = (async () => {
      await listen<{ id: number; message: Json }>("lsp-message", (e) => handleMessage(e.payload.id, e.payload.message));
      await listen<{ id: number; error: string }>("lsp-exit", (e) => {
        const s = sessionById(e.payload.id);
        if (s) fail(s, e.payload.error);
      });
    })();
  await listenersReady;
}

function startServer(server: LspServerId, root: string, current: number): Promise<void> {
  if (sessions.has(server) || startingServers.has(server) || failedServers.has(server)) {
    return startingServers.get(server) ?? Promise.resolve();
  }
  const job = (async () => {
    await ensureListeners();
    if (current !== generation) return;
    const args = server === "typescript" ? { root } : { root, server };
    const started = await invoke<Started>("lsp_start", args);
    if (current !== generation) {
      await invoke("lsp_stop", { server }).catch(() => {});
      return;
    }
    const s: Session = {
      id: started.id,
      server,
      owner: lspMarkerOwner(server),
      root,
      ready: false,
      incremental: false,
      caps: {
        signatureHelp: false,
        codeAction: false,
        codeActionResolve: false,
        inlayHint: false,
        documentSymbol: false,
        formatting: true,
        executeCommand: false,
      },
      next: 0,
      pending: new Map(),
      send: Promise.resolve(),
      models: new Map(),
      openedAt: new Map(),
      definitions: new Map(),
      pull: false,
      pullInterFile: false,
      pullQueue: new Set(),
      pullTimer: 0,
    };
    sessions.set(server, s);
    try {
      const rootUri = monaco.Uri.file(root).toString();
      const hostPid = await invoke<number>("lsp_host_pid").catch(() => null);
      const initOpts =
        server === "typescript"
          ? {
              hostInfo: "Pulso",
              // Modo compatible (TypeScript 5 o 6 del proyecto): typescript-language-server usa ese tsserver.
              ...(started.tsserver ? { tsserver: { path: started.tsserver } } : {}),
              disableAutomaticTypingAcquisition: true,
              maxTsServerMemory: 1536,
              preferences: {
                includeInlayParameterNameHints: "literals",
                includeInlayParameterNameHintsWhenArgumentMatchesName: false,
                includeInlayEnumMemberValueHints: true,
              },
            }
          : undefined;
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
            diagnostics: { refreshSupport: true },
            workspaceEdit: { documentChanges: true },
          },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false },
            completion: {
              completionItem: { snippetSupport: true, resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } },
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            signatureHelp: {
              signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } },
              contextSupport: true,
            },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    "",
                    "quickfix",
                    "refactor",
                    "refactor.extract",
                    "refactor.inline",
                    "refactor.rewrite",
                    "source",
                    "source.organizeImports",
                    "source.fixAll",
                  ],
                },
              },
              resolveSupport: { properties: ["edit", "command"] },
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            inlayHint: { resolveSupport: { properties: ["tooltip", "textEdits"] } },
            rename: { prepareSupport: true },
            formatting: {},
          },
        },
        ...(initOpts ? { initializationOptions: initOpts } : {}),
      });
      if (sessions.get(server) !== s || current !== generation) return;
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
      s.pull = !!caps?.diagnosticProvider;
      s.pullInterFile = !!caps?.diagnosticProvider?.interFileDependencies;
      notify(s, "initialized", {});
      s.ready = true;
      if (server === "typescript") builtIn(false);
      syncLspStatus();
      for (const model of monaco.editor.getModels()) openModel(s, model);
      if (started.notice) setStatus(started.notice, 15000);
      else if (server === "typescript") {
        setStatus(
          started.mode === "compat"
            ? t("Inteligencia de TypeScript y JavaScript activada (con el TypeScript del proyecto)")
            : t("Inteligencia de TypeScript y JavaScript activada"),
        );
      } else {
        setStatus(t("Inteligencia de {lang} activada", { lang: LSP_SERVER_LABEL[server] }), 5000);
      }
    } catch (e) {
      fail(s, String(e));
    }
  })()
    .catch((e) => {
      if (current !== generation) return;
      failedServers.add(server);
      if (server === "typescript") builtIn(true);
      if (sessions.size === 0) setLspState({ kind: "stopped", reason: String(e) });
      else syncLspStatus();
      setStatus(
        String(e).startsWith(t("No se pudo iniciar")) || server !== "typescript"
          ? String(e)
          : t("No se pudo iniciar LSP: {error}", { error: String(e) }),
        10000,
      );
    })
    .finally(() => {
      if (startingServers.get(server) === job) startingServers.delete(server);
    });
  startingServers.set(server, job);
  return job;
}

/** Cambiar de carpeta cierra los servidores anteriores y sincroniza los modelos ya abiertos. */
export function setLspWorkspace(root: string | null) {
  workspaceRoot = root;
  const current = ++generation;
  for (const prev of sessions.values()) clear(prev);
  sessions.clear();
  startingServers.clear();
  failedServers.clear();
  builtIn(true);
  setLspState(root ? { kind: "starting" } : { kind: "off" });
  transition = transition
    .catch(() => {})
    .then(async () => {
      await invoke("lsp_stop");
      if (!root || current !== generation) return;
      await startServer("typescript", root, current);
      if (current !== generation) return;
      const extraServers = new Set<LspServerId>();
      for (const model of monaco.editor.getModels()) {
        const target = targetOf(model);
        if (target && target.server !== "typescript") extraServers.add(target.server);
      }
      for (const srv of extraServers) void startServer(srv, root, current);
    });
}

function active(model: monaco.editor.ITextModel): Session | null {
  const target = targetOf(model);
  if (!target) return null;
  const s = sessions.get(target.server);
  return s?.ready && s.models.has(uri(model)) ? s : null;
}
function params(model: monaco.editor.ITextModel, position: monaco.Position) {
  return { textDocument: { uri: uri(model) }, position: pos(position) };
}
function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback);
}
const completionKinds = [
  monaco.languages.CompletionItemKind.Text,
  monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function,
  monaco.languages.CompletionItemKind.Constructor,
  monaco.languages.CompletionItemKind.Field,
  monaco.languages.CompletionItemKind.Variable,
  monaco.languages.CompletionItemKind.Class,
  monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module,
  monaco.languages.CompletionItemKind.Property,
  monaco.languages.CompletionItemKind.Unit,
  monaco.languages.CompletionItemKind.Value,
  monaco.languages.CompletionItemKind.Enum,
  monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet,
  monaco.languages.CompletionItemKind.Color,
  monaco.languages.CompletionItemKind.File,
  monaco.languages.CompletionItemKind.Reference,
  monaco.languages.CompletionItemKind.Folder,
  monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant,
  monaco.languages.CompletionItemKind.Struct,
  monaco.languages.CompletionItemKind.Event,
  monaco.languages.CompletionItemKind.Operator,
  monaco.languages.CompletionItemKind.TypeParameter,
];
function markdown(value: Json): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markdown).join("\n\n");
  return value?.language ? `\`\`\`${value.language}\n${value.value}\n\`\`\`` : (value?.value ?? "");
}
function locations(value: Json): monaco.languages.LocationLink[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .filter((x: Json) => x.uri || x.targetUri)
    .map((x: Json) => ({
      uri: monaco.Uri.parse(x.uri ?? x.targetUri),
      range: range(x.range ?? x.targetRange),
      targetSelectionRange: x.targetSelectionRange ? range(x.targetSelectionRange) : undefined,
      originSelectionRange: x.originSelectionRange ? range(x.originSelectionRange) : undefined,
    }));
}

/** Espera el arranque y comparte la consulta del subrayado con el clic posterior. */
async function definition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  indicate: boolean,
): Promise<monaco.languages.LocationLink[] | null> {
  const started = generation;
  const target = targetOf(model);
  if (!active(model) && target && workspaceRoot) {
    if (indicate) setStatus(t("Iniciando inteligencia de código…"));
    await transition;
    if (startingServers.has(target.server)) await startingServers.get(target.server);
  }
  if (started !== generation || model.isDisposed()) return null;
  const s = active(model);
  if (!s) return null;
  const word = model.getWordAtPosition(position);
  const at = word ? ({ lineNumber: position.lineNumber, column: word.startColumn } as monaco.Position) : position;
  const key = `${uri(model)}:${model.getVersionId()}:${at.lineNumber}:${at.column}`;
  let promise = s.definitions.get(key);
  if (!promise) {
    promise = (async () => {
      let found: monaco.languages.LocationLink[] = [];
      const cold = Date.now() - (s.openedAt.get(uri(model)) ?? 0) < 12_000;
      for (const delay of cold ? [0, 200, 400, 800, 1200, 1800] : [0]) {
        if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
        if (sessions.get(s.server) !== s || model.isDisposed()) return [];
        found = locations(await request(s, "textDocument/definition", params(model, at)));
        const first = found[0];
        const selection = first?.targetSelectionRange ?? first?.range;
        // Al arrancar tsserver puede devolver solo el import local mientras carga el proyecto.
        const localImport =
          first &&
          selection &&
          fileKey(first.uri.fsPath) === fileKey(model.uri.fsPath) &&
          /^\s*import\b/.test(model.getLineContent(selection.startLineNumber));
        if (first && !localImport) break;
        if (localImport) found = [];
      }
      return found;
    })();
    s.definitions.set(key, promise);
    if (s.definitions.size > 100) s.definitions.delete(s.definitions.keys().next().value!);
    void promise.then(
      (found) => {
        if (!found.length && s.definitions.get(key) === promise) s.definitions.delete(key);
      },
      () => {
        if (s.definitions.get(key) === promise) s.definitions.delete(key);
      },
    );
  }
  if (indicate) setStatus(t("Buscando definición…"));
  return promise;
}

const slash = (p: string) => p.replace(/\\/g, "/");
const lspRange = (r: monaco.IRange) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const lspSeverity = (s: number) => (s === 8 ? 1 : s === 4 ? 2 : s === 2 ? 3 : 4);
const EXEC_CMD = "pulso.lsp.executeCommand";

function bridgeCommand(cmd: Json, server?: LspServerId): monaco.languages.Command | undefined {
  if (!cmd || typeof cmd.command !== "string") return undefined;
  return {
    id: EXEC_CMD,
    title: typeof cmd.title === "string" ? cmd.title : cmd.command,
    arguments: [cmd.command, Array.isArray(cmd.arguments) ? cmd.arguments : [], server ?? "typescript"],
  };
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
    try {
      await invoke("write_file", { path: f.path, contents: f.text, expectedMtime: f.mtime });
      written.push(f.path);
    } catch (e) {
      const done = written.length
        ? " " + t("Ya se escribieron: {files}.", { files: written.map((w) => w.split("/").pop()).join(", ") })
        : "";
      throw new Error(
        t("No se pudo escribir {file}: {error}.", {
          file: f.path.split("/").pop()!,
          error: String(e).replace(/^CONFLICT$/, t("cambió en el disco")),
        }) + done,
      );
    }
  }
}

async function prepareWorkspaceEdits(workspaceEdit: Json) {
  const byUri = collectEdits(workspaceEdit);
  const openEdits: {
    model: monaco.editor.ITextModel;
    edit: monaco.languages.IWorkspaceTextEdit;
    textEdit: monaco.editor.ISingleEditOperation;
  }[] = [];
  const closed: { path: string; text: string; mtime: number }[] = [];
  for (const [u, list] of byUri) {
    const target = monaco.Uri.parse(u);
    if (target.scheme !== "file")
      throw new Error(t("El servidor pidió editar un recurso que no es un archivo ({uri})", { uri: String(u) }));
    const path = slash(target.fsPath);
    const open = findOpenDoc(path);
    const model = open?.model ?? monaco.editor.getModel(target);
    if (model) {
      for (const e of list) {
        const rg = range(e.range);
        openEdits.push({
          model,
          edit: { resource: model.uri, textEdit: { range: rg, text: e.newText }, versionId: undefined },
          textEdit: { range: rg, text: e.newText },
        });
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
async function renameEdits(
  s: Session,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  newName: string,
  token: monaco.CancellationToken,
): Promise<monaco.languages.WorkspaceEdit & monaco.languages.Rejection> {
  const result = await request(s, "textDocument/rename", { ...params(model, position), newName }, token);
  const { files, openEdits, closed } = await prepareWorkspaceEdits(result);
  if (token.isCancellationRequested) return { edits: [] };
  await writeClosedEdits(closed);
  const edits = openEdits.map((o) => o.edit);
  setStatus(
    (files === 1 ? t("Renombrado en 1 archivo") : t("Renombrado en {count} archivos", { count: files })) +
      (closed.length
        ? " " + (closed.length === 1 ? t("(1 guardado en disco)") : t("({count} guardados en disco)", { count: closed.length }))
        : "") +
      (edits.length ? ". " + t("Los archivos abiertos quedan sin guardar") : ""),
    6000,
  );
  return { edits };
}

/** Ediciones de formato que propone el servidor para todo el documento. */
async function formatEdits(
  s: Session,
  model: monaco.editor.ITextModel,
  token?: monaco.CancellationToken,
): Promise<monaco.languages.TextEdit[]> {
  const o = model.getOptions();
  const edits = await request(
    s,
    "textDocument/formatting",
    { textDocument: { uri: uri(model) }, options: { tabSize: o.tabSize, insertSpaces: o.insertSpaces } },
    token,
  );
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
      children: Array.isArray(x.children)
        ? x.children.map(mapOne).filter((c: Json): c is monaco.languages.DocumentSymbol => !!c)
        : undefined,
    };
  };
  return items.map(mapOne).filter((s): s is monaco.languages.DocumentSymbol => !!s);
}

function toCodeAction(raw: Json, server: LspServerId): monaco.languages.CodeAction & { _lsp?: Json; _server?: LspServerId } {
  if (raw && typeof raw.command === "string" && !raw.edit && !raw.kind) {
    return { title: String(raw.title ?? raw.command), command: bridgeCommand(raw, server), _lsp: raw, _server: server };
  }
  return {
    title: String(raw?.title ?? t("Acción")),
    kind: typeof raw?.kind === "string" ? raw.kind : undefined,
    isPreferred: raw?.isPreferred === true,
    disabled: typeof raw?.disabled?.reason === "string" ? raw.disabled.reason : undefined,
    edit: raw?.edit ? toMonacoWorkspaceEdit(raw.edit) : undefined,
    command: raw?.command ? bridgeCommand(raw.command, server) : undefined,
    _lsp: raw,
    _server: server,
  };
}

function toInlayHints(raw: Json, server: LspServerId): monaco.languages.InlayHint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h: Json) => h?.position)
    .map((h: Json) => ({
      position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
      label: Array.isArray(h.label)
        ? h.label.map((p: Json) => ({
            label: String(p.value ?? p.label ?? ""),
            tooltip: p.tooltip ? { value: markdown(p.tooltip) } : undefined,
            command: p.command ? bridgeCommand(p.command, server) : undefined,
          }))
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
  monaco.editor.registerCommand?.(EXEC_CMD, (_accessor, command: string, args?: unknown[], server: LspServerId = "typescript") => {
    const s = sessions.get(server) ?? sessions.get("typescript");
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
      setStatus(t("No se encontró una definición para este símbolo"));
      return true;
    }
    const selection = target.targetSelectionRange ?? target.range;
    await openFile(target.uri.fsPath.replace(/\\/g, "/"), { line: selection.startLineNumber, col: selection.startColumn });
    return true;
  };
  monaco.editor.onDidCreateModel((model) => {
    const target = targetOf(model);
    if (!target) return;
    const s = sessions.get(target.server);
    if (s) openModel(s, model);
    else if (workspaceRoot && !failedServers.has(target.server)) void startServer(target.server, workspaceRoot, generation);
  });
  // «Formatear al guardar»: si el texto cambió mientras el servidor respondía, las ediciones ya no encajan y se descartan.
  setBeforeSave(async (d) => {
    const s = active(d.model);
    if (!s || !s.caps.formatting) return;
    const version = d.model.getVersionId();
    const edits = await Promise.race([
      formatEdits(s, d.model),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(t("el servidor tardó demasiado"))), 4000)),
    ]);
    if (!edits.length || d.model.getVersionId() !== version) return;
    d.model.pushEditOperations([], edits, () => null);
  });
  onDocSaved((path) => {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    const s = model ? active(model) : null;
    if (s && model) notify(s, "textDocument/didSave", { textDocument: { uri: uri(model) } });
  });
  monaco.editor.registerEditorOpener({
    openCodeEditor: async (_source, resource, selection) => {
      if (resource.scheme !== "file") return false;
      const start =
        selection &&
        ("startLineNumber" in selection
          ? { line: selection.startLineNumber, col: selection.startColumn }
          : { line: selection.lineNumber, col: selection.column });
      await openFile(resource.fsPath.replace(/\\/g, "/"), start || {});
      return true;
    },
  });
  for (const lang of LSP_MONACO_LANGUAGES) {
    monaco.languages.registerHoverProvider(lang, {
      provideHover: (model, position, token) => {
        const s = active(model);
        if (!s) return null;
        return safe(
          request(s, "textDocument/hover", params(model, position), token).then((v) =>
            v ? { range: v.range ? range(v.range) : undefined, contents: [{ value: markdown(v.contents) }] } : null,
          ),
          null,
        );
      },
    });
    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: (model, position, token) => {
        const s = active(model);
        return s ? safe(request(s, "textDocument/definition", params(model, position), token).then(locations), []) : null;
      },
    });
    monaco.languages.registerReferenceProvider(lang, {
      provideReferences: (model, position, context, token) => {
        const s = active(model);
        return s ? safe(request(s, "textDocument/references", { ...params(model, position), context }, token).then(locations), []) : null;
      },
    });
    // Con esquema además de lenguaje, este proveedor puntúa más que el de Monaco y siempre se prefiere.
    monaco.languages.registerRenameProvider(
      { language: lang, scheme: "file", exclusive: true },
      {
        resolveRenameLocation: async (model, position, token) => {
          const s = active(model);
          if (!s)
            return {
              range: model.getWordAtPosition(position)
                ? {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: model.getWordAtPosition(position)!.startColumn,
                    endColumn: model.getWordAtPosition(position)!.endColumn,
                  }
                : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              text: "",
              rejectReason: t("La inteligencia de lenguaje no está activa"),
            };
          const r = await safe(request(s, "textDocument/prepareRename", params(model, position), token), null);
          const target = r && (r.range ?? (r.start ? r : null));
          if (!target)
            return {
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              text: "",
              rejectReason: t("No se puede renombrar lo que hay bajo el cursor"),
            };
          const rg = range(target);
          return { range: rg, text: r.placeholder ?? model.getValueInRange(rg) };
        },
        provideRenameEdits: async (model, position, newName, token) => {
          const s = active(model);
          if (!s) return { edits: [], rejectReason: t("La inteligencia de lenguaje no está activa") };
          try {
            return await renameEdits(s, model, position, newName, token);
          } catch (e) {
            return { edits: [], rejectReason: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    );
    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      displayName: t("Servidor de lenguaje"),
      provideDocumentFormattingEdits: (model, _options, token) => {
        const s = active(model);
        return s && s.caps.formatting ? safe(formatEdits(s, model, token), []) : [];
      },
    });
    monaco.languages.registerSignatureHelpProvider?.(lang, {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp: (model, position, token, context) => {
        const s = active(model);
        if (!s || !s.caps.signatureHelp) return null;
        return safe(
          request(
            s,
            "textDocument/signatureHelp",
            {
              ...params(model, position),
              context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger },
            },
            token,
          ).then((v) =>
            v?.signatures?.length
              ? {
                  value: {
                    signatures: v.signatures.map((sig: Json) => ({
                      label: String(sig.label ?? ""),
                      documentation: sig.documentation ? { value: markdown(sig.documentation) } : undefined,
                      parameters: Array.isArray(sig.parameters)
                        ? sig.parameters.map((p: Json) => ({
                            label: p.label,
                            documentation: p.documentation ? { value: markdown(p.documentation) } : undefined,
                          }))
                        : [],
                      activeParameter: typeof sig.activeParameter === "number" ? sig.activeParameter : undefined,
                    })),
                    activeSignature: typeof v.activeSignature === "number" ? v.activeSignature : 0,
                    activeParameter: typeof v.activeParameter === "number" ? v.activeParameter : 0,
                  },
                  dispose() {},
                }
              : null,
          ),
          null,
        );
      },
    });
    monaco.languages.registerCodeActionProvider?.(
      lang,
      {
        provideCodeActions: (model, selRange, context, token) => {
          const s = active(model);
          if (!s || !s.caps.codeAction) return { actions: [], dispose() {} };
          const markers = monaco.editor
            .getModelMarkers({ resource: model.uri })
            .filter((m) => m.endLineNumber >= selRange.startLineNumber && m.startLineNumber <= selRange.endLineNumber);
          const diagnostics = markers.map((m) => ({
            range: lspRange({
              startLineNumber: m.startLineNumber,
              startColumn: m.startColumn,
              endLineNumber: m.endLineNumber,
              endColumn: m.endColumn,
            }),
            message: m.message,
            severity: lspSeverity(m.severity),
            code: typeof m.code === "object" && m.code ? m.code.value : m.code,
            source: m.source,
          }));
          const ctx: Json = { diagnostics, triggerKind: context.trigger === 2 ? 2 : 1 };
          if (context.only) ctx.only = [context.only];
          return safe(
            request(
              s,
              "textDocument/codeAction",
              { textDocument: { uri: uri(model) }, range: lspRange(selRange), context: ctx },
              token,
            ).then((v) => ({
              actions: (Array.isArray(v) ? v : []).map((a: Json) => toCodeAction(a, s.server)),
              dispose() {},
            })),
            { actions: [], dispose() {} },
          );
        },
        resolveCodeAction: (action, token) => {
          const srv = ((action as Json)._server as LspServerId | undefined) ?? "typescript";
          const s = sessions.get(srv);
          const raw = (action as Json)._lsp;
          if (!s?.ready || !s.caps.codeActionResolve || !raw) return action;
          return safe(
            request(s, "codeAction/resolve", raw, token).then((v) => ({
              ...action,
              edit: v?.edit ? toMonacoWorkspaceEdit(v.edit) : action.edit,
              command: v?.command ? bridgeCommand(v.command, srv) : action.command,
            })),
            action,
          );
        },
      },
      { providedCodeActionKinds: ["quickfix", "refactor", "source", "source.organizeImports"] },
    );
    monaco.languages.registerDocumentSymbolProvider?.(lang, {
      displayName: t("Servidor de lenguaje"),
      provideDocumentSymbols: (model, token) => {
        const s = active(model);
        if (!s || !s.caps.documentSymbol) return [];
        return safe(request(s, "textDocument/documentSymbol", { textDocument: { uri: uri(model) } }, token).then(toDocumentSymbols), []);
      },
    });
    monaco.languages.registerInlayHintsProvider?.(lang, {
      displayName: t("Servidor de lenguaje"),
      onDidChangeInlayHints: inlayRefresh?.event,
      provideInlayHints: (model, hintRange, token) => {
        const s = active(model);
        if (!s || !s.caps.inlayHint) return { hints: [], dispose() {} };
        return safe(
          request(s, "textDocument/inlayHint", { textDocument: { uri: uri(model) }, range: lspRange(hintRange) }, token).then((v) => ({
            hints: toInlayHints(v, s.server),
            dispose() {},
          })),
          { hints: [], dispose() {} },
        );
      },
    });
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: [".", '"', "'", "/", "@", ":", ">"],
      provideCompletionItems: (model, position, _context, token) => {
        const s = active(model);
        if (!s) return null;
        const word = model.getWordUntilPosition(position);
        const defaultRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return safe(
          request(s, "textDocument/completion", params(model, position), token).then((v) => ({
            suggestions: (Array.isArray(v) ? v : (v?.items ?? [])).map((item: Json) => ({
              label: item.label,
              kind: completionKinds[(item.kind ?? 1) - 1] ?? monaco.languages.CompletionItemKind.Text,
              detail: item.detail,
              documentation: item.documentation ? { value: markdown(item.documentation) } : undefined,
              sortText: item.sortText,
              filterText: item.filterText,
              insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
              insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: item.textEdit?.range ? range(item.textEdit.range) : defaultRange,
              additionalTextEdits: item.additionalTextEdits?.map((e: Json) => ({ range: range(e.range), text: e.newText })),
              _lsp: item,
              _server: s.server,
            })),
            incomplete: !!v?.isIncomplete,
          })),
          { suggestions: [] },
        );
      },
      resolveCompletionItem: (item, token) => {
        const srv = ((item as Json)._server as LspServerId | undefined) ?? "typescript";
        const s = sessions.get(srv);
        const raw = (item as Json)._lsp;
        if (!s?.ready || !raw) return item;
        return safe(
          request(s, "completionItem/resolve", raw, token).then((v) => ({
            ...item,
            detail: v.detail ?? item.detail,
            documentation: v.documentation ? { value: markdown(v.documentation) } : item.documentation,
            additionalTextEdits:
              v.additionalTextEdits?.map((e: Json) => ({ range: range(e.range), text: e.newText })) ?? item.additionalTextEdits,
          })),
          item,
        );
      },
    });
  }
}
