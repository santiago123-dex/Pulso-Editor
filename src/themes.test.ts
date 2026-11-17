import { describe, expect, it } from "vitest";
import { THEMES, mix, parseJsonc, terminalTheme, themeFromVSCode, tokenRules } from "./themes";

const DRACULA = {
  name: "Dracula",
  type: "dark",
  colors: {
    "editor.background": "#282A36",
    "editor.foreground": "#F8F8F2",
    "sideBar.background": "#21222C",
    "activityBar.background": "#343746",
    "activityBar.activeBorder": "#FF79C680",
    "button.background": "#44475A",
    "list.hoverBackground": "#44475A75",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6272A4" } },
    { scope: ["string", "string.quoted.double"], settings: { foreground: "#F1FA8C" } },
    // En Drácula los docstrings de Python son del color de los comentarios; no deben teñir todas las cadenas.
    { scope: "string.quoted.docstring.multi", settings: { foreground: "#6272A4" } },
    { scope: ["keyword", "storage.type"], settings: { foreground: "#FF79C6" } },
    { scope: "constant.numeric", settings: { foreground: "#BD93F9" } },
    { scope: "entity.name.function", settings: { foreground: "#50FA7B" } },
    { scope: "support.class", settings: { foreground: "#8BE9FD" } },
  ],
};

describe("parseJsonc", () => {
  it("acepta comentarios y comas finales como los temas de VS Code", () => {
    const v = parseJsonc(`{
      // comentario de línea
      "a": 1, /* bloque */
      "b": [1, 2,],
    }`);
    expect(v).toEqual({ a: 1, b: [1, 2] });
  });

  it("no confunde // dentro de cadenas con un comentario", () => {
    expect(parseJsonc('{"url": "https://ejemplo.com/a//b"}')).toEqual({ url: "https://ejemplo.com/a//b" });
  });

  it("respeta comillas escapadas y BOM", () => {
    expect(parseJsonc('﻿{"x": "di \\"hola\\" // no"}')).toEqual({ x: 'di "hola" // no' });
  });

  it("lanza error con JSON roto", () => {
    expect(() => parseJsonc("{no es json")).toThrow();
  });
});

