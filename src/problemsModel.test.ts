import { describe, expect, it } from "vitest";
import { countProblems, groupProblems, selectionLength, severityOf, statusText, summaryText, type Problem } from "./problemsModel";

const p = (path: string, line: number, severity: Problem["severity"], extra: Partial<Problem> = {}): Problem => ({
  path,
  line,
  col: 1,
  endLine: line,
  endCol: 4,
  severity,
  message: "m",
  ...extra,
});

describe("severityOf", () => {
  it("traduce los niveles de Monaco y descarta las pistas", () => {
    expect(severityOf(8)).toBe("error");
    expect(severityOf(4)).toBe("warning");
    expect(severityOf(2)).toBe("info");
    expect(severityOf(1)).toBeNull();
  });
});

describe("groupProblems", () => {
  const list = [p("b.ts", 9, "warning"), p("a.ts", 5, "error"), p("b.ts", 2, "error"), p("b.ts", 3, "error"), p("c.ts", 1, "info")];
  it("pone primero los archivos con más errores y ordena por línea", () => {
    const g = groupProblems(list);
    expect(g.map((f) => f.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(g[0].items.map((i) => i.line)).toEqual([2, 3, 9]);
  });
  it("«solo errores» oculta lo demás y los archivos que se quedan vacíos", () => {
    const g = groupProblems(list, true);
    expect(g.map((f) => f.path)).toEqual(["b.ts", "a.ts"]);
    expect(g[0].items.every((i) => i.severity === "error")).toBe(true);
  });
  it("en la misma línea y columna el error va antes que el aviso", () => {
    const g = groupProblems([p("a.ts", 1, "warning"), p("a.ts", 1, "error")]);
    expect(g[0].items.map((i) => i.severity)).toEqual(["error", "warning"]);
  });
  it("sin problemas devuelve una lista vacía", () => {
    expect(groupProblems([])).toEqual([]);
  });
});

describe("textos", () => {
  it("cuenta y resume con el plural correcto", () => {
    const c = countProblems([p("a", 1, "error"), p("a", 2, "error"), p("a", 3, "warning")]);
    expect(c).toEqual({ error: 2, warning: 1, info: 0 });
    expect(summaryText(c)).toBe("2 errores, 1 aviso");
    expect(summaryText({ error: 1, warning: 0, info: 2 })).toBe("1 error, 2 informaciones");
    expect(summaryText({ error: 0, warning: 0, info: 0 })).toBe("Sin problemas");
  });
  it("la barra de estado muestra solo errores y avisos", () => {
    expect(statusText({ error: 2, warning: 1, info: 5 })).toBe("✖ 2  ⚠ 1");
    expect(statusText({ error: 0, warning: 3, info: 0 })).toBe("⚠ 3");
    expect(statusText({ error: 0, warning: 0, info: 4 })).toBe("");
  });
});

describe("selectionLength", () => {
  it("selecciona el rango si cabe en una línea y nada si ocupa varias", () => {
    expect(selectionLength(p("a", 1, "error", { col: 3, endCol: 8 }))).toBe(5);
    expect(selectionLength(p("a", 1, "error", { endLine: 2 }))).toBe(0);
    expect(selectionLength(p("a", 1, "error", { col: 5, endCol: 2 }))).toBe(0);
  });
});
