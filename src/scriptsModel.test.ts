import { describe, expect, it } from "vitest";
import { detectManager, parseScripts, scriptCommand } from "./scriptsModel";

describe("parseScripts", () => {
  it("lee los scripts en el orden del archivo", () => {
    expect(parseScripts('{"scripts":{"dev":"vite","build":"tsc && vite build"}}')).toEqual([
      { name: "dev", command: "vite" }, { name: "build", command: "tsc && vite build" },
    ]);
  });
  it("tolera JSON inválido, sin scripts o con forma inesperada", () => {
    expect(parseScripts("{no json")).toEqual([]);
    expect(parseScripts("{}")).toEqual([]);
    expect(parseScripts('{"scripts":[1,2]}')).toEqual([]);
    expect(parseScripts("null")).toEqual([]);
    expect(parseScripts('{"scripts":{"a":5}}')).toEqual([]);
  });
  it("omite nombres que un shell interpretaría", () => {
    const list = parseScripts('{"scripts":{"ok:test":"x","a; rm -rf /":"x","$(evil)":"x","a b":"x","-flag":"x"}}');
    expect(list.map((s) => s.name)).toEqual(["ok:test"]);
  });
});

describe("detectManager y scriptCommand", () => {
  it("elige el gestor por su archivo de bloqueo", () => {
    expect(detectManager(["package.json", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectManager(["yarn.lock"])).toBe("yarn");
    expect(detectManager(["bun.lockb"])).toBe("bun");
    expect(detectManager(["package-lock.json"])).toBe("npm");
    expect(detectManager([])).toBe("npm");
  });
  it("arma el comando y rechaza nombres no seguros", () => {
    expect(scriptCommand("pnpm", "test:unit")).toBe("pnpm run test:unit");
    expect(() => scriptCommand("npm", "x; y")).toThrow();
  });
});
