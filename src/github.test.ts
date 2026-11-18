import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const store = new Map<string, string>();
  return { secrets, calls, store, failSet: false, failGet: false, cred: null as null | { username: string; token: string }, credAsked: [] as boolean[] };
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
    if (cmd === "github_credential") {
      h.credAsked.push((args as unknown as { interactive: boolean }).interactive);
      if (!h.cred) throw "Git no tiene una sesión de GitHub guardada";
      return h.cred;
    }
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
  h.failSet = false; h.failGet = false; h.cred = null; h.credAsked.length = 0;
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
    const err = await g.fetchIssues("a", "b", "open").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(g.GithubError);
    expect((err as { status: number }).status).toBe(404);
    expect((err as Error).message).toMatch(/no encontró el repositorio/);
    expect(g.isAuthProblem(err)).toBe(true);
    expect(g.isAuthProblem(new Error("otro"))).toBe(false);
  });
});

describe("consultas de issues sin caché del navegador y con ETag", () => {
  it("nunca usa la caché del navegador y, al repetir, manda If-None-Match y reutiliza lo guardado con un 304", async () => {
    const seen: { url: string; cache?: string; inm?: string }[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init: { cache?: string; headers: Record<string, string> }) => {
      seen.push({ url: String(url), cache: init.cache, inm: init.headers["If-None-Match"] });
      n++;
      if (n === 1) return { ok: true, status: 200, headers: { get: () => '"v1"' }, json: async () => [{ number: 1, title: "a", state: "open", labels: [], user: { login: "x" }, comments: 0, html_url: "u" }] };
      return { ok: false, status: 304, headers: { get: () => null }, json: async () => [] };
    });
    const g = await fresh();
    const first = await g.fetchAllIssues("o", "r", "open");
    const second = await g.fetchAllIssues("o", "r", "open");
    expect(second.issues).toEqual(first.issues);
    expect(seen.every((s) => s.cache === "no-store")).toBe(true);
    expect(seen[0].inm).toBeUndefined();
    expect(seen[1].inm).toBe('"v1"');
  });
  it("si cambia el token se olvidan las respuestas guardadas (eran de otra cuenta)", async () => {
    const seen: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => { seen.push(init.headers["If-None-Match"]); return { ok: true, status: 200, headers: { get: () => '"v1"' }, json: async () => [] }; });
    const g = await fresh();
    await g.fetchAllIssues("o", "r", "open");
    await g.setToken("otro");
    await g.fetchAllIssues("o", "r", "open");
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("eliminar issues", () => {
  it("usa GraphQL con el identificador global y el token", async () => {
    const calls: { url: string; body: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string; headers: Record<string, string> }) => { calls.push({ url: String(url), body: init.body, auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => ({ data: { deleteIssue: {} } }) }; });
    const g = await fresh();
    await g.setToken("ghp_x");
    await g.deleteIssue("I_abc");
    expect(calls[0].url).toMatch(/\/graphql$/);
    expect(calls[0].auth).toBe("Bearer ghp_x");
    expect(JSON.parse(calls[0].body).variables).toEqual({ id: "I_abc" });
    expect(JSON.parse(calls[0].body).query).toContain("deleteIssue");
  });
  it("explica que solo quienes administran pueden eliminar", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "ana does not have the correct permissions to execute `DeleteIssue`" }] }) }));
    const g = await fresh();
    await expect(g.deleteIssue("I_abc")).rejects.toThrow(/administran el repositorio/);
    expect(g.explainDeleteError("algo raro")).toContain("algo raro");
  });
  it("un fallo HTTP se reporta con su código", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }));
    const g = await fresh();
    await expect(g.deleteIssue("I_abc")).rejects.toMatchObject({ status: 401 });
  });
});

