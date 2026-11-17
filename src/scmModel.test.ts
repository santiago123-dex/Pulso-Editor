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

import { discardMessage, lastLine, syncInfo } from "./scmModel";

describe("ramas, descartar y sincronizar: lógica pura", () => {
  it("lastLine toma la última línea con texto", () => {
    expect(lastLine("a\nb\n\n")).toBe("b");
    expect(lastLine("")).toBe("");
    expect(lastLine("x\r\nEverything up-to-date\r\n")).toBe("Everything up-to-date");
  });
  it("el aviso de descartar separa lo que se pierde de lo que va a la papelera", () => {
    const msg = discardMessage([ch("a.ts"), ch("b.ts", "D"), ch("nuevo.ts", "U")]);
    expect(msg).toContain("2 archivo(s) volverán");
    expect(msg).toContain("1 archivo(s) nuevos sin seguimiento irán a la papelera");
    expect(msg).toContain("no puede deshacer");
    expect(discardMessage([ch("solo.ts", "U")])).not.toContain("volverán");
  });
  it("el aviso recorta listas largas", () => {
    const many = Array.from({ length: 12 }, (_, i) => ch(`f${i}.ts`));
    expect(discardMessage(many)).toContain("… y 4 más");
  });
  it("los botones de sincronización muestran cuántos commits hay", () => {
    expect(syncInfo(null)).toMatchObject({ pull: "", push: "" });
    const s = syncInfo({ ...base, ahead: 2, behind: 3 });
    expect([s.push, s.pull]).toEqual(["2", "3"]);
    expect(s.pushTip).toContain("2 commit");
  });
});
