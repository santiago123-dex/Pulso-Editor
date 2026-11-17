import { describe, expect, it } from "vitest";
import { canCommit, changeCount, pathsOf, type Change, type Changes } from "./scmModel";

const ch = (path: string, status = "M", orig: string | null = null): Change => ({ path, status, orig });
const base: Changes = { top: "/r", branch: "main", ahead: 0, behind: 0, has_head: true, staged: [], unstaged: [], conflicted: [] };

describe("control de código fuente: lógica pura", () => {
  it("confirmar exige algo preparado y un mensaje con texto", () => {
    expect(canCommit(null, "x")).toBe(false);
    expect(canCommit(base, "x")).toBe(false);
    expect(canCommit({ ...base, staged: [ch("a")] }, "   ")).toBe(false);
    expect(canCommit({ ...base, staged: [ch("a")] }, " listo ")).toBe(true);
  });
  it("cuenta preparados, sin preparar y conflictos", () => {
    expect(changeCount(null)).toBe(0);
    expect(changeCount({ ...base, staged: [ch("a")], unstaged: [ch("b"), ch("c", "U")], conflicted: [ch("d", "!")] })).toBe(4);
  });
  it("un renombrado envía el nombre nuevo y el anterior", () => {
    expect(pathsOf([ch("a"), ch("nuevo", "R", "viejo")])).toEqual(["a", "nuevo", "viejo"]);
    expect(pathsOf([])).toEqual([]);
  });
});