describe("conectar con la cuenta de GitHub de Git", () => {
  const userFetch = (status = 200) => vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
    expect(String(url)).toMatch(/\/user$/);
    expect(init.headers.Authorization).toBe("Bearer gho_git");
    return { ok: status === 200, status, json: async () => ({ login: "ana" }) };
  });

  it("al iniciar adopta en silencio la sesión de Git si no hay token y la guarda", async () => {
    h.cred = { username: "ana-git", token: "gho_git" };
    userFetch();
    const g = await fresh();
    await g.initToken();
    expect(await g.autoConnect()).toBe("ana");
    expect(h.credAsked).toEqual([false]);
    expect(g.getToken()).toBe("gho_git");
    expect(h.secrets.get("github-token")).toBe("gho_git");
    expect(g.getAccount()).toBe("ana");
  });
  it("no toca un token que ya existe ni abre nada si Git no tiene sesión", async () => {
    const g = await fresh();
    await g.setToken("ghp_propio");
    expect(await g.autoConnect()).toBeNull();
    expect(h.credAsked).toEqual([]);
    await g.disconnectGithub();
    expect(await g.autoConnect()).toBeNull();
    expect(g.getToken()).toBe("");
  });
  it("con interactive lo pide al gestor y devuelve el usuario", async () => {
    h.cred = { username: "x", token: "gho_git" };
    userFetch();
    const g = await fresh();
    expect(await g.connectGithub(true)).toBe("ana");
    expect(h.credAsked).toEqual([true]);
  });
  it("si GitHub rechaza la sesión de Git lo explica y no guarda nada", async () => {
    h.cred = { username: "x", token: "gho_git" };
    userFetch(401);
    const g = await fresh();
    await expect(g.connectGithub(true)).rejects.toThrow(/caducó o se revocó/);
    expect(g.getToken()).toBe("");
    expect(h.secrets.size).toBe(0);
  });
  it("desconectar borra el token del almacén", async () => {
    const g = await fresh();
    await g.setToken("ghp_x");
    await g.disconnectGithub();
    expect(h.secrets.has("github-token")).toBe(false);
  });
});

