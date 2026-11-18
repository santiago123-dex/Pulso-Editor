import { describe, expect, it } from "vitest";
import { applyTextEdits, collectEdits, type LspEdit } from "./lspEdits";

const e = (l1: number, c1: number, l2: number, c2: number, newText: string): LspEdit => ({ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, newText });

describe("applyTextEdits", () => {
  it("reemplaza varias coincidencias sin que se desplacen las posiciones", () => {
    const text = "let saludo = 1;\nconsole.log(saludo);\n";
    expect(applyTextEdits(text, [e(0, 4, 0, 10, "hola"), e(1, 12, 1, 18, "hola")])).toBe("let hola = 1;\nconsole.log(hola);\n");
  });
  it("respeta archivos con fin de línea de Windows", () => {
    const text = "a\r\nfoo\r\nfoo\r\n";
    expect(applyTextEdits(text, [e(1, 0, 1, 3, "barra"), e(2, 0, 2, 3, "barra")])).toBe("a\r\nbarra\r\nbarra\r\n");
  });
  it("acepta ediciones en cualquier orden", () => {
    expect(applyTextEdits("abc abc", [e(0, 4, 0, 7, "X"), e(0, 0, 0, 3, "X")])).toBe("X X");
  });
  it("las inserciones vacías se aplican y un carácter pasado el final de la línea se recorta", () => {
    expect(applyTextEdits("ab\ncd", [e(0, 2, 0, 2, "!")])).toBe("ab!\ncd");
    expect(applyTextEdits("ab\ncd", [e(0, 99, 0, 99, "!")])).toBe("ab!\ncd");
  });
  it("rechaza ediciones solapadas, invertidas o fuera del archivo", () => {
    expect(() => applyTextEdits("abcdef", [e(0, 0, 0, 4, "x"), e(0, 2, 0, 5, "y")])).toThrow(/solapadas/);
    expect(() => applyTextEdits("abcdef", [e(0, 4, 0, 2, "x")])).toThrow(/final antes/);
    expect(() => applyTextEdits("abc", [e(5, 0, 5, 1, "x")])).toThrow(/fuera del archivo/);
  });
  it("sin ediciones devuelve el mismo texto", () => {
    expect(applyTextEdits("igual", [])).toBe("igual");
  });
});

describe("collectEdits", () => {
  it("junta `changes` y `documentChanges` por archivo", () => {
    const m = collectEdits({
      changes: { "file:///a.ts": [e(0, 0, 0, 1, "x")] },
      documentChanges: [{ textDocument: { uri: "file:///a.ts" }, edits: [e(1, 0, 1, 1, "y")] }, { textDocument: { uri: "file:///b.ts" }, edits: [e(0, 0, 0, 1, "z")] }],
    });
    expect(m.get("file:///a.ts")).toHaveLength(2);
    expect(m.get("file:///b.ts")).toHaveLength(1);
  });
  it("rechaza renombrar o crear archivos y tolera una respuesta vacía", () => {
    expect(() => collectEdits({ documentChanges: [{ kind: "rename" }] })).toThrow(/no admite|aún no admite/);
    expect(collectEdits(null).size).toBe(0);
  });
});
