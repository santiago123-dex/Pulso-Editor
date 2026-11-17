import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ result: null as unknown, fail: false, delayed: null as null | ((path: string) => Promise<unknown>) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (_: string, args: { path: string }) => { if (h.fail) throw new Error("git no disponible"); return h.delayed ? h.delayed(args.path) : h.result; },
}));

import { decorate, gitInfo, onGitChange, refreshGit } from "./git";

const info = (files: { path: string; status: string; dir?: boolean }[], extra = {}) => ({
  branch: "main", ahead: 0, behind: 0, dirty: true,
  files: files.map((f) => ({ dir: false, ...f })),
  ...extra,
});

beforeEach(() => { h.result = null; h.fail = false; h.delayed = null; });

describe("refreshGit y decorate", () => {
  it("agrupa consultas simultáneas del mismo repositorio", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise<unknown>((r) => { resolve = r; }));
    h.delayed = fetch;
    const first = refreshGit("C:/r");
    const second = refreshGit("C:/r");
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(info([]));
    expect(await first).toEqual(await second);
  });

  it("ignora resultados de un repositorio anterior después de cambiar de carpeta", async () => {
    let resolve!: (value: unknown) => void;
    h.delayed = (path) => path === "C:/old" ? new Promise((r) => { resolve = r; }) : Promise.resolve(info([], { branch: "nueva" }));
    const old = refreshGit("C:/old");
    await refreshGit("C:/new");
    resolve(info([], { branch: "antigua" }));
    await old;
    expect(gitInfo()?.branch).toBe("nueva");
  });
  it("sin repositorio no decora nada", async () => {
    h.result = null;
    expect(await refreshGit("C:/r")).toBeNull();
    expect(decorate("C:/r/a.ts", false)).toBeNull();
    expect(gitInfo()).toBeNull();
  });

  it("sin carpeta abierta ni siquiera consulta", async () => {
    h.result = info([{ path: "C:/r/a.ts", status: "M" }]);
    expect(await refreshGit(null)).toBeNull();
  });

  it("si git falla se comporta como si no hubiera repositorio", async () => {
    h.fail = true;
    expect(await refreshGit("C:/r")).toBeNull();
  });

  it("marca cada archivo con su letra y su clase", async () => {
    h.result = info([
      { path: "C:/r/m.ts", status: "M" },
      { path: "C:/r/u.ts", status: "U" },
      { path: "C:/r/d.ts", status: "D" },
      { path: "C:/r/a.ts", status: "A" },
      { path: "C:/r/c.ts", status: "!" },
    ]);
    await refreshGit("C:/r");
    expect(decorate("C:/r/m.ts", false)).toEqual({ cls: "git-M", badge: "M" });
    expect(decorate("C:/r/u.ts", false)).toEqual({ cls: "git-U", badge: "U" });
    expect(decorate("C:/r/d.ts", false)).toEqual({ cls: "git-D", badge: "D" });
    expect(decorate("C:/r/a.ts", false)).toEqual({ cls: "git-A", badge: "A" });
    expect(decorate("C:/r/c.ts", false)).toEqual({ cls: "git-C", badge: "!" });
    expect(decorate("C:/r/limpio.ts", false)).toBeNull();
  });

  it("las carpetas con cambios muestran un punto y el estado más grave", async () => {
    h.result = info([
      { path: "C:/r/src/a/nuevo.ts", status: "U" },
      { path: "C:/r/src/a/roto.ts", status: "M" },
      { path: "C:/r/src/b/x.ts", status: "U" },
    ]);
    await refreshGit("C:/r");
    expect(decorate("C:/r/src", true)).toEqual({ cls: "git-M", badge: "\u25CF" });
    expect(decorate("C:/r/src/a", true)).toEqual({ cls: "git-M", badge: "\u25CF" });
    expect(decorate("C:/r/src/b", true)).toEqual({ cls: "git-U", badge: "\u25CF" });
    expect(decorate("C:/r/otra", true)).toBeNull();
  });

  it("un conflicto gana a una modificación en la carpeta", async () => {
    h.result = info([
      { path: "C:/r/src/m.ts", status: "M" },
      { path: "C:/r/src/c.ts", status: "!" },
    ]);
    await refreshGit("C:/r");
    expect(decorate("C:/r/src", true)?.cls).toBe("git-C");
  });

  it("una carpeta sin seguimiento hace que todo lo que contiene sea nuevo", async () => {
    h.result = info([{ path: "C:/r/nueva", status: "U", dir: true }]);
    await refreshGit("C:/r");
    expect(decorate("C:/r/nueva", true)?.cls).toBe("git-U");
    expect(decorate("C:/r/nueva/dentro/x.ts", false)).toEqual({ cls: "git-U", badge: "U" });
  });

  it("lo ignorado se atenúa sin letra y no cuenta como cambio de la carpeta padre", async () => {
    h.result = info([{ path: "C:/r/dist", status: "I", dir: true }, { path: "C:/r/.env", status: "I" }]);
    await refreshGit("C:/r");
    expect(decorate("C:/r/dist", true)).toEqual({ cls: "git-I", badge: "" });
    expect(decorate("C:/r/dist/bundle.js", false)).toEqual({ cls: "git-I", badge: "" });
    expect(decorate("C:/r/.env", false)).toEqual({ cls: "git-I", badge: "" });
    expect(decorate("C:/r", true)).toBeNull();
  });

  it("avisa a los suscriptores con la información nueva", async () => {
    h.result = info([]);
    const seen: (string | null)[] = [];
    onGitChange((i) => seen.push(i ? i.branch : null));
    await refreshGit("C:/r");
    h.result = null;
    await refreshGit("C:/r");
    expect(seen.slice(-2)).toEqual(["main", null]);
  });
});
