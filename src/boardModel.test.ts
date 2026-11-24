import { describe, expect, it } from "vitest";
import { applyMove, columnOf, groupIssues, hasLabel, planMove, REVIEW_LABEL } from "./boardModel";
import type { Issue } from "./github";

const issue = (n: number, state = "open", labels: string[] = []): Issue => ({
  number: n, title: `t${n}`, state, html_url: "", user: { login: "u" }, comments: 0,
  labels: labels.map((name) => ({ name, color: "fff" })),
});
const L = "in progress";

describe("tablero: columnas", () => {
  it("cerrada = hecho; abierta con la etiqueta = en curso; abierta sin ella = por hacer", () => {
    expect(columnOf(issue(1, "closed"), L)).toBe("done");
    expect(columnOf(issue(2, "open", ["In Progress"]), L)).toBe("doing");
    expect(columnOf(issue(3, "open", ["bug"]), L)).toBe("todo");
  });
  it("una cerrada con la etiqueta de en curso sigue siendo hecho", () => {
    expect(columnOf(issue(4, "closed", [L]), L)).toBe("done");
  });
  it("prioriza revisión sobre progreso y hecho sobre ambas etiquetas", () => {
    expect(columnOf(issue(1, "open", [L, REVIEW_LABEL]), L)).toBe("review");
    expect(columnOf(issue(2, "closed", [REVIEW_LABEL]), L)).toBe("done");
  });
  it("sin etiqueta configurada nada está en curso", () => {
    expect(hasLabel(issue(5, "open", ["x"]), "")).toBe(false);
    expect(columnOf(issue(5, "open", ["x"]), "  ")).toBe("todo");
  });
  it("agrupa conservando el orden recibido", () => {
    const g = groupIssues([issue(1), issue(2, "open", [L]), issue(3, "closed"), issue(4)], L);
    expect(g.todo.map((i) => i.number)).toEqual([1, 4]);
    expect(g.doing.map((i) => i.number)).toEqual([2]);
    expect(g.done.map((i) => i.number)).toEqual([3]);
  });
});

describe("tablero: qué se pide a GitHub al mover una tarjeta", () => {
  it("soltar en la misma columna no hace nada", () => {
    expect(planMove(issue(1), "todo", L)).toEqual([]);
    expect(planMove(issue(1, "open", [L]), "doing", L)).toEqual([]);
    expect(planMove(issue(1, "closed"), "done", L)).toEqual([]);
  });
  it("por hacer → en curso añade la etiqueta", () => {
    expect(planMove(issue(1), "doing", L)).toEqual([{ op: "addLabel", label: L }]);
  });
  it("en curso → por hacer quita la etiqueta", () => {
    expect(planMove(issue(1, "open", ["In progress"]), "todo", L)).toEqual([{ op: "removeLabel", label: L }]);
  });
  it("a hecho quita la etiqueta antes de cerrar", () => {
    expect(planMove(issue(1, "open", [L]), "done", L)).toEqual([{ op: "removeLabel", label: L }, { op: "close" }]);
    expect(planMove(issue(1), "done", L)).toEqual([{ op: "close" }]);
  });
  it("de hecho a por hacer o en curso reabre primero", () => {
    expect(planMove(issue(1, "closed"), "todo", L)).toEqual([{ op: "open" }]);
    expect(planMove(issue(1, "closed"), "doing", L)).toEqual([{ op: "open" }, { op: "addLabel", label: L }]);
    expect(planMove(issue(1, "closed", [L]), "todo", L)).toEqual([{ op: "open" }, { op: "removeLabel", label: L }]);
    // Ya lleva la etiqueta: no se añade dos veces.
    expect(planMove(issue(1, "closed", [L]), "doing", L)).toEqual([{ op: "open" }]);
  });
  it("mueve entre revisión y los demás estados sin dejar etiquetas de estado obsoletas", () => {
    expect(planMove(issue(1, "open", [L]), "review", L)).toEqual([{ op: "removeLabel", label: L }, { op: "addLabel", label: REVIEW_LABEL }]);
    expect(planMove(issue(1, "open", [REVIEW_LABEL]), "doing", L)).toEqual([{ op: "removeLabel", label: REVIEW_LABEL }, { op: "addLabel", label: L }]);
    expect(planMove(issue(1, "open", [REVIEW_LABEL]), "done", L)).toEqual([{ op: "removeLabel", label: REVIEW_LABEL }, { op: "close" }]);
    expect(planMove(issue(1, "closed"), "review", L)).toEqual([{ op: "open" }, { op: "addLabel", label: REVIEW_LABEL }]);
  });
});

