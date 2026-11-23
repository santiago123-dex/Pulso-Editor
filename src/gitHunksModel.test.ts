import { describe, expect, it } from "vitest";
import { parseConflicts, resolveConflictText } from "./gitHunksModel";

describe("gitHunksModel — conflictos", () => {
  const sample = [
    "const x = 1;",
    "<<<<<<< HEAD",
    "const msg = 'local';",
    "=======",
    "const msg = 'remoto';",
    ">>>>>>> origin/main",
    "export { msg };",
  ].join("\n");

  it("detecta marcadores de conflicto con números de línea 1-based", () => {
    const blocks = parseConflicts(sample);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      startLine: 2,
      sepLine: 4,
      endLine: 6,
      currentLabel: "HEAD",
      incomingLabel: "origin/main",
      currentText: "const msg = 'local';",
      incomingText: "const msg = 'remoto';",
    });
  });

  it("resuelve actual, entrante y ambos correctamente", () => {
    const [b] = parseConflicts(sample);
    expect(resolveConflictText(b, "current")).toBe("const msg = 'local';");
    expect(resolveConflictText(b, "incoming")).toBe("const msg = 'remoto';");
    expect(resolveConflictText(b, "both")).toBe("const msg = 'local';\nconst msg = 'remoto';");
  });
});
