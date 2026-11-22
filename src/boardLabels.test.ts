import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./github", () => ({
  explainStatus: (status: number) => `GitHub ${status}`,
  githubFetch: async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method: opts.method ?? "GET",
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer token", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { ok: res.ok, status: res.status, etag: null, link: null, text: () => res.text(), json: () => res.json() };
  },
}));
import { ensureBoardLabel } from "./boardLabels";

afterEach(() => vi.unstubAllGlobals());
describe("etiquetas del tablero", () => {
  it("reutiliza una etiqueta existente", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await ensureBoardLabel("equipo", "repo", "in progress");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("in%20progress");
  });
  it("crea la etiqueta de estado si no existe", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response("{}", { status: 201 })); vi.stubGlobal("fetch", fetch);
    await ensureBoardLabel("equipo", "repo", "pulso: in review");
    expect(fetch.mock.calls[1][1].method).toBe("POST");
    expect(JSON.parse(fetch.mock.calls[1][1].body).name).toBe("pulso: in review");
  });
  it("informa el error cuando no se puede crear la etiqueta", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response("", { status: 403 })); vi.stubGlobal("fetch", fetch);
    await expect(ensureBoardLabel("equipo", "repo", "in progress")).rejects.toThrow("GitHub 403");
  });
});
