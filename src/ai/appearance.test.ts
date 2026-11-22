import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAiAppearance, isLightHex, loadAppearance } from "./appearance";

vi.mock("../settings", () => ({
  state: { settings: {} },
  applyTheme: vi.fn(),
}));

function fakeStyle() {
  const map = new Map<string, string>();
  return {
    map,
    setProperty: (k: string, v: string) => map.set(k, v),
    removeProperty: (k: string) => { map.delete(k); return ""; },
  } as unknown as CSSStyleDeclaration & { map: Map<string, string> };
}

afterEach(() => vi.unstubAllGlobals());

describe("ai/appearance", () => {
  it("valida hex y vuelve a valores seguros ante datos corruptos", () => {
    const store = new Map<string, string>([["pulso.ai.appearance", '{"bg":"javascript:1","pattern":"solid","scope":"global"}']]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
    expect(loadAppearance()).toEqual({ bg: "", pattern: "solid", scope: "global" });
    expect(isLightHex("#ffffff")).toBe(true);
    expect(isLightHex("#071022")).toBe(false);
  });

  it("re-aplica el tema global al restablecer o volver del alcance global al asistente", () => {
    const rootStyle = fakeStyle();
    const viewStyle = fakeStyle();
    const classes = new Set<string>();
    const view = {
      style: viewStyle,
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    } as unknown as HTMLElement;
    vi.stubGlobal("document", { documentElement: { style: rootStyle } });

    const restore = vi.fn();
    applyAiAppearance(view, { bg: "#071022", pattern: "solid", scope: "global" }, restore);
    expect(rootStyle.map.get("--bg")).toBe("#071022");
    expect(restore).not.toHaveBeenCalled();

    applyAiAppearance(view, { bg: "#071022", pattern: "dots", scope: "assistant" }, restore);
    expect(rootStyle.map.has("--bg")).toBe(false);
    expect(viewStyle.map.get("--bg")).toBe("#071022");
    expect(restore).toHaveBeenCalledTimes(1);

    applyAiAppearance(view, { bg: "", pattern: "dots", scope: "assistant" }, restore);
    expect(viewStyle.map.has("--bg")).toBe(false);
    expect(restore).toHaveBeenCalledTimes(2);
  });
});
