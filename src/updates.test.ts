import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./ui", () => ({ setStatus: vi.fn(), showDialog: vi.fn() }));

import { updateMessage } from "./updates";

describe("updateMessage", () => {
  it("sin notas solo explica las versiones", () => {
    const m = updateMessage({ version: "0.2.0", current: "0.1.0", notes: null });
    expect(m).toContain("0.1.0");
    expect(m).toContain("0.2.0");
    expect(m).not.toContain("Novedades");
  });

  it("incluye las notas y recorta las largas", () => {
    const notes = Array.from({ length: 20 }, (_, i) => `- cambio ${i + 1}`).join("\n");
    const m = updateMessage({ version: "0.2.0", current: "0.1.0", notes }, 3);
    expect(m).toContain("Novedades:\n- cambio 1\n- cambio 2\n- cambio 3\n…");
    expect(m).not.toContain("cambio 4");
  });

  it("recorta por caracteres y quita líneas vacías repetidas", () => {
    const m = updateMessage({ version: "1.0.0", current: "0.9.0", notes: "a\n\n\n\nb" });
    expect(m).toContain("Novedades:\na\n\nb");
    const long = updateMessage({ version: "1.0.0", current: "0.9.0", notes: "x".repeat(1000) }, 8, 50);
    expect(long.endsWith("x".repeat(50) + "\n…")).toBe(true);
  });
});
