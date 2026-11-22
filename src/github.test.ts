import { beforeEach, describe, expect, it, vi } from "vitest";

interface ProxyReq {
  method: string;
  path: string;
  body: string | null;
  accept: string | null;
  ifNoneMatch: string | null;
  baseUrl: string | null;
}

const h = vi.hoisted(() => {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const store = new Map<string, string>();
  const proxyCalls: ProxyReq[] = [];
  let proxyHandler: (req: ProxyReq) => { status: number; body: string; etag?: string | null; link?: string | null } = () => ({ status: 200, body: "[]" });
  return {
    secrets,
    calls,
    store,
    proxyCalls,
    get proxyHandler() { return proxyHandler; },
    set proxyHandler(fn) { proxyHandler = fn; },
    failSet: false,
    failGet: false,
    cred: null as null | { username: string; token: string; status?: number },
    credAsked: [] as boolean[],
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    h.calls.push(cmd);
    if (cmd === "github_init") {
      if (h.failGet) throw "sin almacén";
      return h.secrets.has("github-token");
    }
    if (cmd === "github_set_token") {
      const tok = String(args.token ?? "").trim();
      if (h.failSet) return false;
      if (tok) h.secrets.set("github-token", tok);
      else h.secrets.delete("github-token");
      return true;
    }
    if (cmd === "github_disconnect") {
      h.secrets.delete("github-token");
      return;
    }
    if (cmd === "github_connect") {
      h.credAsked.push(Boolean(args.interactive));
      if (!h.cred) throw "Git no tiene una sesión de GitHub guardada";
      if (h.cred.status === 401) throw "GitHub rechazó la sesión guardada en Git (caducó o se revocó).";
      h.secrets.set("github-token", h.cred.token);
      return h.cred.username;
    }
    if (cmd === "github_api") {
      const req = args as unknown as ProxyReq;
      h.proxyCalls.push(req);
      const res = h.proxyHandler(req);
      return { status: res.status, body: res.body, etag: res.etag ?? null, link: res.link ?? null };
    }
    throw new Error("comando no simulado " + cmd);
  },
}));

const local = {
  getItem: (k: string) => h.store.get(k) ?? null,
  setItem: (k: string, v: string) => { h.store.set(k, v); },
  removeItem: (k: string) => { h.store.delete(k); },
};

async function fresh(inTauri = true) {
  vi.resetModules();
  vi.stubGlobal("window", inTauri ? { __TAURI_INTERNALS__: {} } : {});
  vi.stubGlobal("localStorage", local);
  return import("./github");
}

