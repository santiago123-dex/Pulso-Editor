import { describe, expect, it } from "vitest";
import {
  branchNameForIssue,
  buildIssuePrompt,
  buildPrDraft,
  extractProposedEdits,
  isSafeRelativeEditPath,
} from "./issueWorkflowModel";

describe("workflow/issueWorkflowModel", () => {
  it("genera nombres de rama válidos según etiquetas y normaliza acentos", () => {
    expect(branchNameForIssue({ number: 42, title: "Añadir soporte OAuth / GitHub" }))
      .toBe("feat/42-anadir-soporte-oauth-github");
    expect(branchNameForIssue({ number: 7, title: "Arreglar caída al guardar", labels: [{ name: "bug" }] }))
      .toBe("fix/7-arreglar-caida-al-guardar");
    expect(branchNameForIssue({ number: 12, title: "Actualizar guía LSP", labels: [{ name: "documentation" }] }))
      .toBe("docs/12-actualizar-guia-lsp");
    expect(branchNameForIssue({ number: 99, title: "!!!" })).toBe("feat/99");
  });

  it("construye el prompt inicial con contexto de la issue y guía de formato revisable", () => {
    const prompt = buildIssuePrompt(
      { number: 15, title: "Validar formularios", body: "No permite campos vacíos", labels: [{ name: "bug" }] },
      "fix/15-validar-formularios",
    );
    expect(prompt).toContain("#15");
    expect(prompt).toContain("fix/15-validar-formularios");
    expect(prompt).toContain("Validar formularios");
    expect(prompt).toContain("No permite campos vacíos");
    expect(prompt).toContain("path=");
  });

  it("extrae propuestas de archivo de bloques Markdown y rechaza rutas peligrosas", () => {
    const md = [
      "Propongo estos cambios:",
      "",
      "```ts path=src/foo.ts",
      "export const a = 1;",
      "```",
      "",
      "### Archivo: `src/bar.ts`",
      "```ts",
      "export const b = 2;",
      "```",
      "",
      "```ts path=../escape.ts",
      "malo",
      "```",
      "",
      "```ts path=src/foo.ts",
      "export const a = 42;",
      "```",
    ].join("\n");

    const edits = extractProposedEdits(md);
    expect(edits).toEqual([
      { path: "src/foo.ts", lang: "ts", content: "export const a = 42;" },
      { path: "src/bar.ts", lang: "ts", content: "export const b = 2;" },
    ]);
  });

  it("valida rutas relativas seguras", () => {
    expect(isSafeRelativeEditPath("src/app.ts")).toBe(true);
    expect(isSafeRelativeEditPath("../etc/passwd")).toBe(false);
    expect(isSafeRelativeEditPath("/etc/passwd")).toBe(false);
    expect(isSafeRelativeEditPath("C:/Windows/a.txt")).toBe(false);
    expect(isSafeRelativeEditPath("")).toBe(false);
  });

  it("arma el borrador de PR enlazando Closes #N y listando archivos tocados", () => {
    const draft = buildPrDraft(
      { number: 42, title: "Soporte Kanban", labels: [{ name: "enhancement" }] },
      "feat/42-soporte-kanban",
      "main",
      ["src/board.ts", "src/prs.ts"],
    );
    expect(draft.title).toBe("feat(#42): Soporte Kanban");
    expect(draft.body).toContain("Closes #42");
    expect(draft.body).toContain("- `src/board.ts`");
    expect(draft.head).toBe("feat/42-soporte-kanban");
    expect(draft.base).toBe("main");
  });
});
