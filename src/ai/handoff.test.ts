import { describe, expect, it } from "vitest";
import type { Turn } from "../aiModel";
import { handoffBudget, keepGoalAndRecent, moveSession, transcript, unseenTurns, withHandoff } from "./handoff";

const turn = (role: Turn["role"], text: string): Turn => ({ id: text.slice(0, 20), role, done: true, blocks: [{ kind: "text", text }] });
const talk = [turn("user", "arregla el login"), turn("assistant", "Listo, cambié auth.ts"), turn("user", "ahora las pruebas")];

describe("cambiar de proveedor", () => {
  it("el que entra por primera vez recibe toda la conversación", () => {
    const moved = moveSession({}, "claude", "ses-claude", 3, "antigravity");
    expect(moved.sessionId).toBe("");
    expect(unseenTurns(moved.sessions, "antigravity", moved.sessionId, talk)).toHaveLength(3);
  });

  it("al volver, reanuda su sesión y recibe solo lo que no vio", () => {
    const toAgy = moveSession({}, "claude", "ses-claude", 2, "antigravity");
    const back = moveSession({ ...toAgy.sessions, antigravity: { id: "ses-agy", seen: 3 } }, "antigravity", "ses-agy", 3, "claude");
    expect(back.sessionId).toBe("ses-claude");
    expect(unseenTurns(back.sessions, "claude", back.sessionId, talk)).toEqual([talk[2]]);
  });

  it("ir y volver sin enviar nada no marca como visto lo que no vio", () => {
    const start = { claude: { id: "ses-claude", seen: 1 }, antigravity: { id: "ses-agy", seen: 3 } };
    const toClaude = moveSession(start, "antigravity", "ses-agy", 3, "claude");
    const toCodex = moveSession(toClaude.sessions, "claude", toClaude.sessionId, 3, "codex");
    expect(toCodex.sessions.claude).toEqual({ id: "ses-claude", seen: 1 });
  });

  it("una sesión en marcha no recibe su propia conversación repetida", () => {
    expect(unseenTurns({}, "claude", "ses-claude", talk)).toEqual([]);
  });
});

describe("historial que se entrega", () => {
  it("lleva quién dijo cada cosa y lo que hizo el asistente", () => {
    const withTool: Turn = {
      id: "t",
      role: "assistant",
      done: true,
      blocks: [
        { kind: "tool", id: "1", name: "Edit", input: { file_path: "src/auth.ts" }, json: "" },
        { kind: "text", text: "Hecho." },
      ],
    };
    const text = transcript([talk[0], withTool], 10_000);
    expect(text).toContain("Usuario: arregla el login");
    expect(text).toContain("auth.ts");
    expect(text).toContain("Hecho.");
  });

  it("si no cabe, conserva el objetivo y lo más reciente, y avisa de lo omitido", () => {
    const long = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? "assistant" : "user", `mensaje ${i} ${"x".repeat(300)}`));
    const text = transcript(long, 3000);
    expect(text.length).toBeLessThan(3200);
    expect(text).toContain("mensaje 0 ");
    expect(text).toContain("mensaje 39 ");
    expect(text).not.toContain("mensaje 5 ");
    expect(text).toMatch(/\d+ mensajes omitidos/);
    expect(keepGoalAndRecent([1, 2, 3, 4, 5], 3)).toEqual([1, 4, 5]);
  });

  it("envuelve el mensaje sin romper un /comando y deja menos sitio a Antigravity", () => {
    expect(withHandoff("sigue", "")).toBe("sigue");
    expect(withHandoff("sigue", "Usuario: hola")).toMatch(/<\/historial>\n\nMensaje actual:\nsigue$/);
    expect(withHandoff("/plan algo", "Usuario: hola").startsWith("/plan algo\n")).toBe(true);
    expect(handoffBudget("antigravity", 0)).toBeLessThan(handoffBudget("claude", 0));
    expect(handoffBudget("antigravity", 90_000)).toBe(2000);
  });
});
