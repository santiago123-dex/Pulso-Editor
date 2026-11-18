import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./github", () => {
  class GithubError extends Error { constructor(readonly status: number) { super(`error ${status}`); } }
  const cache = new Map<string, unknown>();
  return {
    GithubError,
    apiBase: () => "https://api.github.com",
    authHeaders: (json = false) => ({ Accept: "application/vnd.github+json", Authorization: "Bearer t", ...(json ? { "Content-Type": "application/json" } : {}) }),
    getJson: async (path: string) => {
      const res = await fetch(`https://api.github.com${path}`);
      if (!res.ok) throw new GithubError(res.status);
      const data = await res.json();
      cache.set(path, data);
      return data;
    },
  };
});
import { createPull, fileAt, listPulls, mergeBase, pullFiles, pullSources } from "./pulls";

afterEach(() => vi.unstubAllGlobals());
const json = (d: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(d), init);
const pr = { number: 7, head: { ref: "f", sha: "HEAD" }, base: { ref: "main", sha: "BASE" } } as never;

describe("listado y archivos", () => {
  it("pide el estado y ordena por actividad reciente", async () => {
    const fetch = vi.fn().mockResolvedValue(json([]));
    vi.stubGlobal("fetch", fetch);
    await listPulls("o", "r", "all");
    expect(String(fetch.mock.calls[0][0])).toContain("/repos/o/r/pulls?state=all&per_page=50&sort=updated&direction=desc");
  });
  it("lee varias páginas de archivos hasta que una venga incompleta", async () => {
    const page = (n: number) => json(new Array(n).fill({ filename: "a", status: "modified", additions: 1, deletions: 0 }));
    const fetch = vi.fn().mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(5));
    vi.stubGlobal("fetch", fetch);
    expect((await pullFiles("o", "r", 7)).length).toBe(205);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("mergeBase y contenido", () => {
  it("usa el ancestro común y, si falla, la punta de la rama de destino", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ merge_base_commit: { sha: "MB" } })));
    expect(await mergeBase("o", "r", pr)).toBe("MB");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect(await mergeBase("o", "r", pr)).toBe("BASE");
  });
  it("pide el contenido en bruto de ese commit, codifica la ruta y trata 404 como archivo inexistente", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("hola")).mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    expect(await fileAt("o", "r", "abc", "src/mi archivo.ts")).toBe("hola");
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.github.com/repos/o/r/contents/src/mi%20archivo.ts?ref=abc");
    expect(fetch.mock.calls[0][1].headers.Accept).toBe("application/vnd.github.raw+json");
    expect(await fileAt("o", "r", "abc", "x")).toBe("");
  });
});

describe("pullSources", () => {
  const texts: Record<string, string> = { "MB:old.ts": "viejo", "HEAD:new.ts": "nuevo", "MB:same.ts": "a", "HEAD:same.ts": "b" };
  const stub = () => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const m = String(url).match(/contents\/(.+)\?ref=(.+)$/);
    const text = m && texts[`${m[2]}:${decodeURIComponent(m[1])}`];
    return text === undefined || text === null ? new Response("", { status: 404 }) : new Response(text);
  }));
  it("compara el ancestro común con la punta de la rama, y los archivos añadidos o eliminados no piden la otra versión", async () => {
    stub();
    const f = (status: string, filename: string, previous?: string) => ({ filename, status, additions: 0, deletions: 0, previous_filename: previous });
    expect(await pullSources("o", "r", pr, "MB", f("modified", "same.ts"))).toEqual({ original: "a", modified: "b", binary: false });
    expect(await pullSources("o", "r", pr, "MB", f("added", "new.ts"))).toEqual({ original: "", modified: "nuevo", binary: false });
    expect(await pullSources("o", "r", pr, "MB", f("removed", "old.ts"))).toEqual({ original: "viejo", modified: "", binary: false });
    expect(await pullSources("o", "r", pr, "MB", f("renamed", "new.ts", "old.ts"))).toEqual({ original: "viejo", modified: "nuevo", binary: false });
  });
  it("detecta archivos binarios", async () => {
    texts["HEAD:img.bin"] = "AB\u0000CD";
    stub();
    expect((await pullSources("o", "r", pr, "MB", { filename: "img.bin", status: "added", additions: 0, deletions: 0 })).binary).toBe(true);
  });
});

describe("createPull", () => {
  it("envía rama, destino, título y descripción", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ number: 9 }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await createPull("o", "r", { title: "T", head: "f", base: "main", body: "B" })).toEqual({ number: 9 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ title: "T", head: "f", base: "main", body: "B" });
    expect(fetch.mock.calls[0][1].method).toBe("POST");
  });
  it("explica los errores de GitHub en español", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: "Validation Failed", errors: [{ message: "A pull request already exists for o:f." }] }, { status: 422 })));
    await expect(createPull("o", "r", { title: "T", head: "f", base: "main", body: "" })).rejects.toThrow(/Ya hay una pull request/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no json", { status: 403 })));
    await expect(createPull("o", "r", { title: "T", head: "f", base: "main", body: "" })).rejects.toThrow(/permiso de escritura/);
  });
});
