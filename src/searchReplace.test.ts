import { describe, expect, it } from "vitest";
import { computeLineReplacements } from "./searchReplace";

describe("computeLineReplacements", () => {
  it("reemplaza texto literal sin interpretar secuencias $1/$&", () => {
    const r = computeLineReplacements("const a = foo;\nconst b = foo;", {
      query: "foo",
      replacement: "$1$&",
      caseSensitive: true,
      useRegex: false,
      wholeWord: false,
    });
    expect(r.count).toBe(2);
    expect(r.edits).toEqual([
      { lineNumber: 1, endColumn: 15, text: "const a = $1$&;" },
      { lineNumber: 2, endColumn: 15, text: "const b = $1$&;" },
    ]);
  });

  it("respeta palabra completa, mayúsculas y preserva finales CRLF", () => {
    const r = computeLineReplacements("bar bar_2 BAR\r\nbar", {
      query: "bar",
      replacement: "baz",
      caseSensitive: true,
      useRegex: false,
      wholeWord: true,
    });
    expect(r.count).toBe(2);
    expect(r.edits).toEqual([
      { lineNumber: 1, endColumn: 14, text: "baz bar_2 BAR" },
      { lineNumber: 2, endColumn: 4, text: "baz" },
    ]);
  });

  it("soporta grupos de captura con expresiones regulares y evita bucles en coincidencias vacías", () => {
    const r = computeLineReplacements("id: 12\nid: 34", {
      query: "(\\d+)",
      replacement: "#$1",
      caseSensitive: false,
      useRegex: true,
      wholeWord: false,
    });
    expect(r.count).toBe(2);
    expect(r.edits.map((e) => e.text)).toEqual(["id: #12", "id: #34"]);

    const empty = computeLineReplacements("abc", {
      query: "^",
      replacement: "x",
      caseSensitive: true,
      useRegex: true,
      wholeWord: false,
    });
    expect(empty.count).toBe(0);
    expect(empty.edits).toEqual([]);
  });
});
