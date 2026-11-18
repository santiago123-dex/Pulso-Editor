import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./github", () => ({ getToken: () => "token", apiBase: () => "https://api.github.com", explainStatus: (status: number) => `GitHub ${status}` }));
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
