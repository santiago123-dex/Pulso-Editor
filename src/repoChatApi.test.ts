import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./github", () => {
  class GithubError extends Error { constructor(readonly status: number, writing = false) { super(`error ${status}${writing ? " (escritura)" : ""}`); } }
  return { getToken: () => "token-prueba", apiBase: () => "https://api.github.com", GithubError };
});
import { githubChatStore } from "./repoChatApi";

const repo = { owner: "equipo", repo: "proyecto" };
const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), init);
beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe("sala del chat", () => {
  it("encuentra la sala por su etiqueta y se queda con la más antigua que no sea una PR", async () => {
    const fetch = vi.fn().mockResolvedValue(json([{ number: 9, title: "PR", html_url: "u9", pull_request: {} }, { number: 3, title: "💬 Chat de Pulso", html_url: "u3" }, { number: 5, title: "otra", html_url: "u5" }]));
    vi.stubGlobal("fetch", fetch);
    expect(await githubChatStore.findRoom(repo)).toEqual({ number: 3, title: "💬 Chat de Pulso", html_url: "u3" });
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("/repos/equipo/proyecto/issues?labels=pulso-chat");
    expect(url).toContain("direction=asc");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer token-prueba");
  });
  it("sin sala devuelve null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([])));
    expect(await githubChatStore.findRoom(repo)).toBeNull();
  });
  it("al crearla intenta crear la etiqueta y publica la issue con ella: solo dos llamadas", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({}, { status: 201 }))
      .mockResolvedValueOnce(json({ number: 12, title: "💬 Chat de Pulso", html_url: "u12" }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await githubChatStore.createRoom(repo)).toEqual({ number: 12, title: "💬 Chat de Pulso", html_url: "u12" });
    expect(fetch.mock.calls.map((c) => `${c[1].method} ${new URL(String(c[0])).pathname}`)).toEqual([
      "POST /repos/equipo/proyecto/labels", "POST /repos/equipo/proyecto/issues",
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body).labels).toEqual(["pulso-chat"]);
  });
  it("si otra persona creó la etiqueta a la vez (422) sigue adelante", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 422 })).mockResolvedValueOnce(json({ number: 1, title: "t", html_url: "u" }));
    vi.stubGlobal("fetch", fetch);
    await expect(githubChatStore.createRoom(repo)).resolves.toMatchObject({ number: 1 });
  });
});

describe("estado de la sala", () => {
  it("abierta, cerrada, borrada y sin cambios", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ state: "open" }, { headers: { etag: '"a"' } })).mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(json({ state: "closed" })).mockResolvedValueOnce(new Response("", { status: 404 })));
    expect(await githubChatStore.roomOpen(repo, 3)).toBe(true);
    expect(await githubChatStore.roomOpen(repo, 3)).toBeNull();
    expect(await githubChatStore.roomOpen(repo, 3)).toBe(false);
    expect(await githubChatStore.roomOpen(repo, 3)).toBe(false);
  });
});

describe("mensajes", () => {
  it("envía comentarios y conserva el contenido", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: 1 }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await githubChatStore.send(repo, 42, "Hola equipo");
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repos/equipo/proyecto/issues/42/comments");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ body: "Hola equipo" });
  });
  it("lee las páginas recientes sin seguir URLs externas del encabezado", async () => {
    const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(json([{ id: Number(url.match(/page=(\d+)$/)?.[1]) }], { headers: url.endsWith("page=1") ? { link: '<https://ejemplo.invalid/?page=7>; rel="last"' } : {} })));
    vi.stubGlobal("fetch", fetch);
    const result = await githubChatStore.comments(repo, 42);
    expect(result.map((c) => c.id)).toEqual([3, 4, 5, 6, 7]);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/"))).toBe(true);
  });
  it("las consultas de mensajes nuevos usan ETag: un 304 devuelve null sin descargar nada", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json([{ id: 5 }], { headers: { etag: '"abc"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetch);
    expect(await githubChatStore.newer(repo, 7, "2026-01-01T00:00:00Z")).toEqual([{ id: 5 }]);
    expect(fetch.mock.calls[0][1].headers["If-None-Match"]).toBeUndefined();
    expect(await githubChatStore.newer(repo, 7, "2026-01-01T00:00:00Z")).toBeNull();
    expect(fetch.mock.calls[1][1].headers["If-None-Match"]).toBe('"abc"');
  });
  it("un fallo de GitHub se reporta con su código", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(githubChatStore.comments(repo, 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe("personas", () => {
  it("muestra contribuyentes cuando no se pueden consultar colaboradores", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 403 })).mockResolvedValueOnce(json([{ login: "ana" }]));
    vi.stubGlobal("fetch", fetch);
    expect(await githubChatStore.members(repo)).toEqual({ users: [{ login: "ana" }], kind: "contributors" });
  });
});
