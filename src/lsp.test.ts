import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const handlers = new Map<string, (event: any) => void>();
  const sent: any[] = [];
  const providers: Record<string, any> = {};
  const commands: Record<string, (...args: any[]) => any> = {};
  const markers = vi.fn();
  const pushEditOperations = vi.fn();
  const definitionResults: any[] = [];
  const serverCaps: Record<string, any> = {
    textDocumentSync: { change: 2 },
    signatureHelpProvider: { triggerCharacters: ["(", ","] },
    codeActionProvider: { resolveProvider: true },
    documentSymbolProvider: true,
    inlayHintProvider: true,
    documentFormattingProvider: true,
    executeCommandProvider: { commands: ["_typescript.organizeImports"] },
  };
  const line = { text: "const saludo = 1;" };
  let change: ((event: any) => void) | undefined;
  const model = {
    uri: { scheme: "file", path: "/c:/project/main.ts", fsPath: "C:\\project\\main.ts", toString: () => "file:///c%3A/project/main.ts" },
    getVersionId: () => 1,
    getValue: () => "const saludo = 1;",
    isDisposed: () => false,
    getLineContent: () => line.text,
    getWordAtPosition: () => ({ word: "saludo", startColumn: 2, endColumn: 8 }),
    getWordUntilPosition: () => ({ startColumn: 7, endColumn: 13 }),
    pushEditOperations,
    onDidChangeContent: (f: (event: any) => void) => {
      change = f;
      return { dispose() {} };
    },
    onWillDispose: () => ({ dispose() {} }),
  };
  const defaults = { setModeConfiguration: vi.fn() };
  return {
    handlers,
    sent,
    providers,
    commands,
    markers,
    pushEditOperations,
    model,
    defaults,
    definitionResults,
    serverCaps,
    line,
    triggerChange: () =>
      change?.({ isFlush: false, changes: [{ range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 }, text: "x" }] }),
  };
});

