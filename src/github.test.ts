import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const store = new Map<string, string>();
  return { secrets, calls, store, failSet: false, failGet: false };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { name: string; value?: string }) => {
    h.calls.push(cmd);
    if (cmd === "secret_get") {
      if (h.failGet) throw "sin almacén";
      return h.secrets.get(args.name) ?? null;
    }
    if (cmd === "secret_set") {
      if (h.failSet) throw "denegado";
      h.secrets.set(args.name, args.value!);
      return;
    }
    if (cmd === "secret_delete") { h.secrets.delete(args.name); return; }
    throw new Error("comando no simulado " + cmd);
  },
}));

const local = { getItem: (k: string) => h.store.get(k) ?? null, setItem: (k: string, v: string) => { h.store.set(k, v); }, removeItem: (k: string) => { h.store.delete(k); } };

async function fresh(inTauri = true) {
  vi.resetModules();
  vi.stubGlobal("window", inTauri ? { __TAURI_INTERNALS__: {} } : {});
  vi.stubGlobal("localStorage", local);
  return import("./github");
}

beforeEach(() => {
  h.secrets.clear(); h.calls.length = 0; h.store.clear();
  h.failSet = false; h.failGet = false;
});

describe("parseRemote", () => {
  it("entiende URLs https y ssh", async () => {
    const { parseRemote } = await fresh();
    expect(parseRemote("https://github.com/acme/pulso.git")).toEqual({ owner: "acme", repo: "pulso" });
    expect(parseRemote("git@github.com:acme/pulso.git")).toEqual({ owner: "acme", repo: "pulso" });
    expect(parseRemote("https://github.com/acme/pulso")).toEqual({ owner: "acme", repo: "pulso" });
    expect(parseRemote("https://github.com/acme/pulso/")).toEqual({ owner: "acme", repo: "pulso" });
  });

  it("devuelve null si no es de GitHub", async () => {
    const { parseRemote } = await fresh();
    expect(parseRemote("https://gitlab.com/acme/pulso.git")).toBeNull();
    expect(parseRemote("")).toBeNull();
  });
});

describe("token en el almacén seguro", () => {
  it("se guarda en el almacén del sistema y nunca en localStorage", async () => {
    const g = await fresh();
    expect(await g.setToken("  ghp_secreto  ")).toBe(true);
    expect(h.secrets.get("github-token")).toBe("ghp_secreto");
    expect(g.getToken()).toBe("ghp_secreto");
    expect(Array.from(h.store.values()).join("")).not.toContain("ghp_secreto");
  });

  it("al iniciar carga el token guardado", async () => {
    h.secrets.set("github-token", "ghp_guardado");
    const g = await fresh();
    await g.initToken();
    expect(g.getToken()).toBe("ghp_guardado");
  });

  it("migra el token antiguo de localStorage al almacén y lo borra de texto plano", async () => {
    h.store.set("pulso.githubToken", "ghp_viejo");
    const g = await fresh();
    await g.initToken();
    expect(h.secrets.get("github-token")).toBe("ghp_viejo");
    expect(g.getToken()).toBe("ghp_viejo");
    expect(h.store.has("pulso.githubToken")).toBe(false);
  });

  it("si el almacén ya tiene token no lo pisa con el antiguo", async () => {
    h.secrets.set("github-token", "ghp_nuevo");
    h.store.set("pulso.githubToken", "ghp_viejo");
    const g = await fresh();
    await g.initToken();
    expect(g.getToken()).toBe("ghp_nuevo");
    expect(h.secrets.get("github-token")).toBe("ghp_nuevo");
    expect(h.store.has("pulso.githubToken")).toBe(false);
  });

  it("si la migración falla deja el token antiguo donde estaba para no perderlo", async () => {
    h.failSet = true;
    h.store.set("pulso.githubToken", "ghp_viejo");
    const g = await fresh();
    await g.initToken();
    expect(h.store.get("pulso.githubToken")).toBe("ghp_viejo");
  });

  it("vaciar el campo borra el token del almacén", async () => {
    h.secrets.set("github-token", "x");
    const g = await fresh();
    expect(await g.setToken("   ")).toBe(true);
    expect(h.secrets.has("github-token")).toBe(false);
    expect(g.getToken()).toBe("");
  });

  it("si el almacén falla informa con false y el token vale solo en esta sesión", async () => {
    h.failSet = true;
    const g = await fresh();
    expect(await g.setToken("ghp_x")).toBe(false);
    expect(g.getToken()).toBe("ghp_x");
    expect(Array.from(h.store.values()).join("")).not.toContain("ghp_x");
  });

  it("si leer el almacén falla no rompe el inicio", async () => {
    h.failGet = true;
    const g = await fresh();
    await expect(g.initToken()).resolves.toBeUndefined();
    expect(g.getToken()).toBe("");
  });

  it("fuera de Tauri (navegador) no toca el almacén ni localStorage", async () => {
    const g = await fresh(false);
    expect(await g.setToken("ghp_x")).toBe(false);
    await g.initToken();
    expect(h.calls).toEqual([]);
    expect(h.store.size).toBe(0);
  });
});

describe("fetchIssues", () => {
  it("usa el token como cabecera y filtra los pull requests", async () => {
    const g = await fresh();
    await g.setToken("ghp_t");
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, json: async () => [{ number: 1, title: "issue" }, { number: 2, title: "pr", pull_request: {} }] };
    });
    const issues = await g.fetchIssues("acme", "pulso", "open");
    expect(issues.map((i) => i.number)).toEqual([1]);
    expect(seen[0].url).toContain("/repos/acme/pulso/issues?state=open");
    expect(seen[0].headers.Authorization).toBe("Bearer ghp_t");
  });

  it("sin token no manda cabecera de autorización", async () => {
    const g = await fresh();
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => { headers = init.headers; return { ok: true, json: async () => [] }; });
    await g.fetchIssues("a", "b", "all");
    expect(headers.Authorization).toBeUndefined();
  });

  it("un error HTTP se reporta con el código", async () => {
    const g = await fresh();
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(g.fetchIssues("a", "b", "open")).rejects.toThrow("404");
  });
});