describe("mix", () => {
  it("interpola entre dos colores", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("themeFromVSCode", () => {
  const t = themeFromVSCode(DRACULA, "x");

  it("toma los colores de interfaz del tema", () => {
    expect(t.label).toBe("Dracula");
    expect(t.base).toBe("vs-dark");
    expect(t.editor).toBe("#282a36");
    expect(t.sidebar).toBe("#21222c");
    expect(t.activity).toBe("#343746");
    expect(t.fg).toBe("#f8f8f2");
    expect(t.custom).toBe(true);
  });

  it("elige un acento vivo y no el gris de button.background", () => {
    expect(t.accent).toBe("#ff79c6");
  });

  it("mapea los colores del código por rol", () => {
    expect(t.syntax.comment).toBe("6272a4");
    expect(t.syntax.keyword).toBe("ff79c6");
    expect(t.syntax.number).toBe("bd93f9");
    expect(t.syntax.fn).toBe("50fa7b");
    expect(t.syntax.type).toBe("8be9fd");
  });

  it("las cadenas no toman el color de los docstrings (coincidencia exacta primero)", () => {
    expect(t.syntax.string).toBe("f1fa8c");
  });

  it("mezcla con el fondo los colores semitransparentes", () => {
    // #44475A75 sobre #282A36 no puede ser el color puro ni el fondo.
    expect(t.hover).not.toBe("#44475a");
    expect(t.hover).not.toBe("#282a36");
  });

  it("detecta temas claros por type o por luminosidad", () => {
    expect(themeFromVSCode({ type: "light", colors: { "editor.background": "#ffffff" } }, "L").base).toBe("vs");
    expect(themeFromVSCode({ colors: { "editor.background": "#fdf6e3" } }, "L").base).toBe("vs");
    expect(themeFromVSCode({ colors: { "editor.background": "#101010" } }, "D").base).toBe("vs-dark");
  });

  it("un tema casi vacío no rompe: usa valores por defecto razonables", () => {
    const e = themeFromVSCode({}, "Vacío");
    expect(e.label).toBe("Vacío");
    expect(e.editor).toMatch(/^#[0-9a-f]{6}$/);
    expect(e.accent).toMatch(/^#[0-9a-f]{6}$/);
    for (const v of Object.values(e.syntax)) expect(v).toMatch(/^[0-9a-f]{6}$/);
  });

  it("sin tokenColors recurre a los colores del tema base", () => {
    const e = themeFromVSCode({ type: "dark", colors: { "editor.background": "#111111" } }, "S");
    expect(e.syntax.keyword).toBe(THEMES["pulso-dark"].syntax.keyword);
  });

  it("ignora tokenColors que no son una lista (formato antiguo)", () => {
    expect(() => themeFromVSCode({ tokenColors: "./viejo.tmTheme" }, "X")).not.toThrow();
  });
});

describe("temas incluidos", () => {
  it("todos los colores tienen formato válido", () => {
    for (const [id, t] of Object.entries(THEMES)) {
      for (const k of ["bg", "editor", "sidebar", "activity", "border", "hover", "selected", "fg", "muted", "accent"] as const) {
        expect(t[k], `${id}.${k}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      for (const [role, c] of Object.entries(t.syntax)) expect(c, `${id}.syntax.${role}`).toMatch(/^[0-9a-f]{6}$/i);
    }
  });

  it("hay temas oscuros y claros", () => {
    const kinds = new Set(Object.values(THEMES).map((t) => t.base));
    expect(kinds).toEqual(new Set(["vs", "vs-dark"]));
  });

  it("tokenRules cubre los roles principales con el color del tema", () => {
    const rules = tokenRules(THEMES.dracula.syntax);
    const kw = rules.find((r) => r.token === "keyword")!;
    expect(kw.foreground).toBe(THEMES.dracula.syntax.keyword);
    expect(rules.some((r) => r.token === "comment" && r.fontStyle === "italic")).toBe(true);
  });
});

describe("terminalTheme", () => {
  const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

  it("define los 16 colores ANSI, el fondo, el texto y el cursor en cada tema", () => {
    for (const [id, th] of Object.entries(THEMES)) {
      const x = terminalTheme(th);
      for (const n of ANSI) {
        expect(x[n], `${id}.${n}`).toMatch(/^#[0-9a-f]{6}$/i);
        const b = "bright" + n[0].toUpperCase() + n.slice(1);
        expect(x[b], `${id}.${b}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(x.background).toBe(th.editor);
      expect(x.foreground).toBe(th.fg);
      expect(x.cursor).toBe(th.accent);
    }
  });

  it("la selección usa el acento con transparencia", () => {
    expect(terminalTheme(THEMES.dracula).selectionBackground).toBe(THEMES.dracula.accent + "55");
  });

  it("el negro ANSI se distingue del fondo para que se pueda leer", () => {
    for (const th of Object.values(THEMES)) {
      expect(terminalTheme(th).black.toLowerCase()).not.toBe(th.editor.toLowerCase());
    }
  });

  it("los colores salen de la sintaxis del tema (combinan con el editor)", () => {
    const x = terminalTheme(THEMES.dracula);
    expect(x.green).toBe("#" + THEMES.dracula.syntax.string);
    expect(x.magenta).toBe("#" + THEMES.dracula.syntax.keyword);
  });

  it("en temas claros el texto brillante se oscurece en vez de aclararse", () => {
    const light = terminalTheme(THEMES["github-light"]);
    expect(light.brightWhite).toBe("#2b2b2b");
    expect(light.white).not.toBe(THEMES["github-light"].fg);
  });
});