vi.mock("monaco-editor", () => ({
  Emitter: class {
    private ls: (() => void)[] = [];
    event = (cb: () => void) => {
      this.ls.push(cb);
      return { dispose() {} };
    };
    fire() {
      this.ls.forEach((f) => f());
    }
  },
  Uri: {
    file: () => h.model.uri,
    parse: (value: string) =>
      value.includes("other.ts") ? { scheme: "file", fsPath: "C:\\project\\other.ts", toString: () => value } : h.model.uri,
  },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  editor: {
    getModels: () => [h.model],
    getModel: vi.fn(() => h.model),
    setModelMarkers: h.markers,
    getModelMarkers: () => [
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6, message: "error", severity: 8, code: "2304", source: "ts" },
    ],
    registerCommand: (id: string, fn: (...args: any[]) => any) => {
      h.commands[id] = fn;
      return { dispose() {} };
    },
    onDidCreateModel: vi.fn(),
    registerEditorOpener: vi.fn(),
  },
  languages: {
    typescript: { typescriptDefaults: h.defaults, javascriptDefaults: h.defaults },
    CompletionItemKind: new Proxy({}, { get: () => 1 }),
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerHoverProvider: (_: string, p: unknown) => {
      h.providers.hover = p;
    },
    registerDefinitionProvider: (_: string, p: unknown) => {
      h.providers.definition = p;
    },
    registerReferenceProvider: (_: string, p: unknown) => {
      h.providers.references = p;
    },
    registerCompletionItemProvider: (_: string, p: unknown) => {
      h.providers.completion = p;
    },
    registerRenameProvider: (_: unknown, p: unknown) => {
      h.providers.rename = p;
    },
    registerDocumentFormattingEditProvider: (_: string, p: unknown) => {
      h.providers.formatting = p;
    },
    registerSignatureHelpProvider: (_: string, p: unknown) => {
      h.providers.signatureHelp = p;
    },
    registerCodeActionProvider: (_: string, p: unknown) => {
      h.providers.codeAction = p;
    },
    registerDocumentSymbolProvider: (_: string, p: unknown) => {
      h.providers.documentSymbol = p;
    },
    registerInlayHintsProvider: (_: string, p: unknown) => {
      h.providers.inlayHints = p;
    },
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: any) => void) => {
    h.handlers.set(name, callback);
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: any) => {
    if (command === "lsp_start") return { id: 1, mode: "native", tsserver: null, notice: null };
    if (command === "lsp_send") {
      h.sent.push(args.message);
      if (args.message.id !== undefined && args.message.method) {
        const m = args.message.method;
        const result =
          m === "initialize"
            ? { capabilities: h.serverCaps }
            : m === "textDocument/definition"
              ? (h.definitionResults.shift() ?? [
                  { uri: "file:///c%3A/project/other.ts", range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } } },
                ])
              : m === "textDocument/hover"
                ? { contents: { kind: "markdown", value: "const saludo: number" } }
                : m === "textDocument/signatureHelp"
                  ? {
                      signatures: [{ label: "fn(a: number)", parameters: [{ label: "a: number" }] }],
                      activeSignature: 0,
                      activeParameter: 0,
                    }
                  : m === "textDocument/codeAction"
                    ? [
                        {
                          title: "Importar 'foo'",
                          kind: "quickfix",
                          isPreferred: true,
                          edit: {
                            changes: {
                              [h.model.uri.toString()]: [
                                {
                                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                                  newText: "import { foo } from './foo';\n",
                                },
                              ],
                            },
                          },
                        },
                      ]
                    : m === "codeAction/resolve"
                      ? {
                          ...args.message.params,
                          command: { title: "Aplicar", command: "_typescript.organizeImports", arguments: ["C:\\project\\main.ts"] },
                        }
                      : m === "textDocument/documentSymbol"
                        ? [
                            {
                              name: "saludar",
                              detail: "() => void",
                              kind: 12,
                              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
                              selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } },
                              children: [],
                            },
                          ]
                        : m === "textDocument/inlayHint"
                          ? [{ position: { line: 0, character: 10 }, label: "a:", kind: 2, paddingRight: true }]
                          : m === "textDocument/diagnostic"
                            ? {
                                kind: "full",
                                items: [
                                  {
                                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                                    message: "Type 'number' is not assignable to type 'string'.",
                                    severity: 1,
                                    code: 2322,
                                    source: "ts",
                                  },
                                ],
                              }
                            : {};
        queueMicrotask(() =>
          h.handlers.get("lsp-message")?.({ payload: { id: 1, message: { jsonrpc: "2.0", id: args.message.id, result } } }),
        );
      }
    }
  },
}));
vi.mock("./docs", () => ({ onDocSaved: vi.fn(), findOpenDoc: vi.fn(), setBeforeSave: vi.fn() }));
vi.mock("./groups", () => ({ config: {}, openFile: vi.fn() }));
vi.mock("./ui", () => ({ setStatus: vi.fn() }));

import { initLsp, setLspWorkspace } from "./lsp";
import { config, openFile } from "./groups";

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  (window as any).__TAURI_INTERNALS__ = {};
});

