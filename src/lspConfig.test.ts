import { describe, expect, it } from "vitest";
import { diagnosticsStillValid, lspConfiguration } from "./lspConfig";

describe("lspConfiguration", () => {
  it("activa las indicaciones en línea en las secciones de TypeScript y JavaScript", () => {
    for (const section of ["js/ts", "typescript", "javascript"]) {
      expect(lspConfiguration(section)).toMatchObject({ inlayHints: { parameterNames: { enabled: "literals" }, enumMemberValues: { enabled: true } } });
    }
  });
  it("responde vacío a cualquier otra sección", () => {
    expect(lspConfiguration("editor")).toEqual({});
    expect(lspConfiguration(undefined)).toEqual({});
  });
});

describe("diagnosticsStillValid", () => {
  it("descarta respuestas de una versión anterior o de un documento cerrado", () => {
    expect(diagnosticsStillValid(3, 3, false)).toBe(true);
    expect(diagnosticsStillValid(3, 4, false)).toBe(false);
    expect(diagnosticsStillValid(3, 3, true)).toBe(false);
  });
});