beforeEach(() => {
  h.secrets.clear();
  h.calls.length = 0;
  h.store.clear();
  h.proxyCalls.length = 0;
  h.proxyHandler = () => ({ status: 200, body: "[]" });
  h.failSet = false;
  h.failGet = false;
  h.cred = null;
  h.credAsked.length = 0;
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

describe("token en Rust y almacén seguro (nunca expuesto al WebView)", () => {
  it("se guarda en Rust/keyring y nunca queda en JS ni en localStorage", async () => {
    const g = await fresh();
    expect(await g.setToken("  ghp_secreto  ")).toBe(true);
    expect(h.secrets.get("github-token")).toBe("ghp_secreto");
    expect(g.hasToken()).toBe(true);
    expect(g.getToken()).toBe(""); // en Tauri jamás se expone a JS
    expect(Array.from(h.store.values()).join("")).not.toContain("ghp_secreto");
  });

  it("al iniciar carga el estado desde Rust sin leer el secreto", async () => {
    h.secrets.set("github-token", "ghp_guardado");
    const g = await fresh();
    await g.initToken();
    expect(g.hasToken()).toBe(true);
    expect(g.getToken()).toBe("");
  });

  it("migra el token antiguo de localStorage al almacén y lo borra de texto plano", async () => {
    h.store.set("pulso.githubToken", "ghp_viejo");
    const g = await fresh();
    await g.initToken();
    expect(h.secrets.get("github-token")).toBe("ghp_viejo");
    expect(g.hasToken()).toBe(true);
    expect(h.store.has("pulso.githubToken")).toBe(false);
  });

  it("si el almacén ya tiene token no lo pisa con el antiguo", async () => {
    h.secrets.set("github-token", "ghp_nuevo");
    h.store.set("pulso.githubToken", "ghp_viejo");
    const g = await fresh();
    await g.initToken();
    expect(g.hasToken()).toBe(true);
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
    expect(g.hasToken()).toBe(false);
  });

  it("si el almacén falla informa con false y el token sigue activo en memoria de Rust", async () => {
    h.failSet = true;
    const g = await fresh();
    expect(await g.setToken("ghp_x")).toBe(false);
    expect(g.hasToken()).toBe(true);
    expect(Array.from(h.store.values()).join("")).not.toContain("ghp_x");
  });

  it("si leer el almacén falla no rompe el inicio", async () => {
    h.failGet = true;
    const g = await fresh();
    await expect(g.initToken()).resolves.toBeUndefined();
    expect(g.hasToken()).toBe(false);
  });

  it("fuera de Tauri (navegador) no invoca comandos nativos ni toca localStorage", async () => {
    const g = await fresh(false);
    expect(await g.setToken("ghp_x")).toBe(false);
    await g.initToken();
    expect(h.calls).toEqual([]);
    expect(h.store.size).toBe(0);
    expect(g.hasToken()).toBe(true);
  });
});

describe("fetchIssues y proxy Rust", () => {
  it("en Tauri enruta por github_api y filtra los pull requests", async () => {
    const g = await fresh(true);
    await g.setToken("ghp_t");
    h.proxyHandler = () => ({
      status: 200,
      body: JSON.stringify([{ number: 1, title: "issue" }, { number: 2, title: "pr", pull_request: {} }]),
    });
    const issues = await g.fetchIssues("acme", "pulso", "open");
    expect(issues.map((i) => i.number)).toEqual([1]);
    expect(h.proxyCalls[0].path).toContain("/repos/acme/pulso/issues?state=open");
    expect(h.proxyCalls[0].method).toBe("GET");
  });

  it("un error HTTP se reporta con el código", async () => {
    const g = await fresh(true);
    h.proxyHandler = () => ({ status: 404, body: "" });
    const err = await g.fetchIssues("a", "b", "open").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(g.GithubError);
    expect((err as { status: number }).status).toBe(404);
    expect((err as Error).message).toMatch(/no encontró el repositorio/);
    expect(g.isAuthProblem(err)).toBe(true);
    expect(g.isAuthProblem(new Error("otro"))).toBe(false);
  });
});

describe("consultas de issues con ETag", () => {
  it("al repetir manda If-None-Match al proxy y reutiliza lo guardado con un 304", async () => {
    let n = 0;
    h.proxyHandler = () => {
      n++;
      if (n === 1) {
        return {
          status: 200,
          etag: '"v1"',
          body: JSON.stringify([{ number: 1, title: "a", state: "open", labels: [], user: { login: "x" }, comments: 0, html_url: "u" }]),
        };
      }
      return { status: 304, body: "" };
    };
    const g = await fresh(true);
    const first = await g.fetchAllIssues("o", "r", "open");
    const second = await g.fetchAllIssues("o", "r", "open");
    expect(second.issues).toEqual(first.issues);
    expect(h.proxyCalls[0].ifNoneMatch).toBeNull();
    expect(h.proxyCalls[1].ifNoneMatch).toBe('"v1"');
  });

  it("si cambia el token se olvidan las respuestas guardadas (eran de otra cuenta)", async () => {
    h.proxyHandler = () => ({ status: 200, etag: '"v1"', body: "[]" });
    const g = await fresh(true);
    await g.fetchAllIssues("o", "r", "open");
    await g.setToken("otro");
    await g.fetchAllIssues("o", "r", "open");
    expect(h.proxyCalls.map((c) => c.ifNoneMatch)).toEqual([null, null]);
  });
});

describe("eliminar issues", () => {
  it("usa GraphQL con el identificador global a través del proxy", async () => {
    h.proxyHandler = () => ({ status: 200, body: JSON.stringify({ data: { deleteIssue: {} } }) });
    const g = await fresh(true);
    await g.setToken("ghp_x");
    await g.deleteIssue("I_abc");
    expect(h.proxyCalls[0].path).toBe("/graphql");
    expect(h.proxyCalls[0].method).toBe("POST");
    expect(JSON.parse(h.proxyCalls[0].body!).variables).toEqual({ id: "I_abc" });
    expect(JSON.parse(h.proxyCalls[0].body!).query).toContain("deleteIssue");
  });

  it("explica que solo quienes administran pueden eliminar", async () => {
    h.proxyHandler = () => ({
      status: 200,
      body: JSON.stringify({ errors: [{ message: "ana does not have the correct permissions to execute `DeleteIssue`" }] }),
    });
    const g = await fresh(true);
    await expect(g.deleteIssue("I_abc")).rejects.toThrow(/administran el repositorio/);
    expect(g.explainDeleteError("algo raro")).toContain("algo raro");
  });

  it("un fallo HTTP se reporta con su código", async () => {
    h.proxyHandler = () => ({ status: 401, body: "" });
    const g = await fresh(true);
    await expect(g.deleteIssue("I_abc")).rejects.toMatchObject({ status: 401 });
  });
});

describe("conectar con la cuenta de GitHub de Git", () => {
  it("al iniciar adopta en silencio la sesión de Git sin exponer el token a JS", async () => {
    h.cred = { username: "ana", token: "gho_git" };
    const g = await fresh(true);
    await g.initToken();
    expect(await g.autoConnect()).toBe("ana");
    expect(h.credAsked).toEqual([false]);
    expect(g.hasToken()).toBe(true);
    expect(g.getToken()).toBe("");
    expect(h.secrets.get("github-token")).toBe("gho_git");
    expect(g.getAccount()).toBe("ana");
  });

  it("no toca un token que ya existe ni abre nada si Git no tiene sesión", async () => {
    const g = await fresh(true);
    await g.setToken("ghp_propio");
    expect(await g.autoConnect()).toBeNull();
    expect(h.credAsked).toEqual([]);
    await g.disconnectGithub();
    expect(await g.autoConnect()).toBeNull();
    expect(g.hasToken()).toBe(false);
  });

  it("con interactive lo pide al gestor y devuelve el usuario", async () => {
    h.cred = { username: "ana", token: "gho_git" };
    const g = await fresh(true);
    expect(await g.connectGithub(true)).toBe("ana");
    expect(h.credAsked).toEqual([true]);
  });

  it("si GitHub rechaza la sesión de Git lo explica y no guarda nada", async () => {
    h.cred = { username: "x", token: "gho_git", status: 401 };
    const g = await fresh(true);
    await expect(g.connectGithub(true)).rejects.toThrow(/caducó o se revocó/);
    expect(g.hasToken()).toBe(false);
    expect(h.secrets.size).toBe(0);
  });

  it("desconectar borra el token del almacén", async () => {
    const g = await fresh(true);
    await g.setToken("ghp_x");
    await g.disconnectGithub();
    expect(h.secrets.has("github-token")).toBe(false);
    expect(g.hasToken()).toBe(false);
  });
});

describe("issues: paginación y cambios", () => {
  const pages = new Map<string, unknown[]>();
  let status = 200;
  let statusFor: Record<string, number> = {};

  const issue = (n: number, pr = false) => ({
    number: n, title: `t${n}`, state: "open", html_url: "", user: { login: "u" }, labels: [], comments: 0,
    ...(pr ? { pull_request: {} } : {}),
  });

  beforeEach(() => {
    pages.clear();
    status = 200;
    statusFor = {};
    h.proxyHandler = (req) => {
      const u = new URL(`https://api.github.com${req.path}`);
      const key = `${req.method} ${u.pathname}`;
      const st = statusFor[key] ?? status;
      const page = u.searchParams.get("page") ?? "1";
      const data = pages.get(`${u.searchParams.get("state")}-${page}`) ?? [];
      return { status: st, body: JSON.stringify(data) };
    };
  });

  it("junta las páginas hasta recibir una incompleta y descarta las PR", async () => {
    pages.set("open-1", Array.from({ length: 100 }, (_, i) => issue(i + 1, i === 0)));
    pages.set("open-2", [issue(101), issue(102)]);
    const g = await fresh(true);
    const r = await g.fetchAllIssues("a", "b", "open");
    expect(r.issues).toHaveLength(101);
    expect(r.truncated).toBe(false);
    expect(h.proxyCalls.map((c) => new URL(`https://api.github.com${c.path}`).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("se detiene en el máximo y avisa de que hay más", async () => {
    for (let p = 1; p <= 5; p++) pages.set(`closed-${p}`, Array.from({ length: 100 }, (_, i) => issue(p * 1000 + i)));
    const g = await fresh(true);
    const r = await g.fetchAllIssues("a", "b", "closed", 200);
    expect(r.issues).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(h.proxyCalls).toHaveLength(2);
  });

  it("explica los fallos en español", async () => {
    const g = await fresh(true);
    status = 404;
    await expect(g.fetchAllIssues("a", "b", "open")).rejects.toThrow(/no encontró el repositorio/);
    status = 401;
    await expect(g.fetchAllIssues("a", "b", "open")).rejects.toThrow(/rechazó el token/);
    expect(g.explainStatus(403, true)).toContain("permiso de escritura");
    expect(g.explainStatus(403, false)).not.toContain("escritura");
    expect(g.explainStatus(500, false)).toBe("GitHub respondió 500");
  });

  it("añadir y quitar etiquetas y cambiar el estado usan los endpoints correctos", async () => {
    const g = await fresh(true);
    await g.addLabel("o", "r", 7, "in progress");
    await g.removeLabel("o", "r", 7, "in progress");
    await g.setIssueState("o", "r", 7, "closed");
    expect(h.proxyCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/o/r/issues/7/labels",
      "DELETE /repos/o/r/issues/7/labels/in%20progress",
      "PATCH /repos/o/r/issues/7",
    ]);
    expect(JSON.parse(h.proxyCalls[0].body!)).toEqual({ labels: ["in progress"] });
    expect(JSON.parse(h.proxyCalls[2].body!)).toEqual({ state: "closed" });
  });

  it("quitar una etiqueta que ya no está no es un error, pero un 403 sí", async () => {
    const g = await fresh(true);
    statusFor = { "DELETE /repos/o/r/issues/7/labels/x": 404 };
    await expect(g.removeLabel("o", "r", 7, "x")).resolves.toBeUndefined();
    statusFor = { "PATCH /repos/o/r/issues/7": 403 };
    await expect(g.setIssueState("o", "r", 7, "open")).rejects.toThrow(/permiso de escritura/);
  });

  it("pasa baseUrl al proxy solo cuando existe la clave de pruebas", async () => {
    const g = await fresh(true);
    h.store.set("pulso.githubApi", "http://127.0.0.1:9999/");
    await g.addLabel("o", "r", 1, "x");
    expect(h.proxyCalls[0].baseUrl).toBe("http://127.0.0.1:9999");
    h.store.delete("pulso.githubApi");
    await g.addLabel("o", "r", 1, "x");
    expect(h.proxyCalls[1].baseUrl).toBeNull();
  });
});

describe("issues: crear y editar", () => {
  let reply: { status: number; json: unknown } = { status: 201, json: { number: 9, title: "x" } };
  beforeEach(() => {
    reply = { status: 201, json: { number: 9, title: "x" } };
    h.proxyHandler = () => ({ status: reply.status, body: JSON.stringify(reply.json) });
  });

  it("crear envía título, descripción y etiquetas y devuelve la issue de GitHub", async () => {
    const g = await fresh(true);
    const issue = await g.createIssue("o", "r", { title: "Hola", body: "texto", labels: ["in progress"] });
    expect(issue.number).toBe(9);
    expect(h.proxyCalls[0].method).toBe("POST");
    expect(h.proxyCalls[0].path).toBe("/repos/o/r/issues");
    expect(JSON.parse(h.proxyCalls[0].body!)).toEqual({ title: "Hola", body: "texto", labels: ["in progress"] });
  });

  it("editar solo envía lo que cambia", async () => {
    const g = await fresh(true);
    reply = { status: 200, json: { number: 4, title: "Nuevo" } };
    await g.updateIssue("o", "r", 4, { title: "Nuevo" });
    expect(h.proxyCalls[0].method).toBe("PATCH");
    expect(h.proxyCalls[0].path).toBe("/repos/o/r/issues/4");
    expect(JSON.parse(h.proxyCalls[0].body!)).toEqual({ title: "Nuevo" });
  });

  it("explica los fallos de escritura", async () => {
    const g = await fresh(true);
    reply = { status: 403, json: {} };
    await expect(g.createIssue("o", "r", { title: "t", body: "", labels: [] })).rejects.toThrow(/permiso de escritura/);
    reply = { status: 422, json: {} };
    await expect(g.updateIssue("o", "r", 1, { title: "" })).rejects.toThrow(/datos no válidos/);
  });
});
