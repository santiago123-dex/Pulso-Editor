import { describe, expect, it } from "vitest";
import { lspMarkerOwner, lspTargetForPath } from "./lspRegistry";

describe("lspRegistry", () => {
  it("asigna servidor y languageId para TS/JS, Python, Rust, Go y C/C++", () => {
    expect(lspTargetForPath("/proj/src/app.tsx")).toEqual({ server: "typescript", languageId: "typescriptreact" });
    expect(lspTargetForPath("C:/proj/index.mjs")).toEqual({ server: "typescript", languageId: "javascript" });
    expect(lspTargetForPath("/proj/app.py")).toEqual({ server: "python", languageId: "python" });
    expect(lspTargetForPath("/proj/types.pyi")).toEqual({ server: "python", languageId: "python" });
    expect(lspTargetForPath("/proj/src/main.rs")).toEqual({ server: "rust", languageId: "rust" });
    expect(lspTargetForPath("/proj/cmd/main.go")).toEqual({ server: "go", languageId: "go" });
    expect(lspTargetForPath("/proj/lib.c")).toEqual({ server: "cpp", languageId: "c" });
    expect(lspTargetForPath("/proj/engine.cpp")).toEqual({ server: "cpp", languageId: "cpp" });
    expect(lspTargetForPath("/proj/README.md")).toBeNull();
  });

  it("mantiene propietarios de marcadores separados por servidor", () => {
    expect(lspMarkerOwner("typescript")).toBe("pulso-lsp");
    expect(lspMarkerOwner("python")).toBe("pulso-lsp-python");
    expect(lspMarkerOwner("rust")).toBe("pulso-lsp-rust");
  });
});
