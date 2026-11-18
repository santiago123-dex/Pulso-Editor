import { describe, expect, it } from "vitest";
import { branchLabel, explainCreateError, fileLetter, humanizeBranch, newPullProblem, prState, suggestTitle, totals, type PullSummary } from "./prModel";

const pr = (extra: Partial<PullSummary> = {}): PullSummary => ({
  number: 1, title: "t", state: "open", merged_at: null, html_url: "u", user: { login: "ana" },
  head: { ref: "feature/x", sha: "h" }, base: { ref: "main", sha: "b" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...extra,
});

describe("prState y branchLabel", () => {
  it("fusionada manda sobre cerrada, y el borrador solo cuenta si está abierta", () => {
    expect(prState(pr())).toBe("open");
    expect(prState(pr({ draft: true }))).toBe("draft");
    expect(prState(pr({ state: "closed" }))).toBe("closed");
    expect(prState(pr({ state: "closed", merged_at: "2026-01-02T00:00:00Z" }))).toBe("merged");
    expect(prState(pr({ state: "closed", draft: true }))).toBe("closed");
  });
  it("muestra de qué rama a qué rama va", () => { expect(branchLabel(pr())).toBe("feature/x → main"); });
});

describe("archivos", () => {
  it("las letras coinciden con las del panel de Git y todo lo demás es modificado", () => {
    expect([fileLetter("added"), fileLetter("removed"), fileLetter("renamed"), fileLetter("modified"), fileLetter("changed")]).toEqual(["A", "D", "R", "M", "M"]);
  });
  it("suma líneas añadidas y quitadas", () => {
    expect(totals([{ additions: 3, deletions: 1 }, { additions: 10, deletions: 0 }])).toEqual({ additions: 13, deletions: 1 });
    expect(totals([])).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("títulos propuestos", () => {
  it("humaniza el nombre de la rama", () => {
    expect(humanizeBranch("feature/mi-cambio_nuevo")).toBe("Mi cambio nuevo");
    expect(humanizeBranch("arreglo")).toBe("Arreglo");
    expect(humanizeBranch("")).toBe("");
  });
  it("prefiere el último commit", () => {
    expect(suggestTitle("Añade el chat", "feature/x")).toBe("Añade el chat");
    expect(suggestTitle("  ", "feature/mi-rama")).toBe("Mi rama");
    expect(suggestTitle(null, "fix-login")).toBe("Fix login");
  });
});

describe("newPullProblem", () => {
  const ok = { title: "T", head: "feature/x", base: "main", hasUpstream: true };
  it("sin problemas devuelve null", () => { expect(newPullProblem(ok)).toBeNull(); });
  it("explica cada obstáculo con su remedio", () => {
    expect(newPullProblem({ ...ok, head: "" })).toMatch(/rama activa/);
    expect(newPullProblem({ ...ok, head: "main" })).toMatch(/Crea otra rama/);
    expect(newPullProblem({ ...ok, hasUpstream: false })).toMatch(/Súbela primero/);
    expect(newPullProblem({ ...ok, title: "  " })).toMatch(/título/);
  });
});

describe("explainCreateError", () => {
  it("traduce los casos habituales", () => {
    expect(explainCreateError(422, { errors: [{ message: "A pull request already exists for ana:feature." }] })).toMatch(/Ya hay una pull request/);
    expect(explainCreateError(422, { errors: [{ message: "No commits between main and feature" }] })).toMatch(/no tiene commits nuevos/);
    expect(explainCreateError(404, null)).toMatch(/no encontró/);
    expect(explainCreateError(403, null)).toMatch(/permiso de escritura/);
  });
  it("si no reconoce el error muestra el de GitHub o el código", () => {
    expect(explainCreateError(422, { errors: [{ message: "raro" }] })).toContain("raro");
    expect(explainCreateError(422, { message: "Validation Failed" })).toContain("Validation Failed");
    expect(explainCreateError(500, null)).toBe("GitHub respondió 500");
  });
});