describe("tablero: vista previa del movimiento", () => {
  it("deja la issue como quedaría en GitHub sin modificar la original", () => {
    const original = issue(1, "open", ["bug"]);
    const moved = applyMove(original, "doing", L);
    expect(moved.labels.map((l) => l.name)).toEqual(["bug", L]);
    expect(columnOf(moved, L)).toBe("doing");
    expect(original.labels).toHaveLength(1);
    const done = applyMove(moved, "done", L);
    expect(done.state).toBe("closed");
    expect(done.labels.map((l) => l.name)).toEqual(["bug"]);
    const back = applyMove(done, "todo", L);
    expect(columnOf(back, L)).toBe("todo");
  });
});

import { labelsForNew, labelsText, parseLabels, refreshDue, sameIssues, upsertIssue } from "./boardModel";

describe("tablero: crear, editar y recargar", () => {
  it("parseLabels recorta, quita vacías y repetidas", () => {
    expect(parseLabels(" bug, ui ,, BUG , ")).toEqual(["bug", "ui"]);
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels("in progress")).toEqual(["in progress"]);
  });
  it("labelsText y parseLabels son inversas", () => {
    const i = issue(1, "open", ["bug", "in progress"]);
    expect(parseLabels(labelsText(i))).toEqual(["bug", "in progress"]);
  });
  it("una issue nueva en «En curso» nace con la etiqueta de progreso; en las otras, sin ella", () => {
    expect(labelsForNew("doing", " in progress ")).toEqual(["in progress"]);
    expect(labelsForNew("todo", "in progress")).toEqual([]);
    expect(labelsForNew("doing", "")).toEqual([]);
    expect(labelsForNew("review", L)).toEqual([REVIEW_LABEL]);
  });
  it("upsert reemplaza por número o añade la nueva al principio", () => {
    const list = [issue(1), issue(2)];
    expect(upsertIssue(list, { ...issue(2), title: "nuevo" }).map((i) => i.title)).toEqual(["t1", "nuevo"]);
    expect(upsertIssue(list, issue(3)).map((i) => i.number)).toEqual([3, 1, 2]);
  });
  it("sameIssues ignora el orden pero detecta cualquier cambio visible", () => {
    const a = [issue(1), issue(2, "open", ["x"])];
    expect(sameIssues(a, [a[1], a[0]])).toBe(true);
    expect(sameIssues(a, [a[0]])).toBe(false);
    expect(sameIssues(a, [a[0], { ...a[1], title: "otro" }])).toBe(false);
    expect(sameIssues(a, [a[0], { ...a[1], labels: [] }])).toBe(false);
    expect(sameIssues(a, [a[0], { ...a[1], state: "closed" }])).toBe(false);
    expect(sameIssues(a, [a[0], { ...a[1], comments: 4 }])).toBe(false);
  });
});

describe("tablero: cuándo recargar solo", () => {
  const base = { now: 100_000, last: 0, minGap: 5000, interval: 60_000, trigger: "focus" as const, hasToken: true, visible: true, busy: false, blocked: false };
  it("al volver a la ventana recarga si pasó el intervalo mínimo", () => {
    expect(refreshDue(base)).toBe(true);
    expect(refreshDue({ ...base, last: 98_000 })).toBe(false);
  });
  it("el temporizador solo actúa con token y cuando toca", () => {
    expect(refreshDue({ ...base, trigger: "timer", last: 30_000 })).toBe(true);
    expect(refreshDue({ ...base, trigger: "timer", last: 50_000 })).toBe(false);
    expect(refreshDue({ ...base, trigger: "timer", hasToken: false })).toBe(false);
  });
  it("nunca con diálogo o arrastre, cambio en curso o ventana oculta", () => {
    for (const patch of [{ blocked: true }, { busy: true }, { visible: false }]) {
      expect(refreshDue({ ...base, ...patch })).toBe(false);
      expect(refreshDue({ ...base, ...patch, trigger: "timer" })).toBe(false);
    }
  });
});

describe("columnas personalizadas y orden dentro de la columna", () => {
  it("parsea columnas personalizadas sin duplicados", async () => {
    const { parseCustomColumns, orderColumnIssues, moveInOrder } = await import("./boardModel");
    expect(parseCustomColumns("Bloqueado=blocked, QA=qa\nQA=qa")).toEqual([
      { id: "custom:blocked", title: "Bloqueado", label: "blocked" },
      { id: "custom:qa", title: "QA", label: "qa" },
    ]);
    const list = [
      { number: 1, title: "a", state: "open", labels: [], user: { login: "u" }, comments: 0, html_url: "" },
      { number: 2, title: "b", state: "open", labels: [], user: { login: "u" }, comments: 0, html_url: "" },
      { number: 3, title: "c", state: "open", labels: [], user: { login: "u" }, comments: 0, html_url: "" },
    ] as never[];
    expect(orderColumnIssues(list, [3, 1]).map((i) => i.number)).toEqual([3, 1, 2]);
    expect(moveInOrder([3, 1, 2], 1, -1, [1, 2, 3])).toEqual([1, 3, 2]);
    expect(moveInOrder([3, 1, 2], 1, 1, [1, 2, 3])).toEqual([3, 2, 1]);
  });
});
