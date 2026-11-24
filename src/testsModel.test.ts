import { describe, expect, it } from "vitest";
import { groupTestsByFile, testSummaryLine } from "./testsModel";

describe("testsModel", () => {
  it("agrupa por archivo poniendo primero los que tienen fallos", () => {
    const groups = groupTestsByFile([
      { file: "a.test.ts", name: "ok 1", status: "passed" },
      { file: "b.test.ts", name: "bad 1", status: "failed" },
      { file: "b.test.ts", name: "ok 2", status: "passed" },
    ]);
    expect(groups.map((g) => g.file)).toEqual(["b.test.ts", "a.test.ts"]);
    expect(groups[0]).toMatchObject({ passed: 1, failed: 1, skipped: 0 });
  });

  it("filtra solo pruebas fallidas cuando onlyFailed es true", () => {
    const groups = groupTestsByFile(
      [
        { file: "a.test.ts", name: "ok", status: "passed" },
        { file: "b.test.ts", name: "bad", status: "failed" },
      ],
      true,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe("b.test.ts");
  });

  it("formatea el resumen de ejecución", () => {
    expect(testSummaryLine({ passed: 12, failed: 2, skipped: 1, duration_ms: 1450 })).toBe("12 ✓ · 2 ✖ · 1 ○ · 1.4 s");
  });
});
