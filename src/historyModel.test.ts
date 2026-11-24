import { describe, expect, it } from "vitest";
import { agoFrom, agoIso, blameText, computeGraphRows, mayHaveMore, mergeCommits, refChips, relativeToTop, type CommitInfo } from "./historyModel";

const c = (hash: string, subject = "x", parents: string[] = []): CommitInfo => ({ hash, short: hash.slice(0, 7), author: "a", email: "a@x", date: "2026-01-01T00:00:00Z", subject, refs: [], parents });

describe("refChips", () => {
  it("distingue la rama actual, ramas, remotos y etiquetas, y omite origin/HEAD", () => {
    expect(refChips(["HEAD -> main", "origin/main", "origin/HEAD", "tag: v1.0", "feature"])).toEqual([
      { label: "main", kind: "head" }, { label: "origin/main", kind: "remote" }, { label: "v1.0", kind: "tag" }, { label: "feature", kind: "branch" },
    ]);
    expect(refChips(["HEAD"])).toEqual([{ label: "HEAD", kind: "head" }]);
    expect(refChips([])).toEqual([]);
  });
});

describe("mergeCommits y mayHaveMore", () => {
  it("añade páginas sin repetir commits y conserva el orden", () => {
    expect(mergeCommits([c("a"), c("b")], [c("b"), c("c")]).map((x) => x.hash)).toEqual(["a", "b", "c"]);
  });
  it("una página incompleta es la última", () => {
    expect(mayHaveMore(new Array(40).fill(0))).toBe(true);
    expect(mayHaveMore(new Array(12).fill(0))).toBe(false);
    expect(mayHaveMore([], 5)).toBe(false);
  });
});

describe("agoFrom", () => {
  const NOW = Date.parse("2026-11-18T12:00:00Z");
  it("escala de momentos a años con el plural correcto", () => {
    expect(agoFrom(NOW - 5_000, NOW)).toBe("hace un momento");
    expect(agoFrom(NOW - 5 * 60_000, NOW)).toBe("hace 5 min");
    expect(agoFrom(NOW - 3 * 3600_000, NOW)).toBe("hace 3 h");
    expect(agoFrom(NOW - 4 * 86400_000, NOW)).toBe("hace 4 d");
    expect(agoFrom(NOW - 40 * 86400_000, NOW)).toBe("hace 1 mes");
    expect(agoFrom(NOW - 100 * 86400_000, NOW)).toBe("hace 3 meses");
    expect(agoFrom(NOW - 400 * 86400_000, NOW)).toBe("hace 1 año");
    expect(agoFrom(NOW - 800 * 86400_000, NOW)).toBe("hace 2 años");
  });
  it("una fecha futura o inválida no rompe", () => {
    expect(agoFrom(NOW + 10_000, NOW)).toBe("hace un momento");
    expect(agoIso("no es fecha")).toBe("");
  });
});

describe("relativeToTop", () => {
  it("recorta la raíz sin distinguir mayúsculas ni tipo de barra", () => {
    expect(relativeToTop("C:/Proyecto/src/a.ts", "c:/proyecto")).toBe("src/a.ts");
    expect(relativeToTop("C:\\Proyecto\\src\\a.ts", "C:/Proyecto/")).toBe("src/a.ts");
  });
  it("fuera del repositorio devuelve null y una carpeta con el mismo prefijo no cuenta", () => {
    expect(relativeToTop("C:/otra/a.ts", "C:/proyecto")).toBeNull();
    expect(relativeToTop("C:/proyecto-2/a.ts", "C:/proyecto")).toBeNull();
  });
});

describe("blameText", () => {
  const NOW = 1_700_000_000_000;
  it("autor, cuándo y resumen; recorta resúmenes largos", () => {
    expect(blameText({ line: 1, hash: "abc", author: "Ana", time: NOW / 1000 - 7200, summary: "arregla el login" }, NOW)).toBe("Ana, hace 2 h · arregla el login");
    expect(blameText({ line: 1, hash: "abc", author: "Ana", time: NOW / 1000, summary: "x".repeat(80) }, NOW)).toMatch(/…$/);
  });
  it("una línea sin commit lo dice y sin datos no muestra nada", () => {
    expect(blameText({ line: 1, hash: "", author: "Not Committed Yet", time: 0, summary: "" })).toBe("Cambio sin confirmar");
    expect(blameText(undefined)).toBe("");
  });
});

describe("computeGraphRows", () => {
  it("calcula carriles para historial lineal y fusiones de dos padres", () => {
    const rows = computeGraphRows([
      c("m1", "merge", ["p1", "p2"]),
      c("p2", "rama feat", ["base"]),
      c("p1", "main", ["base"]),
      c("base", "inicial", []),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].edges).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
    ]);
    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(0);
    expect(rows[2].edges).toEqual([{ from: 0, to: rows[3].lane, color: 0 }]);
  });
});
