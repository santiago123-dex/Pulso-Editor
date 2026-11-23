import { describe, expect, it } from "vitest";
import { fromProjectDiagnostics, mergeProblems } from "./projectProblemsModel";

describe("projectProblemsModel", () => {
  it("convierte diagnósticos del backend al modelo Problem", () => {
    const out = fromProjectDiagnostics([
      {
        path: "C:/repo/src/a.ts",
        line: 12,
        col: 3,
        end_line: 12,
        end_col: 9,
        severity: "error",
        message: "Type mismatch",
        source: "tsc",
        code: "TS2322",
      },
      {
        path: "C:/repo/src/b.rs",
        line: 0,
        col: 0,
        end_line: 0,
        end_col: 0,
        severity: "warning",
        message: "unused",
        source: "cargo",
        code: null,
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: "C:/repo/src/a.ts", line: 12, col: 3, severity: "error", code: "TS2322" });
    expect(out[1]).toMatchObject({ line: 1, col: 1, severity: "warning", code: undefined });
  });

  it("deduplica problemas repetidos al combinar abiertos y proyecto", () => {
    const a = { path: "C:/repo/a.ts", line: 5, col: 2, endLine: 5, endCol: 4, severity: "error" as const, message: "Err", code: "TS1" };
    const b = { ...a, path: "c:/repo/a.ts" };
    const c = { ...a, line: 9 };
    expect(mergeProblems([a], [b, c])).toHaveLength(2);
  });
});
