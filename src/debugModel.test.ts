import { describe, expect, it } from "vitest";
import {
  appendConsole,
  breakpointsForFile,
  countBreakpoints,
  formatFrameLocation,
  loadBreakpoints,
  removeBreakpoint,
  saveBreakpoints,
  toDapBreakpoints,
  toggleBreakpoint,
  type BreakpointMap,
} from "./debugModel";

function memStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

describe("debugModel", () => {
  it("alterna, ordena y elimina puntos de interrupción por archivo", () => {
    let map: BreakpointMap = {};
    map = toggleBreakpoint(map, "C:\\repo\\app.py", 12);
    map = toggleBreakpoint(map, "C:/repo/app.py", 4);
    expect(breakpointsForFile(map, "C:/repo/app.py")).toEqual([4, 12]);
    expect(countBreakpoints(map)).toBe(2);

    map = removeBreakpoint(map, "C:/repo/app.py", 4);
    expect(breakpointsForFile(map, "C:/repo/app.py")).toEqual([12]);

    map = toggleBreakpoint(map, "C:/repo/app.py", 12);
    expect(breakpointsForFile(map, "C:/repo/app.py")).toEqual([]);
    expect(toDapBreakpoints(map)).toEqual([]);
  });

  it("ignora líneas inválidas y guarda/carga desde almacenamiento", () => {
    const store = memStore();
    let map: BreakpointMap = {};
    map = toggleBreakpoint(map, "src/a.py", 0);
    map = toggleBreakpoint(map, "src/a.py", -3);
    map = toggleBreakpoint(map, "src/a.py", 7);
    expect(countBreakpoints(map)).toBe(1);

    saveBreakpoints(map, store);
    const loaded = loadBreakpoints(store);
    expect(breakpointsForFile(loaded, "src/a.py")).toEqual([7]);
  });

  it("limita la consola de depuración y formatea marcos de pila", () => {
    let entries = appendConsole([], { kind: "stdout", text: "1" }, 2);
    entries = appendConsole(entries, { kind: "stdout", text: "2" }, 2);
    entries = appendConsole(entries, { kind: "stderr", text: "3" }, 2);
    expect(entries.map((e) => e.text)).toEqual(["2", "3"]);

    expect(formatFrameLocation({ id: 1, name: "main", source: "C:/repo/main.py", line: 25, column: 1 })).toBe("main.py:25");
    expect(formatFrameLocation({ id: 2, name: "<eval>", source: null, line: 3, column: 1 })).toBe(":3");
  });
});
