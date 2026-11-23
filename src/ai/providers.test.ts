import { describe, expect, it } from "vitest";
import { providerDetail, sortProviders, validateKey, type ProviderBrief } from "./providers";

const p = (o: Partial<ProviderBrief>): ProviderBrief => ({ id: "x", name: "X", doc: "", env: [], models: 3, configured: false, from_env: false, ...o });

describe("proveedores de modelos", () => {
  it("ordena los conectados primero y luego por nombre", () => {
    const list = [p({ id: "b", name: "Beta" }), p({ id: "z", name: "zeta", configured: true }), p({ id: "a", name: "Alfa" }), p({ id: "c", name: "Cohere", configured: true })];
    expect(sortProviders(list).map((x) => x.id)).toEqual(["c", "z", "a", "b"]);
  });

  it("resume cada proveedor: modelos y estado", () => {
    expect(providerDetail(p({ models: 12, env: ["OPENAI_API_KEY"] }))).toContain("12");
    expect(providerDetail(p({ models: 12, env: ["OPENAI_API_KEY"] }))).toContain("OPENAI_API_KEY");
    expect(providerDetail(p({ configured: true }))).not.toContain("API_KEY");
    expect(providerDetail(p({ configured: true, from_env: true })).length).toBeGreaterThan(providerDetail(p({ configured: true })).length);
  });

  it("valida la clave sin guardarla ni mostrarla", () => {
    expect(validateKey("")).not.toBeNull();
    expect(validateKey("   ")).not.toBeNull();
    expect(validateKey("corta")).not.toBeNull();
    expect(validateKey("sk-con espacio dentro")).not.toBeNull();
    expect(validateKey("sk-abcdefghijklmnop")).toBeNull();
    expect(validateKey(`sk-${"a".repeat(2000)}`)).not.toBeNull();
  });
});
