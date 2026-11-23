import { beforeEach, describe, expect, it } from "vitest";
import { addRequest, clearConversation, decisionOptions, parsePermissionEvent, pendingFor, resolveRequest, type PermissionRequest } from "./permissions";

const req = (o: Partial<PermissionRequest> = {}): PermissionRequest => ({ id: "perm-c-1", tool: "command", detail: "npm test", risky: false, agent: "", ...o });

describe("aprobación de comandos", () => {
  beforeEach(() => clearConversation("c"));

  it("lee los eventos de la herramienta y se ignora todo lo demás", () => {
    expect(parsePermissionEvent({ type: "pulso_permission", id: "p1", tool: "command", detail: "git push", risky: true, agent: "general" })).toEqual({
      kind: "ask",
      req: { id: "p1", tool: "command", detail: "git push", risky: true, agent: "general" },
    });
    expect(parsePermissionEvent({ type: "pulso_permission", id: "p2", tool: "web", detail: "https://x.test" })).toEqual({
      kind: "ask",
      req: { id: "p2", tool: "web", detail: "https://x.test", risky: false, agent: "" },
    });
    expect(parsePermissionEvent({ type: "pulso_permission_resolved", id: "p1" })).toEqual({ kind: "resolved", id: "p1" });
    for (const other of [null, 5, "x", {}, { type: "assistant" }, { type: "pulso_permission" }, { type: "pulso_permission", id: 3, detail: "x" }, { type: "pulso_permission", id: "a" }]) {
      expect(parsePermissionEvent(other)).toBeNull();
    }
  });

  it("guarda las preguntas por conversación, sin repetirlas, hasta que se responden", () => {
    addRequest("c", req());
    addRequest("c", req());
    addRequest("c", req({ id: "perm-c-2", detail: "cargo build" }));
    addRequest("otra", req({ id: "perm-otra-1" }));
    expect(pendingFor("c").map((r) => r.id)).toEqual(["perm-c-1", "perm-c-2"]);
    resolveRequest("c", "perm-c-1");
    expect(pendingFor("c").map((r) => r.id)).toEqual(["perm-c-2"]);
    resolveRequest("c", "perm-c-2");
    expect(pendingFor("c")).toEqual([]);
    expect(pendingFor("otra")).toHaveLength(1);
    clearConversation("otra");
    expect(pendingFor("otra")).toEqual([]);
    resolveRequest("nunca-existio", "x");
  });

  it("ofrece las opciones que corresponden: lo de riesgo solo una vez, la web sin reglas", () => {
    const names = (r: PermissionRequest) => decisionOptions(r).map((o) => o.decision);
    expect(names(req())).toEqual(["once", "always", "all", "deny"]);
    expect(names(req({ risky: true }))).toEqual(["once", "deny"]);
    expect(names(req({ tool: "web", detail: "https://x.test" }))).toEqual(["once", "all", "deny"]);
    // Ante un comando de riesgo, la opción destacada es denegar (no la que lo ejecuta).
    expect(decisionOptions(req({ risky: true })).find((o) => o.primary)?.decision).toBe("deny");
    expect(decisionOptions(req()).find((o) => o.primary)?.decision).toBe("once");
  });
});
