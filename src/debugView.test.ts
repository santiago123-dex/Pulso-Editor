import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeEl {
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  value = "";
  title = "";
  type = "";
  hidden = false;
  selected = false;
  tabIndex = -1;
  scrollTop = 0;
  scrollHeight = 0;
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  onclick: ((e?: unknown) => unknown) | null = null;
  onchange: (() => unknown) | null = null;
  onkeydown: ((e: { key: string; preventDefault: () => void }) => unknown) | null = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...nodes: (FakeEl | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const s = new FakeEl("span");
        s.textContent = n;
        this.children.push(s);
      } else {
        this.children.push(n);
      }
    }
  }
  set innerHTML(_: string) {
    this.children = [];
    this.textContent = "";
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  allText(): string {
    return [this.textContent, ...this.children.map((c) => c.allText())].filter(Boolean).join(" ");
  }
}

const byId = new Map<string, FakeEl>();
const invokeMock = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const setStatusMock = vi.fn();

vi.mock("monaco-editor", () => ({
  editor: {
    getEditors: () => [],
    onDidCreateEditor: () => ({ dispose: () => {} }),
    MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
  },
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => {};
  },
}));
vi.mock("./groups", () => ({
  activePath: () => "C:/repo/main.py",
  focusedEditor: () => null,
}));
vi.mock("./ui", () => ({
  setStatus: (...args: unknown[]) => setStatusMock(...args),
}));
vi.mock("./workspace", () => ({
  ws: { root: "C:/repo" },
}));

beforeEach(() => {
  byId.clear();
  listeners.clear();
  invokeMock.mockReset();
  setStatusMock.mockReset();

  const ids = [
    "debug-badge",
    "dbg-config",
    "dbg-trust",
    "dbg-trust-btn",
    "dbg-controls",
    "dbg-status",
    "dbg-vars",
    "dbg-stack",
    "dbg-bps",
    "dbg-console",
    "dbg-start",
    "dbg-create-cfg",
    "dbg-continue",
    "dbg-pause",
    "dbg-next",
    "dbg-step-in",
    "dbg-step-out",
    "dbg-stop",
    "dbg-bp-clear",
    "dbg-eval-input",
  ];
  for (const id of ids) {
    const tag = id === "dbg-config" ? "select" : id === "dbg-eval-input" ? "input" : "div";
    const el = new FakeEl(tag);
    el.id = id;
    byId.set(id, el);
  }
  (globalThis as any).window = { __TAURI_INTERNALS__: {} };
  (globalThis as any).document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe("debugView", () => {
  it("muestra aviso de confianza cuando el proyecto no es confiable y carga configuraciones", async () => {
    invokeMock.mockResolvedValueOnce({
      trusted: false,
      configs: [
        {
          name: "Python: Archivo actual",
          type: "python",
          request: "launch",
          program: "${file}",
          args: [],
          env: {},
          adapterArgs: [],
          source: "auto",
        },
      ],
    });

    const mod = await import("./debugView");
    mod.initDebug(async () => {});
    await mod.refreshDebugConfigs();

    expect(byId.get("dbg-trust")!.hidden).toBe(false);
    expect(byId.get("dbg-config")!.children).toHaveLength(1);
    expect(byId.get("dbg-config")!.children[0].textContent).toContain("Python: Archivo actual");
  });

  it("actualiza pila de llamadas, variables y estado al recibir evento DAP stopped", async () => {
    const opened: { path: string; line?: number }[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dap_stack_trace") {
        return [{ id: 10, name: "calcular", source: "C:/repo/main.py", line: 14, column: 1 }];
      }
      if (cmd === "dap_scopes") {
        return [{ name: "Locals", variablesReference: 99, expensive: false }];
      }
      if (cmd === "dap_variables") {
        return [{ name: "total", value: "42", type: "int", variablesReference: 0 }];
      }
      return null;
    });

    const mod = await import("./debugView");
    mod.initDebug(async (path, line) => {
      opened.push({ path, line });
    });

    const handler = listeners.get("dap-event");
    expect(handler).toBeDefined();
    handler!({ payload: { event: "stopped", body: { threadId: 1, reason: "breakpoint" } } });
    await new Promise((r) => setTimeout(r, 20));

    expect(byId.get("dbg-status")!.textContent).toBe("En pausa");
    expect(byId.get("dbg-stack")!.allText()).toContain("calcular");
    expect(byId.get("dbg-vars")!.allText()).toContain("total");
    expect(byId.get("dbg-vars")!.allText()).toContain("42");
    expect(opened).toEqual([{ path: "C:/repo/main.py", line: 14 }]);
  });
});
