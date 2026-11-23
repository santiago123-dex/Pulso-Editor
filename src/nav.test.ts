import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNav, type Loc } from "./nav";

let opened: Loc[];
const nav = (opts = {}) => createNav(async (l) => { opened.push({ ...l }); }, opts);
const settle = () => new Promise((r) => setTimeout(r, 100));

beforeEach(() => { opened = []; });

describe("historial de navegación", () => {
  it("empieza vacío: no se puede ir ni atrás ni adelante", async () => {
    const n = nav();
    expect(n.canBack()).toBe(false);
    expect(n.canForward()).toBe(false);
    expect(await n.back()).toBe(false);
    expect(await n.forward()).toBe(false);
    expect(opened).toEqual([]);
  });

  it("con un solo sitio recordado tampoco hay a dónde volver", () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    expect(n.canBack()).toBe(false);
  });

  it("pasar de un archivo a otro permite volver y avanzar", async () => {
    const n = nav();
    n.record({ path: "a.ts", line: 10 });
    n.record({ path: "b.ts", line: 3 });
    expect(n.canBack()).toBe(true);
    expect(await n.back()).toBe(true);
    expect(opened).toEqual([{ path: "a.ts", line: 10 }]);
    expect(n.canForward()).toBe(true);
    expect(await n.forward()).toBe(true);
    expect(opened[1]).toEqual({ path: "b.ts", line: 3 });
    expect(n.canForward()).toBe(false);
  });

  it("moverse poco dentro de un archivo no crea un punto nuevo, solo actualiza la línea", () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    for (let l = 2; l <= 7; l++) n.record({ path: "a.ts", line: l });
    expect(n.snapshot().stack).toEqual([{ path: "a.ts", line: 7 }]);
  });

  it("un salto grande en el mismo archivo sí es un punto nuevo", async () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "a.ts", line: 120 });
    expect(n.snapshot().stack.length).toBe(2);
    await n.back();
    expect(opened[0]).toEqual({ path: "a.ts", line: 1 });
  });

  it("el tamaño del salto se puede ajustar", () => {
    const n = nav({ jump: 2 });
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "a.ts", line: 3 });
    expect(n.snapshot().stack.length).toBe(2);
  });

  it("navegar desde el medio del historial descarta lo que había por delante", async () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    n.record({ path: "c.ts", line: 1 });
    await n.back();
    await settle();
    n.record({ path: "d.ts", line: 1 });
    expect(n.snapshot().stack.map((l) => l.path)).toEqual(["a.ts", "b.ts", "d.ts"]);
    expect(n.canForward()).toBe(false);
  });

  it("la apertura que provoca atrás/adelante no se vuelve a registrar", async () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    await n.back();
    // El editor avisa de la posición al abrir: debe ignorarse.
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "zzz.ts", line: 99 });
    expect(n.snapshot().stack.map((l) => l.path)).toEqual(["a.ts", "b.ts"]);
    await settle();
    n.record({ path: "c.ts", line: 1 });
    expect(n.snapshot().stack.map((l) => l.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("recuerda como máximo el límite indicado, olvidando lo más antiguo", () => {
    const n = nav({ limit: 3 });
    for (const p of ["a", "b", "c", "d", "e"]) n.record({ path: p + ".ts", line: 1 });
    expect(n.snapshot().stack.map((l) => l.path)).toEqual(["c.ts", "d.ts", "e.ts"]);
    expect(n.snapshot().idx).toBe(2);
  });

  it("avisa cuando cambia la posibilidad de ir atrás o adelante", async () => {
    const n = nav();
    const f = vi.fn();
    n.onChange(f);
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    const before = f.mock.calls.length;
    await n.back();
    expect(f.mock.calls.length).toBeGreaterThan(before);
  });

  it("olvidar un archivo eliminado quita sus posiciones y mantiene la actual", () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    n.record({ path: "c.ts", line: 1 });
    n.forget("b.ts");
    expect(n.snapshot().stack.map((l) => l.path)).toEqual(["a.ts", "c.ts"]);
    expect(n.snapshot().idx).toBe(1);
  });

  it("olvidar el archivo actual deja el historial en una posición válida", () => {
    const n = nav();
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    n.forget("b.ts");
    expect(n.snapshot().stack.map((l) => l.path)).toEqual(["a.ts"]);
    expect(n.snapshot().idx).toBe(0);
    n.forget("a.ts");
    expect(n.snapshot().idx).toBe(-1);
    expect(n.canBack()).toBe(false);
  });

  it("si abrir una posición falla, el historial sigue siendo usable", async () => {
    let fail = true;
    const n = createNav(async (l) => { if (fail) throw new Error("no existe"); opened.push(l); });
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    await expect(n.back()).rejects.toThrow();
    await settle();
    fail = false;
    expect(n.canForward()).toBe(true);
    await n.forward();
    expect(opened).toEqual([{ path: "b.ts", line: 1 }]);
  });

  it("reset vacía el historial completo y notifica el cambio", () => {
    const n = nav();
    const f = vi.fn();
    n.onChange(f);
    n.record({ path: "a.ts", line: 1 });
    n.record({ path: "b.ts", line: 1 });
    expect(n.canBack()).toBe(true);
    n.reset();
    expect(n.canBack()).toBe(false);
    expect(n.canForward()).toBe(false);
    expect(n.snapshot()).toEqual({ stack: [], idx: -1 });
    expect(f).toHaveBeenCalled();
  });
});
