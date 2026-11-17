import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const handlers = new Map<string, (event: any) => void>();
  const sent: any[] = [];
  const providers: Record<string, any> = {};
  const markers = vi.fn();
  const definitionResults: any[] = [];
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
    onDidChangeContent: (f: (event: any) => void) => { change = f; return { dispose() {} }; },
    onWillDispose: () => ({ dispose() {} }),
  };
  const defaults = { setModeConfiguration: vi.fn() };
  return { handlers, sent, providers, markers, model, defaults, definitionResults, line, triggerChange: () => change?.({ isFlush: false, changes: [{ range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 }, text: "x" }] }) };
});

vi.mock("monaco-editor", () => ({
  Uri: { file: () => h.model.uri, parse: (value: string) => value.includes("other.ts") ? { scheme: "file", fsPath: "C:\\project\\other.ts", toString: () => value } : h.model.uri },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  editor: { getModels: () => [h.model], getModel: vi.fn(() => h.model), setModelMarkers: h.markers, onDidCreateModel: vi.fn(), registerEditorOpener: vi.fn() },
  languages: {
    typescript: { typescriptDefaults: h.defaults, javascriptDefaults: h.defaults },
    CompletionItemKind: new Proxy({}, { get: () => 1 }),
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerHoverProvider: (_: string, p: unknown) => { h.providers.hover = p; },
    registerDefinitionProvider: (_: string, p: unknown) => { h.providers.definition = p; },
    registerReferenceProvider: (_: string, p: unknown) => { h.providers.references = p; },
    registerCompletionItemProvider: (_: string, p: unknown) => { h.providers.completion = p; },
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, callback: (event: any) => void) => { h.handlers.set(name, callback); return () => {}; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  if (command === "lsp_start") return 1;
  if (command === "lsp_send") {
    h.sent.push(args.message);
    if (args.message.id !== undefined && args.message.method) {
      const result = args.message.method === "initialize" ? { capabilities: { textDocumentSync: { change: 2 } } } : args.message.method === "textDocument/definition" ? h.definitionResults.shift() ?? [{ uri: "file:///c%3A/project/other.ts", range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } } }] : args.message.method === "textDocument/hover" ? { contents: { kind: "markdown", value: "const saludo: number" } } : {};
      queueMicrotask(() => h.handlers.get("lsp-message")?.({ payload: { id: 1, message: { jsonrpc: "2.0", id: args.message.id, result } } }));
    }
  }
} }));
vi.mock("./docs", () => ({ onDocSaved: vi.fn(), findOpenDoc: vi.fn() }));
vi.mock("./groups", () => ({ config: {}, openFile: vi.fn() }));
vi.mock("./ui", () => ({ setStatus: vi.fn() }));

import { initLsp, setLspWorkspace } from "./lsp";
import { config, openFile } from "./groups";

beforeEach(() => { vi.stubGlobal("window", globalThis); (window as any).__TAURI_INTERNALS__ = {}; });

describe("cliente LSP", () => {
  it("sincroniza el modelo, convierte diagnósticos y navega a definiciones", async () => {
    initLsp();
    setLspWorkspace("C:/project");
    // Un clic inmediato espera la inicialización y el didOpen, sin caer a Monaco.
    const early = config.goToDefinition!(h.model as any, { lineNumber: 1, column: 2 } as any);
    expect(await early).toBe(true);
    expect(openFile).toHaveBeenCalledWith("C:/project/other.ts", { line: 3, col: 4 });
    expect(h.sent.findIndex((m) => m.method === "textDocument/didOpen")).toBeLessThan(h.sent.findIndex((m) => m.method === "textDocument/definition"));
    const requestsBeforeProbe = h.sent.filter((m) => m.method === "textDocument/definition").length;
    expect(await config.probeDefinition!(h.model as any, { lineNumber: 1, column: 3 } as any)).toBe(true);
    expect(h.sent.filter((m) => m.method === "textDocument/definition")).toHaveLength(requestsBeforeProbe);
    vi.mocked(openFile).mockClear();
    expect(await config.goToDefinition!(h.model as any, { lineNumber: 1, column: 3 } as any, () => false)).toBe(true);
    expect(openFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === "textDocument/didOpen")).toBe(true));
    h.triggerChange();
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === "textDocument/didChange")).toBe(true));
    expect(h.sent.find((m) => m.method === "textDocument/didChange").params.contentChanges).toEqual([{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, text: "x" }]);
    const monaco = await import("monaco-editor");
    const docs = await import("./docs");
    vi.mocked(monaco.editor.getModel).mockReturnValueOnce(null);
    vi.mocked(docs.findOpenDoc).mockReturnValueOnce({ model: h.model } as any);
    h.handlers.get("lsp-message")!({ payload: { id: 1, message: { method: "textDocument/publishDiagnostics", params: { uri: h.model.uri.toString(), version: 1, diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, message: "error", severity: 1, code: 123 }] } } } });
    expect(h.markers).toHaveBeenCalledWith(h.model, "pulso-lsp", [expect.objectContaining({ startLineNumber: 2, startColumn: 3, message: "error", code: "123" })]);
    const result = await h.providers.definition.provideDefinition(h.model, { lineNumber: 1, column: 2 }, { onCancellationRequested: () => ({ dispose() {} }) });
    expect(result[0].range).toEqual({ startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 9 });
    const hover = await h.providers.hover.provideHover(h.model, { lineNumber: 1, column: 2 }, { onCancellationRequested: () => ({ dispose() {} }) });
    expect(hover.contents[0].value).toContain("const saludo: number");
    expect(await config.goToDefinition!(h.model as any, { lineNumber: 1, column: 2 } as any)).toBe(true);
    expect(openFile).toHaveBeenCalledWith("C:/project/other.ts", { line: 3, col: 4 });
    // Mientras TypeScript carga el proyecto, una respuesta al import local no debe ganar al destino real.
    h.triggerChange();
    h.line.text = "import { saludo } from './other';";
    h.definitionResults.push([{ uri: h.model.uri.toString(), range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } } }]);
    vi.mocked(openFile).mockClear();
    expect(await config.goToDefinition!(h.model as any, { lineNumber: 1, column: 2 } as any)).toBe(true);
    expect(openFile).toHaveBeenCalledWith("C:/project/other.ts", { line: 3, col: 4 });
    h.line.text = "const saludo = 1;";
    setLspWorkspace(null);
  });
});
