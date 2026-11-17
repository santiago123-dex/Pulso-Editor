import { describe, expect, it } from "vitest";
import { score, type PickItem } from "./ui";

const item = (label: string, extra: Partial<PickItem> = {}): PickItem => ({ label, run: () => {}, ...extra });

describe("score del selector rápido", () => {
  it("descarta lo que no contiene las letras en orden", () => {
    expect(score("xyz", item("main.ts"))).toBe(-1);
    expect(score("tsm", item("main.ts"))).toBe(-1);
  });

  it("acepta letras en orden aunque no sean contiguas", () => {
    expect(score("mts", item("main.ts"))).toBeGreaterThanOrEqual(0);
  });

  it("prefiere el nombre exacto o que empieza igual", () => {
    expect(score("main", item("main.ts"))).toBeGreaterThan(score("main", item("domain.ts")));
    expect(score("ma", item("main.ts"))).toBeGreaterThan(score("ma", item("format.ts")));
  });

  it("las letras contiguas pesan más que las dispersas", () => {
    expect(score("abc", item("abc.ts"))).toBeGreaterThan(score("abc", item("a_b_c.ts")));
  });

  it("también busca en la carpeta del archivo", () => {
    expect(score("src/ui", item("ui.ts", { detail: "src" }))).toBeGreaterThanOrEqual(0);
  });

  it("las palabras clave permiten encontrar un comando por otro idioma", () => {
    const tema = item("Preferencias: Tema de color…", { keywords: "theme tema temas color" });
    expect(score("theme", tema)).toBeGreaterThanOrEqual(0);
    expect(score("theme", item("Preferencias: Tema de color…"))).toBe(-1);
  });

  it("la primera palabra clave pesa más que las demás", () => {
    const principal = item("Tema de color", { keywords: "theme tema" });
    const otro = item("Importar tema de VS Code", { keywords: "import vscode theme" });
    expect(score("theme", principal)).toBeGreaterThan(score("theme", otro));
  });

  it("no distingue mayúsculas en el texto (la consulta ya llega en minúsculas)", () => {
    expect(score("main", item("MAIN.TS"))).toBeGreaterThanOrEqual(0);
  });
});

describe("paleta: palabras clave en inglés", () => {
  const wrap: PickItem = {
    label: "Preferencias: Alternar ajuste de línea",
    keywords: "toggle word wrap ajuste línea envolver wrap",
    run: () => {},
  };
  const other: PickItem = { label: "Terminal: Limpiar", keywords: "terminal clear limpiar", run: () => {} };
  it.each(["word wrap", "toggle word wrap", "wrap", "ajuste"])("«%s» encuentra Alternar ajuste de línea", (q) => {
    expect(score(q, wrap)).toBeGreaterThan(0);
  });
  it("no mezcla otros comandos", () => {
    expect(score("word wrap", other)).toBe(-1);
  });
});
