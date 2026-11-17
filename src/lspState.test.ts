import { beforeEach, describe, expect, it } from "vitest";
import { getLspState, lspDetail, lspLabel, onLspState, setLspState } from "./lspState";

describe("estado del servidor de lenguaje", () => {
  beforeEach(() => setLspState({ kind: "off" }));

  it("avisa de cada cambio y no repite el mismo estado", () => {
    const seen: string[] = [];
    const off = onLspState((s) => seen.push(s.kind));
    setLspState({ kind: "starting" });
    setLspState({ kind: "starting" });
    setLspState({ kind: "ready" });
    setLspState({ kind: "stopped", reason: "a" });
    setLspState({ kind: "stopped", reason: "a" });
    setLspState({ kind: "stopped", reason: "b" });
    off();
    setLspState({ kind: "off" });
    expect(seen).toEqual(["starting", "ready", "stopped", "stopped"]);
    expect(getLspState().kind).toBe("off");
  });

  it("muestra etiqueta y, al detenerse, el motivo", () => {
    expect(lspLabel({ kind: "off" })).toBe("");
    expect(lspLabel({ kind: "starting" })).toContain("iniciando");
    expect(lspLabel({ kind: "ready" })).toContain("activo");
    expect(lspLabel({ kind: "stopped", reason: "x" })).toContain("detenido");
    expect(lspDetail({ kind: "stopped", reason: "Node no encontrado" })).toContain("Node no encontrado");
  });
});
