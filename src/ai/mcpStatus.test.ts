import { describe, expect, it } from "vitest";
import { describeServer, sortServers, stateText, type McpServer } from "./mcpStatus";

const server = (o: Partial<McpServer> = {}): McpServer => ({ name: "docs", command: "npx -y un-servidor", project: false, state: "ok", error: "", tools: [{ name: "buscar", description: "Busca" }], ...o });

describe("pantalla de servidores MCP", () => {
  it("dice el estado de cada servidor, con herramientas en singular y plural", () => {
    expect(stateText(server())).toMatch(/1 herramienta|1 tool/);
    expect(stateText(server({ tools: [{ name: "a", description: "" }, { name: "b", description: "" }] }))).toMatch(/2 herramientas|2 tools/);
    expect(stateText(server({ state: "error" }))).toMatch(/No arrancó|did not start/i);
    expect(stateText(server({ state: "blocked", project: true }))).toMatch(/confíes|trust/i);
  });

  it("describe un servidor con su origen y su comando, y enseña solo la primera línea del error", () => {
    const ok = describeServer(server());
    expect(ok.label).toBe("docs");
    expect(ok.detail).toContain("npx -y un-servidor");
    expect(ok.detail).toMatch(/personal/);
    const err = describeServer(server({ state: "error", project: true, error: "El servidor MCP «docs» no arrancó: no se encontró el programa\notra línea de detalle" }));
    expect(err.detail).toContain("no se encontró el programa");
    expect(err.detail).not.toContain("otra línea");
    expect(err.detail).toMatch(/proyecto/);
    // Un error larguísimo se recorta.
    expect(describeServer(server({ state: "error", error: "x".repeat(500) })).detail.length).toBeLessThan(300);
  });

  it("ordena: primero los que funcionan, luego los que fallan y al final los bloqueados", () => {
    const list = [server({ name: "z", state: "blocked" }), server({ name: "b", state: "error" }), server({ name: "c" }), server({ name: "a" })];
    expect(sortServers(list).map((s) => s.name)).toEqual(["a", "c", "b", "z"]);
    // No cambia la lista original.
    expect(list[0].name).toBe("z");
  });
});
