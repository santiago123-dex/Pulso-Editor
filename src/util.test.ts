import { describe, expect, it } from "vitest";
import { baseName, dirName, errMsg, norm, terminalFontStack } from "./util";

describe("rutas", () => {
  it("norm convierte las barras invertidas de Windows", () => {
    expect(norm("C:\\Users\\yo\\a.ts")).toBe("C:/Users/yo/a.ts");
    expect(norm("C:/ya/normal")).toBe("C:/ya/normal");
  });

  it("baseName acepta ambos separadores", () => {
    expect(baseName("C:/a/b/c.txt")).toBe("c.txt");
    expect(baseName("C:\\a\\b\\c.txt")).toBe("c.txt");
    expect(baseName("solo")).toBe("solo");
  });

  it("dirName devuelve la carpeta o vacío en la raíz", () => {
    expect(dirName("C:/a/b/c.txt")).toBe("C:/a/b");
    expect(dirName("C:\\a\\b.txt")).toBe("C:\\a");
    expect(dirName("c.txt")).toBe("");
    expect(dirName("/c.txt")).toBe("");
  });

  it("errMsg lee mensajes de Error y de cadenas", () => {
    expect(errMsg(new Error("falló"))).toBe("falló");
    expect(errMsg("texto")).toBe("texto");
    expect(errMsg(42)).toBe("42");
  });
});

describe("terminalFontStack", () => {
  const editor = '"Cascadia Code", Consolas, monospace';
  const names = (s: string) => s.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));

  it("sin nada propio prueba las Nerd Fonts habituales y termina en la del editor", () => {
    const s = terminalFontStack("", editor);
    expect(s).toContain('"CaskaydiaCove Nerd Font"');
    expect(s).toContain('"Symbols Nerd Font Mono"');
    expect(s.endsWith("monospace")).toBe(true);
    expect(names(s).slice(-3)).toEqual(["Cascadia Code", "Consolas", "monospace"]);
  });

  it("la fuente del usuario va primero y conserva la del editor como respaldo", () => {
    const n = names(terminalFontStack("  Mi Fuente NF  ", editor));
    expect(n[0]).toBe("Mi Fuente NF");
    expect(n).toContain("Cascadia Code");
    expect(n).not.toContain("CaskaydiaCove Nerd Font");
  });

  it("las fuentes detectadas de otras terminales van antes que las genéricas", () => {
    const n = names(terminalFontStack("", editor, ["'JetBrainsMono NF', monospace"], []));
    expect(n.indexOf("'JetBrainsMono NF'")).toBeLessThan(n.indexOf("CaskaydiaCove Nerd Font"));
  });

  it("las Nerd Fonts realmente instaladas van antes que las supuestas", () => {
    const n = names(terminalFontStack("", editor, [], ["MiNerd Font Mono"]));
    expect(n[0]).toBe("MiNerd Font Mono");
  });

  it("no repite nombres aunque lleguen por varios caminos", () => {
    const n = names(terminalFontStack("Cascadia Code", editor, ['"Cascadia Code"'], []));
    expect(n.filter((x) => x.toLowerCase() === "cascadia code").length).toBe(1);
  });

  it("un valor en blanco cuenta como vacío", () => {
    expect(terminalFontStack("   ", editor)).toBe(terminalFontStack("", editor));
  });
});
