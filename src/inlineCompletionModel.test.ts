import { describe, expect, it } from "vitest";
import { extractInlineContext, shouldTriggerInline } from "./inlineCompletionModel";

describe("inlineCompletionModel", () => {
  it("extrae prefijo y sufijo exactos alrededor del cursor", () => {
    const code = "function sum(a: number, b: number) {\n  return \n}";
    const ctx = extractInlineContext(code, 2, 10);
    expect(ctx.prefix).toBe("function sum(a: number, b: number) {\n  return ");
    expect(ctx.suffix).toBe("\n}");
  });

  it("no dispara en líneas vacías o prefijos muy cortos", () => {
    expect(shouldTriggerInline("")).toBe(false);
    expect(shouldTriggerInline("const x = 1;\n   ")).toBe(false);
    expect(shouldTriggerInline("const x = 1;\n  re")).toBe(true);
  });
});