describe("issues: paginación y cambios", () => {
  type Call = { method: string; url: string; body?: string; auth?: string };
  const calls: Call[] = [];
  const pages = new Map<string, unknown[]>();
  let status = 200;
  let statusFor: Record<string, number> = {};

  function stubFetch() {
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body, auth: init.headers?.Authorization });
      const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
      const st = statusFor[key] ?? status;
      const page = new URL(url).searchParams.get("page") ?? "1";
      return { ok: st >= 200 && st < 300, status: st, json: async () => pages.get(`${new URL(url).searchParams.get("state")}-${page}`) ?? [] };
    });
  }
  const issue = (n: number, pr = false) => ({ number: n, title: `t${n}`, state: "open", html_url: "", user: { login: "u" }, labels: [], comments: 0, ...(pr ? { pull_request: {} } : {}) });
  beforeEach(() => { pages.clear(); status = 200; statusFor = {}; stubFetch(); });

  it("junta las páginas hasta recibir una incompleta y descarta las PR", async () => {
    pages.set("open-1", Array.from({ length: 100 }, (_, i) => issue(i + 1, i === 0)));
    pages.set("open-2", [issue(101), issue(102)]);
    const g = await fresh();
    const r = await g.fetchAllIssues("a", "b", "open");
    expect(r.issues).toHaveLength(101);
    expect(r.truncated).toBe(false);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls[0].url).toContain("per_page=100");
  });

  it("se detiene en el máximo y avisa de que hay más", async () => {
    for (let p = 1; p <= 5; p++) pages.set(`closed-${p}`, Array.from({ length: 100 }, (_, i) => issue(p * 1000 + i)));
    const g = await fresh();
    const r = await g.fetchAllIssues("a", "b", "closed", 200);
    expect(r.issues).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("envía el token y explica los fallos en español", async () => {
    const g = await fresh();
    await g.setToken("ghp_x");
    pages.set("open-1", [issue(1)]);
    await g.fetchAllIssues("a", "b", "open");
    expect(calls[0].auth).toBe("Bearer ghp_x");
    status = 404;
    await expect(g.fetchAllIssues("a", "b", "open")).rejects.toThrow(/no encontró el repositorio/);
    status = 401;
    await expect(g.fetchAllIssues("a", "b", "open")).rejects.toThrow(/rechazó el token/);
    expect(g.explainStatus(403, true)).toContain("permiso de escritura");
    expect(g.explainStatus(403, false)).not.toContain("escritura");
    expect(g.explainStatus(500, false)).toBe("GitHub respondió 500");
  });

  it("añadir y quitar etiquetas y cambiar el estado usan los endpoints correctos", async () => {
    const g = await fresh();
    await g.addLabel("o", "r", 7, "in progress");
    await g.removeLabel("o", "r", 7, "in progress");
    await g.setIssueState("o", "r", 7, "closed");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /repos/o/r/issues/7/labels",
      "DELETE /repos/o/r/issues/7/labels/in%20progress",
      "PATCH /repos/o/r/issues/7",
    ]);
    expect(JSON.parse(calls[0].body!)).toEqual({ labels: ["in progress"] });
    expect(JSON.parse(calls[2].body!)).toEqual({ state: "closed" });
  });

  it("quitar una etiqueta que ya no está no es un error, pero un 403 sí", async () => {
    const g = await fresh();
    statusFor = { "DELETE /repos/o/r/issues/7/labels/x": 404 };
    await expect(g.removeLabel("o", "r", 7, "x")).resolves.toBeUndefined();
    statusFor = { "PATCH /repos/o/r/issues/7": 403 };
    await expect(g.setIssueState("o", "r", 7, "open")).rejects.toThrow(/permiso de escritura/);
  });

  it("la dirección de la API solo cambia con la clave de pruebas", async () => {
    const g = await fresh();
    h.store.set("pulso.githubApi", "http://127.0.0.1:9999/");
    await g.addLabel("o", "r", 1, "x");
    expect(calls[0].url.startsWith("http://127.0.0.1:9999/repos/o/r/issues/1/labels")).toBe(true);
    h.store.delete("pulso.githubApi");
    await g.addLabel("o", "r", 1, "x");
    expect(calls[1].url.startsWith("https://api.github.com/")).toBe(true);
  });
});

describe("issues: crear y editar", () => {
  const sent: { method: string; url: string; body: unknown }[] = [];
  let reply: { status: number; json: unknown } = { status: 201, json: { number: 9, title: "x" } };
  beforeEach(() => {
    sent.length = 0;
    reply = { status: 201, json: { number: 9, title: "x" } };
    vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string }) => {
      sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.json };
    });
  });

  it("crear envía título, descripción y etiquetas y devuelve la issue de GitHub", async () => {
    const g = await fresh();
    const issue = await g.createIssue("o", "r", { title: "Hola", body: "texto", labels: ["in progress"] });
    expect(issue.number).toBe(9);
    expect(sent[0].method).toBe("POST");
    expect(new URL(sent[0].url).pathname).toBe("/repos/o/r/issues");
    expect(sent[0].body).toEqual({ title: "Hola", body: "texto", labels: ["in progress"] });
  });

  it("editar solo envía lo que cambia", async () => {
    const g = await fresh();
    reply = { status: 200, json: { number: 4, title: "Nuevo" } };
    await g.updateIssue("o", "r", 4, { title: "Nuevo" });
    expect(sent[0].method).toBe("PATCH");
    expect(new URL(sent[0].url).pathname).toBe("/repos/o/r/issues/4");
    expect(sent[0].body).toEqual({ title: "Nuevo" });
  });

  it("explica los fallos de escritura", async () => {
    const g = await fresh();
    reply = { status: 403, json: {} };
    await expect(g.createIssue("o", "r", { title: "t", body: "", labels: [] })).rejects.toThrow(/permiso de escritura/);
    reply = { status: 422, json: {} };
    await expect(g.updateIssue("o", "r", 1, { title: "" })).rejects.toThrow(/datos no válidos/);
  });
});
