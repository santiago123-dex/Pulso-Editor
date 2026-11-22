import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonStorage, readStorage, removeStorage, writeJsonStorage, writeStorage } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("storage seguro", () => {
  it("no falla cuando localStorage no existe (entorno Node)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readStorage("k")).toBeNull();
    expect(writeStorage("k", "v")).toBe(false);
    expect(readJsonStorage("k", { ok: true })).toEqual({ ok: true });
    expect(() => removeStorage("k")).not.toThrow();
  });

  it("lee, escribe, borra y recupera ante JSON corrupto", () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      removeItem: (k: string) => map.delete(k),
    });

    expect(writeJsonStorage("pulso.test", { n: 42 })).toBe(true);
    expect(readJsonStorage("pulso.test", { n: 0 })).toEqual({ n: 42 });

    writeStorage("pulso.bad", "{corrupto");
    expect(readJsonStorage("pulso.bad", ["fallback"])).toEqual(["fallback"]);

    removeStorage("pulso.test");
    expect(readStorage("pulso.test")).toBeNull();
  });
});
