import { describe, expect, it } from "vitest";
import { buildPrompt, chipLabels, fenceFor, MAX_SELECTION } from "./aiContext";

describe("buildPrompt", () => {
  it("sin contexto envía solo el mensaje", () => {
    expect(buildPrompt("hola", {})).toBe("hola");
    expect(buildPrompt("hola", { selection: { text: "   ", startLine: 1, endLine: 1 } })).toBe("hola");
  });
  it("con archivo y selección los pone antes del mensaje, identificados", () => {
    const p = buildPrompt("¿qué hace?", { file: "src/a.ts", selection: { text: "const a = 1;", startLine: 3, endLine: 5 } });
    expect(p).toBe("Contexto del editor de Pulso (lo ve la persona):\n- Archivo abierto: src/a.ts\n- Selección (líneas 3-5):\n```\nconst a = 1;\n```\n\nMensaje:\n¿qué hace?");
  });
  it("una selección con cercas de código usa una cerca más larga", () => {
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("sin cercas")).toBe("```");
    const p = buildPrompt("x", { selection: { text: "```js\n1\n```", startLine: 1, endLine: 3 } });
    expect(p).toContain("````\n```js\n1\n```\n````");
  });
  it("una selección enorme se recorta y lo dice", () => {
    const p = buildPrompt("x", { selection: { text: "a".repeat(MAX_SELECTION + 50), startLine: 1, endLine: 900 } });
    expect(p).toContain(`recortada a ${MAX_SELECTION} caracteres`);
    expect(p.length).toBeLessThan(MAX_SELECTION + 400);
  });
  it("solo el archivo, sin selección", () => {
    expect(buildPrompt("m", { file: "a.ts" })).toBe("Contexto del editor de Pulso (lo ve la persona):\n- Archivo abierto: a.ts\n\nMensaje:\nm");
  });
});

describe("chipLabels", () => {
  it("etiquetas cortas con el plural correcto", () => {
    expect(chipLabels({ file: "src/dir/a.ts", selection: { text: "x", startLine: 2, endLine: 2 } })).toEqual({ file: "a.ts", selection: "Selección · 1 línea" });
    expect(chipLabels({ selection: { text: "x", startLine: 2, endLine: 5 } }).selection).toBe("Selección · 4 líneas");
    expect(chipLabels({})).toEqual({ file: undefined, selection: undefined });
  });
});
