import { describe, expect, it } from "vitest";
import { CONSOLAS_STACK, OLD_DEFAULT_FONT, dropOldFontDefault } from "./settingsFont";

describe("letra de fábrica del editor", () => {
  it("es la de VS Code en Windows: Consolas, con Courier New de reserva", () => {
    expect(CONSOLAS_STACK.startsWith("Consolas")).toBe(true);
    expect(CONSOLAS_STACK).toContain('"Courier New"');
    expect(CONSOLAS_STACK.endsWith("monospace")).toBe(true);
  });

  it("quien nunca cambió la letra pasa a la nueva", () => {
    const saved: Record<string, unknown> = { fontFamily: OLD_DEFAULT_FONT, fontSize: 16 };
    dropOldFontDefault(saved);
    expect("fontFamily" in saved).toBe(false);
    expect(saved.fontSize).toBe(16);
  });

  it("quien eligió una letra a propósito la conserva, incluida Cascadia Code (se guarda con otra cadena)", () => {
    for (const choice of ['"Cascadia Code", Consolas, monospace', '"JetBrains Mono", Consolas, monospace', '"Fira Code", Consolas, monospace', "Consolas, monospace", "Iosevka"]) {
      const saved: Record<string, unknown> = { fontFamily: choice };
      dropOldFontDefault(saved);
      expect(saved.fontFamily).toBe(choice);
    }
    const none: Record<string, unknown> = {};
    dropOldFontDefault(none);
    expect(none).toEqual({});
  });
});
