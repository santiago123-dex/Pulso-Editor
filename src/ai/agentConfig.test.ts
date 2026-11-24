import { describe, expect, it } from "vitest";
import { configSummary, originLabel, sortConfig, type ConfigEntry } from "./agentConfig";

const e = (o: Partial<ConfigEntry>): ConfigEntry => ({ kind: "skill", name: "x", description: "", path: "C:/p/x", user: false, ...o });

describe("configuración del agente", () => {
  it("ordena por tipo, luego proyecto antes que personal, luego por nombre", () => {
    const list = [
      e({ kind: "command", name: "/z" }),
      e({ kind: "agent", name: "revisor" }),
      e({ kind: "skill", name: "b", user: true }),
      e({ kind: "skill", name: "c" }),
      e({ kind: "skill", name: "a" }),
      e({ kind: "instruction", name: "AGENTS.md" }),
    ];
    expect(sortConfig(list).map((x) => x.name)).toEqual(["AGENTS.md", "a", "c", "b", "revisor", "/z"]);
  });

  it("dice de dónde viene cada cosa", () => {
    expect(originLabel(e({}))).toMatch(/proyecto|project/i);
    expect(originLabel(e({ user: true }))).toMatch(/personal/i);
    expect(originLabel(e({ path: "" }))).toMatch(/integrado|built-in/i);
  });

  it("resume cuántas hay de cada tipo", () => {
    const s = configSummary([e({ kind: "skill" }), e({ kind: "skill" }), e({ kind: "agent" })]);
    expect(s).toContain("2");
    expect(s).toContain("1");
  });
});
