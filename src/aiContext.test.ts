import { describe, expect, it } from "vitest";
import { buildPrompt, chipLabels, fenceFor, fileMentionAt, filterProjectFiles, MAX_SELECTION } from "./aiContext";

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
  it("incluye archivos adjuntos extra sin duplicar el archivo abierto", () => {
    const p = buildPrompt("revisa", { file: "src/a.ts", extraFiles: ["src/a.ts", "src/b.ts"] });
    expect(p).toBe("Contexto del editor de Pulso (lo ve la persona):\n- Archivo abierto: src/a.ts\n- Archivo adjunto: src/b.ts\n\nMensaje:\nrevisa");
  });
  it("incluye imágenes adjuntas con su nombre y ruta", () => {
    const p = buildPrompt("¿qué ves?", { images: [{ path: "C:/data/ai-images/img_1.png", name: "captura.png" }] });
    expect(p).toBe("Contexto del editor de Pulso (lo ve la persona):\n- Imagen adjunta (captura.png): C:/data/ai-images/img_1.png\n\nMensaje:\n¿qué ves?");
  });
});

describe("chipLabels", () => {
  it("etiquetas cortas con el plural correcto", () => {
    expect(chipLabels({ file: "src/dir/a.ts", selection: { text: "x", startLine: 2, endLine: 2 } })).toEqual({ file: "a.ts", selection: "Selección · 1 línea" });
    expect(chipLabels({ selection: { text: "x", startLine: 2, endLine: 5 } }).selection).toBe("Selección · 4 líneas");
    expect(chipLabels({})).toEqual({ file: undefined, selection: undefined });
  });
});

describe("menciones @archivo", () => {
  it("detecta @consulta al principio o tras espacio, pero no en medio de un correo", () => {
    expect(fileMentionAt("@main", 5)).toEqual({ start: 0, query: "main" });
    expect(fileMentionAt("revisa @src/ai", 14)).toEqual({ start: 7, query: "src/ai" });
    expect(fileMentionAt("hola @", 6)).toEqual({ start: 5, query: "" });
    expect(fileMentionAt("correo@dominio.com", 18)).toBeNull();
    expect(fileMentionAt("revisa @a.ts ahora", 18)).toBeNull();
  });

  it("prioriza coincidencias al inicio del nombre de archivo", () => {
    const files = ["src/other/chat.ts", "src/aiChat.ts", "docs/ai.md", "src/main.ts"];
    expect(filterProjectFiles(files, "ai")).toEqual(["docs/ai.md", "src/aiChat.ts", "src/main.ts"]);
    expect(filterProjectFiles(files, "chat")).toEqual(["src/other/chat.ts", "src/aiChat.ts"]);
  });
});
