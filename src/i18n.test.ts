import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: módulo .mjs de Node sin tipos, compartido con la herramienta de línea de comandos.
import { codeKeys, htmlKeys, misplacedCalls } from "../scripts/i18n-keys.mjs";
import { fill, resolveLang, setLangForTests, t } from "./i18n";
import { en } from "./locales/en";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => setLangForTests("es"));

describe("idioma", () => {
  it("«auto» sigue al sistema y las elecciones explícitas mandan", () => {
    expect(resolveLang("auto", ["es-CO", "en"])).toBe("es");
    expect(resolveLang("auto", ["en-US"])).toBe("en");
    expect(resolveLang("auto", ["fr-FR"])).toBe("en");
    expect(resolveLang(undefined, [])).toBe("es");
    expect(resolveLang("es", ["en-US"])).toBe("es");
    expect(resolveLang("en", ["es-ES"])).toBe("en");
  });

  it("traduce, rellena los valores y deja en español lo que no tiene traducción", () => {
    setLangForTests("en");
    expect(t("Archivo: Guardar")).toBe("File: Save");
    expect(t("Conectado como {login}", { login: "ana" })).toBe("Connected as ana");
    expect(t("Texto que nadie tradujo")).toBe("Texto que nadie tradujo");
    setLangForTests("es");
    expect(t("Conectado como {login}", { login: "ana" })).toBe("Conectado como ana");
    expect(fill("{a} y {b}", { a: 1 })).toBe("1 y {b}");
  });
});

describe("traducciones al inglés", () => {
  const keys = [...codeKeys(), ...htmlKeys()] as string[];

  it("cada texto marcado con t() y cada texto fijo de index.html tiene traducción", () => {
    expect(keys.length).toBeGreaterThan(300);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });

  it("las traducciones usan los mismos {valores} que el original", () => {
    expect(Object.entries(en).filter(([k, v]) => placeholders(k).join() !== placeholders(v).join())).toEqual([]);
  });

  it("ningún t() quedó dentro de otra cadena (un selector o un texto), donde no se ejecuta", () => {
    expect(misplacedCalls()).toEqual([]);
  });

  it("no quedan traducciones sin uso", () => {
    const used = new Set(keys);
    expect(Object.keys(en).filter((k) => !used.has(k))).toEqual([]);
  });
});