describe("cliente LSP", () => {
  it("sincroniza el modelo, convierte diagnósticos y navega a definiciones", async () => {
    initLsp();
    setLspWorkspace("C:/project");
    // Un clic inmediato espera la inicialización y el didOpen, sin caer a Monaco.
    const early = config.goToDefinition!(h.model as any, { lineNumber: 1, column: 2 } as any);
    expect(await early).toBe(true);
    expect(openFile).toHaveBeenCalledWith("C:/project/other.ts", { line: 3, col: 4 });
    expect(h.sent.findIndex((m) => m.method === "textDocument/didOpen")).toBeLessThan(
      h.sent.findIndex((m) => m.method === "textDocument/definition"),
    );
    const requestsBeforeProbe = h.sent.filter((m) => m.method === "textDocument/definition").length;
    expect(await config.probeDefinition!(h.model as any, { lineNumber: 1, column: 3 } as any)).toBe(true);
    expect(h.sent.filter((m) => m.method === "textDocument/definition")).toHaveLength(requestsBeforeProbe);
    vi.mocked(openFile).mockClear();
    expect(await config.goToDefinition!(h.model as any, { lineNumber: 1, column: 3 } as any, () => false)).toBe(true);
    expect(openFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === "textDocument/didOpen")).toBe(true));
    h.triggerChange();
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === "textDocument/didChange")).toBe(true));
    expect(h.sent.find((m) => m.method === "textDocument/didChange").params.contentChanges).toEqual([
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, text: "x" },
    ]);
    const monaco = await import("monaco-editor");
    const docs = await import("./docs");
    vi.mocked(monaco.editor.getModel).mockReturnValueOnce(null);
    vi.mocked(docs.findOpenDoc).mockReturnValueOnce({ model: h.model } as any);
    h.handlers.get("lsp-message")!({
      payload: {
        id: 1,
        message: {
          method: "textDocument/publishDiagnostics",
          params: {
            uri: h.model.uri.toString(),
            version: 1,
            diagnostics: [
              { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, message: "error", severity: 1, code: 123 },
            ],
          },
        },
      },
    });
    expect(h.markers).toHaveBeenCalledWith(h.model, "pulso-lsp", [
      expect.objectContaining({ startLineNumber: 2, startColumn: 3, message: "error", code: "123" }),
    ]);
    const result = await h.providers.definition.provideDefinition(
      h.model,
      { lineNumber: 1, column: 2 },
      { onCancellationRequested: () => ({ dispose() {} }) },
    );
    expect(result[0].range).toEqual({ startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 9 });
    const hover = await h.providers.hover.provideHover(
      h.model,
      { lineNumber: 1, column: 2 },
      { onCancellationRequested: () => ({ dispose() {} }) },
    );
    expect(hover.contents[0].value).toContain("const saludo: number");
    expect(await config.goToDefinition!(h.model as any, { lineNumber: 1, column: 2 } as any)).toBe(true);
    expect(openFile).toHaveBeenCalledWith("C:/project/other.ts", { line: 3, col: 4 });
    // Mientras TypeScript carga el proyecto, una respuesta al import local no debe ganar al destino real.
    h.triggerChange();
    h.line.text = "import { saludo } from './other';";
    h.definitionResults.push([
      { uri: h.model.uri.toString(), range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } } },
    ]);
    vi.mocked(openFile).mockClear();
    expect(await config.goToDefinition!(h.model as any, { lineNumber: 1, column: 2 } as any)).toBe(true);
    expect(openFile).toHaveBeenCalledWith("C:/project/other.ts", { line: 3, col: 4 });
    h.line.text = "const saludo = 1;";
    setLspWorkspace(null);
  });

  it("con el servidor nativo pide los diagnósticos y da la configuración de inlay hints", async () => {
    h.sent.length = 0;
    h.markers.mockClear();
    const caps = { ...h.serverCaps };
    h.serverCaps.diagnosticProvider = { interFileDependencies: true, workspaceDiagnostics: false };
    try {
      initLsp();
      setLspWorkspace("C:/project");
      await vi.waitFor(() => expect(h.sent.some((m) => m.method === "textDocument/diagnostic")).toBe(true), { timeout: 2000 });
      await vi.waitFor(() =>
        expect(h.markers).toHaveBeenCalledWith(h.model, "pulso-lsp", [
          expect.objectContaining({ startLineNumber: 1, startColumn: 7, code: "2322" }),
        ]),
      );
      const init = h.sent.find((m) => m.method === "initialize");
      expect(init.params.capabilities.textDocument.diagnostic).toBeDefined();
      expect(init.params.initializationOptions.tsserver).toBeUndefined();
      // El servidor pide su configuración: las secciones de TypeScript reciben los ajustes de inlay hints.
      h.handlers.get("lsp-message")!({
        payload: {
          id: 1,
          message: {
            jsonrpc: "2.0",
            id: 900,
            method: "workspace/configuration",
            params: { items: [{ section: "typescript" }, { section: "editor" }] },
          },
        },
      });
      await vi.waitFor(() => expect(h.sent.some((m) => m.id === 900)).toBe(true));
      const answer = h.sent.find((m) => m.id === 900).result;
      expect(answer[0].inlayHints.parameterNames.enabled).toBe("literals");
      expect(answer[1]).toEqual({});
      // Tras un cambio se vuelven a pedir.
      const before = h.sent.filter((m) => m.method === "textDocument/diagnostic").length;
      h.triggerChange();
      await vi.waitFor(() => expect(h.sent.filter((m) => m.method === "textDocument/diagnostic").length).toBeGreaterThan(before), {
        timeout: 2000,
      });
    } finally {
      for (const k of Object.keys(h.serverCaps)) delete h.serverCaps[k];
      Object.assign(h.serverCaps, caps);
      setLspWorkspace(null);
    }
  });

  it("provee firma, acciones de código, símbolos, inlay hints y workspace/applyEdit respetando capacidades", async () => {
    h.sent.length = 0;
    h.pushEditOperations.mockClear();
    initLsp();
    setLspWorkspace("C:/project");
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === "textDocument/didOpen")).toBe(true));

    const initMsg = h.sent.find((m) => m.method === "initialize");
    expect(initMsg.params.initializationOptions.maxTsServerMemory).toBe(1536);

    const token = { onCancellationRequested: () => ({ dispose() {} }) };
    const sig = await h.providers.signatureHelp.provideSignatureHelp(h.model, { lineNumber: 1, column: 10 }, token, {
      triggerKind: 2,
      triggerCharacter: "(",
      isRetrigger: false,
    });
    expect(sig.value.signatures[0].label).toBe("fn(a: number)");

    const caList = await h.providers.codeAction.provideCodeActions(
      h.model,
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
      { trigger: 1 },
      token,
    );
    expect(caList.actions[0].title).toBe("Importar 'foo'");
    expect(caList.actions[0].edit.edits[0].textEdit.text).toContain("import { foo }");

    const resolved = await h.providers.codeAction.resolveCodeAction(caList.actions[0], token);
    expect(resolved.command.id).toBe("pulso.lsp.executeCommand");
    await h.commands["pulso.lsp.executeCommand"](null, ...resolved.command.arguments);
    expect(h.sent.some((m) => m.method === "workspace/executeCommand")).toBe(true);

    const syms = await h.providers.documentSymbol.provideDocumentSymbols(h.model, token);
    expect(syms[0]).toMatchObject({ name: "saludar", kind: 11 });

    const refreshed = vi.fn();
    h.providers.inlayHints.onDidChangeInlayHints(refreshed);
    const hints = await h.providers.inlayHints.provideInlayHints(
      h.model,
      { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 1 },
      token,
    );
    expect(hints.hints[0]).toMatchObject({ label: "a:", kind: 2, position: { lineNumber: 1, column: 11 } });

    h.handlers.get("lsp-message")!({
      payload: { id: 1, message: { jsonrpc: "2.0", id: 99, method: "workspace/inlayHint/refresh", params: null } },
    });
    expect(refreshed).toHaveBeenCalledTimes(1);

    h.handlers.get("lsp-message")!({
      payload: {
        id: 1,
        message: {
          jsonrpc: "2.0",
          id: 100,
          method: "workspace/applyEdit",
          params: {
            edit: {
              changes: {
                [h.model.uri.toString()]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "let" }],
              },
            },
          },
        },
      },
    });
    await vi.waitFor(() => expect(h.pushEditOperations).toHaveBeenCalledTimes(1));
    expect(h.sent.some((m) => m.id === 100 && m.result?.applied === true)).toBe(true);

    setLspWorkspace(null);
  });
});
