import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

import { addRecent, clearLastRoot, clearSession, createSessionPersister, getLastRoot, getRecent, loadSession, rel, removeRecent, saveSession, setLastRoot, ws } from "./workspace";

beforeEach(() => { store.clear(); ws.root = null; });

describe("rel", () => {
  it("quita el prefijo de la carpeta abierta", () => {
    ws.root = "C:/proyecto";
    expect(rel("C:/proyecto/src/a.ts")).toBe("src/a.ts");
  });

  it("no confunde carpetas con el mismo comienzo", () => {
    ws.root = "C:/proyecto";
    expect(rel("C:/proyecto-otro/a.ts")).toBe("C:/proyecto-otro/a.ts");
  });

  it("sin carpeta abierta devuelve la ruta tal cual", () => {
    expect(rel("C:/x/a.ts")).toBe("C:/x/a.ts");
  });
});

describe("carpetas recientes", () => {
  it("la última abierta va primero y no se repite", () => {
    addRecent("C:/a"); addRecent("C:/b"); addRecent("C:/a");
    expect(getRecent()).toEqual(["C:/a", "C:/b"]);
  });

  it("guarda como máximo 10", () => {
    for (let i = 0; i < 15; i++) addRecent(`C:/p${i}`);
    const r = getRecent();
    expect(r.length).toBe(10);
    expect(r[0]).toBe("C:/p14");
  });

  it("se puede quitar una", () => {
    addRecent("C:/a"); addRecent("C:/b");
    removeRecent("C:/a");
    expect(getRecent()).toEqual(["C:/b"]);
  });

  it("datos corruptos no rompen: lista vacía", () => {
    store.set("pulso.recent", "{no json");
    expect(getRecent()).toEqual([]);
  });
});

describe("sesión", () => {
  it("guarda y recupera la carpeta y la disposición", () => {
    saveSession({ root: "C:/p", layout: { dir: "row" } });
    expect(loadSession()).toEqual({ root: "C:/p", layout: { dir: "row" } });
  });

  it("clearSession la borra y los datos corruptos devuelven null", () => {
    saveSession({ root: "C:/p", layout: null });
    clearSession();
    expect(loadSession()).toBeNull();
    store.set("pulso.session", "###");
    expect(loadSession()).toBeNull();
  });
});

describe("última carpeta", () => {
  it("se recuerda y se puede olvidar", () => {
    expect(getLastRoot()).toBeNull();
    setLastRoot("C:/proyecto");
    expect(getLastRoot()).toBe("C:/proyecto");
    clearLastRoot();
    expect(getLastRoot()).toBeNull();
  });
});

describe("guardado de sesión protegido", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });
  afterEach(() => { vi.useRealTimers(); });

  it("no guarda nada mientras no se haya restaurado la sesión anterior", () => {
    const save = vi.fn();
    const p = createSessionPersister(save);
    p.schedule();
    p.schedule();
    vi.advanceTimersByTime(5000);
    expect(save).not.toHaveBeenCalled();
    expect(p.isReady()).toBe(false);
  });

  it("un arranque lento no puede pisar la sesión guardada con un estado vacío", () => {
    // La sesión del usuario está en disco; el arranque (iconos, credenciales…) tarda más de 500 ms.
    saveSession({ root: "C:/proyecto", layout: { groups: [{ paths: ["a.ts"] }] } });
    const p = createSessionPersister(() => saveSession({ root: null, layout: {} }));
    p.schedule(); // los eventos del editor al crearse avisan enseguida
    vi.advanceTimersByTime(2000);
    expect(loadSession()?.root).toBe("C:/proyecto");
  });

  it("al marcar como listo guarda una vez, con retraso", () => {
    const save = vi.fn();
    const p = createSessionPersister(save, 500);
    p.markReady();
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("agrupa muchos avisos seguidos en un solo guardado", () => {
    const save = vi.fn();
    const p = createSessionPersister(save, 500);
    p.markReady();
    vi.advanceTimersByTime(600);
    save.mockClear();
    for (let i = 0; i < 20; i++) { p.schedule(); vi.advanceTimersByTime(100); }
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush guarda al instante y cancela el aviso pendiente", () => {
    const save = vi.fn();
    const p = createSessionPersister(save, 500);
    p.markReady();
    vi.advanceTimersByTime(600);
    save.mockClear();
    p.schedule();
    p.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush antes de estar listo tampoco guarda", () => {
    const save = vi.fn();
    const p = createSessionPersister(save);
    p.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
