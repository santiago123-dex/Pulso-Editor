import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./aiMarkdown";

describe("parseMarkdown", () => {
  it("separa párrafos, encabezados, listas y código", () => {
    const md = parseMarkdown("# Título\n\nUn párrafo\nen dos líneas.\n\n- uno\n- dos\n1. primero\n\n```ts\nconst a = 1;\n```\nFin");
    expect(md.map((b) => b.type)).toEqual(["h", "p", "li", "li", "li", "code", "p"]);
    expect(md[1]).toEqual({ type: "p", text: "Un párrafo\nen dos líneas." });
    expect(md[4]).toMatchObject({ ordered: true, marker: "1." });
    expect(md[5]).toEqual({ type: "code", lang: "ts", text: "const a = 1;", closed: true });
  });
  it("una cerca sin cerrar (respuesta a medias) ya se trata como código", () => {
    const md = parseMarkdown("Mira:\n```py\nprint(1)\nprint(2)");
    expect(md[1]).toEqual({ type: "code", lang: "py", text: "print(1)\nprint(2)", closed: false });
  });
  it("el código no interpreta su contenido y conserva líneas vacías y sangrías", () => {
    const md = parseMarkdown("```\n# no es título\n\n  - ni lista\n```");
    expect(md).toEqual([{ type: "code", lang: "", text: "# no es título\n\n  - ni lista", closed: true }]);
  });
  it("tolera texto vacío, saltos de línea de Windows y solo espacios", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n \n")).toEqual([]);
    expect(parseMarkdown("a\r\nb")).toEqual([{ type: "p", text: "a\nb" }]);
  });
});

describe("parseInline", () => {
  it("reconoce código y negrita y conserva el resto", () => {
    expect(parseInline("Usa `npm test` y **no** olvides")).toEqual([
      { text: "Usa ", kind: "text" }, { text: "npm test", kind: "code" }, { text: " y ", kind: "text" }, { text: "no", kind: "bold" }, { text: " olvides", kind: "text" },
    ]);
  });
  it("un marcador sin cerrar queda como texto", () => {
    expect(parseInline("a `sin cerrar")).toEqual([{ text: "a `sin cerrar", kind: "text" }]);
    expect(parseInline("**a medias")).toEqual([{ text: "**a medias", kind: "text" }]);
    expect(parseInline("")).toEqual([]);
  });
  it("el HTML se queda como texto: no se interpreta", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ text: "<img src=x onerror=alert(1)>", kind: "text" }]);
  });
});
