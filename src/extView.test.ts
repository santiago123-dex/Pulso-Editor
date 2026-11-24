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
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  onclick: ((e?: unknown) => unknown) | null = null;
  oninput: (() => unknown) | null = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...nodes: (FakeEl | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const span = new FakeEl("span");
        span.textContent = n;
        this.children.push(span);
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
  findButtons(): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.tagName === "BUTTON") out.push(this);
    for (const c of this.children) out.push(...c.findButtons());
    return out;
  }
}

const byId = new Map<string, FakeEl>();
const invokeMock = vi.fn();
const showDialogMock = vi.fn();
const setStatusMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("./ui", () => ({
  showDialog: (...args: unknown[]) => showDialogMock(...args),
  setStatus: (...args: unknown[]) => setStatusMock(...args),
}));

beforeEach(() => {
  byId.clear();
  invokeMock.mockReset();
  showDialogMock.mockReset();
  setStatusMock.mockReset();

  for (const id of ["ext-list", "ext-search", "ext-install", "ext-refresh"]) {
    const el = new FakeEl(id === "ext-search" ? "input" : id === "ext-list" ? "div" : "button");
    el.id = id;
    byId.set(id, el);
  }
  (globalThis as any).window = { __TAURI_INTERNALS__: {} };
  (globalThis as any).document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe("extView", () => {
  it("renderiza estado vacío y luego lista extensiones con roles ARIA y botones accesibles", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        enabled: true,
        dir: "/ext/pulso.aurora",
        manifest: {
          id: "pulso.aurora",
          name: "Aurora",
          version: "1.0.0",
          description: "Tema oscuro",
          author: "Pulso",
          permissions: ["files"],
          contributes: { themes: [{ id: "a", label: "A", path: "themes/a.json" }], snippets: [], commands: [], languageServers: [] },
        },
      },
    ]);

    const mod = await import("./extView");
    mod.initExtensions();
    await mod.refreshExtensions();

    const list = byId.get("ext-list")!;
    expect(list.children).toHaveLength(1);
    expect(list.children[0].getAttribute("role")).toBe("listitem");
    expect(list.allText()).toContain("Aurora");
    expect(list.allText()).toContain("Activa");
    const btns = list.findButtons();
    expect(btns[0].getAttribute("aria-label")).toBe("Desactivar Aurora");
  });

  it("pide consentimiento explícito de permisos antes de confirmar la instalación", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "ext_pick_for_install") {
        return {
          token: "tok-1",
          manifest: {
            id: "pulso.demo",
            name: "Demo",
            version: "1.0.0",
            description: "Desc",
            author: "Pulso",
            permissions: ["files", "terminal"],
            contributes: { themes: [], snippets: [], commands: [{ id: "c", title: "Run", script: "echo 1" }], languageServers: [] },
          },
        };
      }
      if (cmd === "ext_confirm_install") {
        return {
          enabled: true,
          dir: "/ext/pulso.demo",
          manifest: {
            id: "pulso.demo",
            name: "Demo",
            version: "1.0.0",
            description: "",
            author: "",
            permissions: ["files", "terminal"],
            contributes: { themes: [], snippets: [], commands: [], languageServers: [] },
          },
        };
      }
      if (cmd === "ext_list") return [];
      return null;
    });
    showDialogMock.mockResolvedValueOnce("install");

    const mod = await import("./extView");
    await mod.installExtensionFromFolder();

    expect(showDialogMock).toHaveBeenCalledTimes(1);
    expect(String(showDialogMock.mock.calls[0][0].message)).toContain("Terminal y comandos externos (terminal)");
    expect(invokeMock).toHaveBeenCalledWith("ext_confirm_install", { token: "tok-1" });
  });
});
