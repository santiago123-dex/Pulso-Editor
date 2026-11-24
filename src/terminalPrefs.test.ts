import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    throw new Error("sin Tauri en las pruebas");
  },
}));

import {
  BUILTIN_SCHEMES,
  buildDetected,
  hasAnythingToAdapt,
  isNerdFont,
  parseVsCodeSettings,
  parseWtSettings,
  planAdaptation,
  resolveScheme,
  schemeFromWt,
  schemeOptions,
  shellIdFor,
  type ShellInfo,
} from "./terminalPrefs";
import { THEMES } from "./themes";

const shells = (ids: string[]): ShellInfo[] => ids.map((id) => ({ id, label: id, path: "C:/" + id + ".exe", args: [] }));
const ALL = shells(["pwsh", "powershell", "cmd", "gitbash", "wsl"]);

// Un settings.json de Windows Terminal real tiene comentarios y comas finales.
const WT = `{
  // Archivo de ejemplo
  "$help": "https://aka.ms/terminal-documentation",
  "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
  "profiles": {
    "defaults": { "font": { "face": "Cascadia Mono", "size": 11 }, },
    "list": [
      { "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}", "name": "Windows PowerShell", "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "colorScheme": "Mi Esquema" },
      { "guid": "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}", "name": "Símbolo del sistema", "commandline": "%SystemRoot%\\\\System32\\\\cmd.exe" }
    ]
  },
  "schemes": [
    { "name": "Mi Esquema", "background": "#1B1D26", "foreground": "#C0CAF5", "cursorColor": "#FF9E64", "selectionBackground": "#283457",
      "black": "#15161E", "red": "#F7768E", "green": "#9ECE6A", "yellow": "#E0AF68", "blue": "#7AA2F7", "purple": "#BB9AF7", "cyan": "#7DCFFF", "white": "#A9B1D6",
      "brightBlack": "#414868", "brightRed": "#F7768E", "brightGreen": "#9ECE6A", "brightYellow": "#E0AF68", "brightBlue": "#7AA2F7", "brightPurple": "#BB9AF7", "brightCyan": "#7DCFFF", "brightWhite": "#C0CAF5" }
  ],
}`;

describe("esquemas incluidos", () => {
  it("todos tienen los 16 colores ANSI, fondo, texto y cursor en formato válido", () => {
    for (const [id, s] of Object.entries(BUILTIN_SCHEMES)) {
      for (const k of [
        "background",
        "foreground",
        "cursor",
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightMagenta",
        "brightCyan",
        "brightWhite",
      ]) {
        expect(s.colors[k], `${id}.${k}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("Campbell trae los valores oficiales de Windows", () => {
    const c = BUILTIN_SCHEMES.campbell.colors;
    expect([c.background, c.foreground, c.red, c.blue]).toEqual(["#0c0c0c", "#cccccc", "#c50f1f", "#0037da"]);
  });
});

describe("schemeFromWt", () => {
  it("traduce purple, brightPurple y cursorColor a los nombres de xterm", () => {
    const s = schemeFromWt({
      background: "#101010",
      foreground: "#eeeeee",
      cursorColor: "#ff0000",
      purple: "#aa00aa",
      brightPurple: "#ff00ff",
    })!;
    expect(s.cursor).toBe("#ff0000");
    expect(s.magenta).toBe("#aa00aa");
    expect(s.brightMagenta).toBe("#ff00ff");
    expect(s.cursorAccent).toBe("#101010");
  });

  it("rellena con Campbell lo que el esquema no define y pone una selección por defecto", () => {
    const s = schemeFromWt({ background: "#101010", foreground: "#eeeeee" })!;
    expect(s.red).toBe(BUILTIN_SCHEMES.campbell.colors.red);
    expect(s.selectionBackground).toBe("#eeeeee40");
  });

  it("ignora colores con formato inválido y descarta objetos sin colores", () => {
    expect(schemeFromWt({ background: "rojo", foreground: "azul" })).toBeNull();
    expect(schemeFromWt({ nombre: "vacío" })).toBeNull();
    const s = schemeFromWt({ background: "#101010", foreground: "#eeeeee", red: "no-es-color" })!;
    expect(s.red).toBe(BUILTIN_SCHEMES.campbell.colors.red);
  });
});

describe("parseWtSettings", () => {
  const p = parseWtSettings(WT);

  it("lee el archivo aunque tenga comentarios y comas finales", () => {
    expect(p.schemeName).toBe("Mi Esquema");
  });

  it("toma la fuente y el tamaño de los valores por defecto del perfil", () => {
    expect(p.font).toBe("Cascadia Mono");
    expect(p.size).toBe(11);
  });

  it("encuentra el esquema propio del perfil por defecto", () => {
    expect(p.scheme?.background).toBe("#1b1d26");
    expect(p.scheme?.magenta).toBe("#bb9af7");
    expect(p.scheme?.cursor).toBe("#ff9e64");
  });

  it("describe el perfil para poder elegir la misma shell", () => {
    expect(p.profile).toContain("Windows PowerShell");
  });

  it("un esquema integrado de Windows Terminal se resuelve por nombre", () => {
    const text = `{ "defaultProfile": "{a}", "profiles": { "defaults": { "colorScheme": "One Half Dark" }, "list": [{ "guid": "{a}", "name": "PowerShell" }] } }`;
    expect(parseWtSettings(text).scheme?.background).toBe("#282c34");
  });

  it("sin colorScheme usa Campbell, como Windows Terminal", () => {
    const text = `{ "defaultProfile": "{a}", "profiles": { "list": [{ "guid": "{a}", "name": "cmd" }] } }`;
    const r = parseWtSettings(text);
    expect(r.schemeName).toBe("Campbell");
    expect(r.scheme?.background).toBe("#0c0c0c");
  });

  it("el colorScheme puede ser un objeto claro/oscuro", () => {
    const text = `{ "profiles": { "defaults": { "colorScheme": { "dark": "Vintage", "light": "One Half Light" } }, "list": [] } }`;
    expect(parseWtSettings(text).schemeName).toBe("Vintage");
  });

  it("entiende el formato antiguo (fontFace/fontSize) y un perfil con su propia fuente", () => {
    const text = `{ "defaultProfile": "{a}", "profiles": { "defaults": { "fontFace": "Consolas", "fontSize": 10 }, "list": [{ "guid": "{a}", "name": "x", "font": { "face": "Fira Code", "size": 13 } }] } }`;
    const r = parseWtSettings(text);
    expect([r.font, r.size]).toEqual(["Fira Code", 13]);
    expect([parseWtSettings(`{ "profiles": { "defaults": { "fontFace": "Consolas", "fontSize": 10 }, "list": [] } }`).font]).toEqual([
      "Consolas",
    ]);
  });

  it("un archivo roto o vacío no lanza error", () => {
    expect(parseWtSettings("{no es json")).toEqual({});
    expect(() => parseWtSettings("{}")).not.toThrow();
  });
});

describe("parseVsCodeSettings", () => {
  it("lee fuente, tamaño, cursor y perfil de la terminal", () => {
    const p = parseVsCodeSettings(`{
      // mi configuración
      "terminal.integrated.fontFamily": "'JetBrainsMono Nerd Font', monospace",
      "terminal.integrated.fontSize": 13,
      "terminal.integrated.cursorStyle": "line",
      "terminal.integrated.defaultProfile.windows": "PowerShell",
      "editor.fontFamily": "Fira Code",
    }`);
    expect(p).toEqual({ font: "'JetBrainsMono Nerd Font', monospace", size: 13, cursor: "bar", profile: "PowerShell" });
  });

  it("sin fuente de terminal usa la del editor, como hace VS Code", () => {
    expect(parseVsCodeSettings(`{ "editor.fontFamily": "Fira Code" }`).font).toBe("Fira Code");
  });

  it("ignora valores de tipo equivocado", () => {
    const p = parseVsCodeSettings(
      `{ "terminal.integrated.fontSize": "grande", "terminal.integrated.fontFamily": 5, "terminal.integrated.cursorStyle": "raro" }`,
    );
    expect(p.size).toBeUndefined();
    expect(p.font).toBeUndefined();
    expect(p.cursor).toBeUndefined();
  });

  it("un archivo vacío o roto no lanza error", () => {
    expect(parseVsCodeSettings("")).toEqual({});
    expect(parseVsCodeSettings("{x")).toEqual({});
  });
});

describe("shellIdFor", () => {
  it("elige la shell instalada que corresponde al perfil", () => {
    expect(shellIdFor("Windows PowerShell", ALL)).toBe("powershell");
    expect(shellIdFor("PowerShell", ALL)).toBe("pwsh");
    expect(shellIdFor("Windows.Terminal.PowershellCore", ALL)).toBe("pwsh");
    expect(shellIdFor("Command Prompt", ALL)).toBe("cmd");
    expect(shellIdFor("Símbolo del sistema", ALL)).toBe("cmd");
    expect(shellIdFor("Git Bash", ALL)).toBe("gitbash");
    expect(shellIdFor("Ubuntu-22.04", ALL)).toBe("wsl");
  });

  it("si la shell no está instalada no inventa otra distinta", () => {
    expect(shellIdFor("Git Bash", shells(["pwsh"]))).toBeUndefined();
    expect(shellIdFor("Ubuntu", shells(["cmd"]))).toBeUndefined();
  });

  it("'PowerShell' cae en Windows PowerShell si no hay PowerShell 7", () => {
    expect(shellIdFor("PowerShell", shells(["powershell", "cmd"]))).toBe("powershell");
  });

  it("perfiles desconocidos o vacíos no devuelven nada", () => {
    expect(shellIdFor(undefined, ALL)).toBeUndefined();
    expect(shellIdFor("Mi perfil raro", ALL)).toBeUndefined();
  });
});

describe("detección y adaptación", () => {
  it("reconoce las Nerd Fonts por su nombre", () => {
    for (const n of ["CaskaydiaCove Nerd Font", "JetBrainsMono NF", "FiraCode NFM", "Hack Nerd Font Mono", "MesloLGS NF"])
      expect(isNerdFont(n), n).toBe(true);
    for (const n of ["Cascadia Code", "Consolas", "Segoe UI", "Infinity"]) expect(isNerdFont(n), n).toBe(false);
  });

  it("junta lo leído de VS Code, de Windows Terminal y de las fuentes instaladas", () => {
    const d = buildDetected(
      [
        { kind: "wt", text: WT },
        { kind: "vscode", text: `{ "terminal.integrated.fontSize": 14 }` },
      ],
      ["Consolas", "CaskaydiaCove Nerd Font Mono", "Segoe UI"],
    );
    expect(d.nerd).toEqual(["CaskaydiaCove Nerd Font Mono"]);
    expect(d.wt?.schemeName).toBe("Mi Esquema");
    expect(d.vscode?.size).toBe(14);
  });

  it("sin configuración de nadie no hay nada que adaptar", () => {
    expect(hasAnythingToAdapt(buildDetected([], ["Consolas"]), ALL)).toBe(false);
  });

  it("con un esquema propio sí hay algo que ofrecer", () => {
    expect(hasAnythingToAdapt(buildDetected([{ kind: "wt", text: WT }], []), ALL)).toBe(true);
  });

  it("el plan resume fuente, tamaño, colores y shell que se aplicarían", () => {
    const plan = planAdaptation(
      buildDetected(
        [
          { kind: "wt", text: WT },
          { kind: "vscode", text: `{ "terminal.integrated.cursorStyle": "underline" }` },
        ],
        [],
      ),
      ALL,
    );
    expect(plan).toMatchObject({ font: "Cascadia Mono", size: 11, scheme: "wt", shell: "powershell", cursor: "underline" });
    expect(plan.summary).toEqual(["Fuente: Cascadia Mono", "Tamaño: 11", "Colores: Mi Esquema", "Shell: powershell"]);
  });

  it("la fuente de Windows Terminal tiene prioridad sobre la de VS Code", () => {
    const plan = planAdaptation(
      buildDetected(
        [
          { kind: "wt", text: WT },
          { kind: "vscode", text: `{ "terminal.integrated.fontFamily": "Fira Code" }` },
        ],
        [],
      ),
      ALL,
    );
    expect(plan.font).toBe("Cascadia Mono");
  });
});

describe("resolveScheme y opciones", () => {
  const det = buildDetected([{ kind: "wt", text: WT }], []);
  const theme = THEMES.dracula;

  it('"" sigue el tema del editor', () => {
    expect(resolveScheme("", det, theme).background).toBe(theme.editor);
  });

  it('"wt" usa el esquema de Windows Terminal', () => {
    expect(resolveScheme("wt", det, theme).background).toBe("#1b1d26");
  });

  it('"builtin:<id>" usa un esquema incluido y devuelve una copia', () => {
    const s = resolveScheme("builtin:campbell", det, theme);
    expect(s.background).toBe("#0c0c0c");
    s.background = "#ffffff";
    expect(BUILTIN_SCHEMES.campbell.colors.background).toBe("#0c0c0c");
  });

  it("un valor desconocido o un 'wt' sin esquema cae al tema del editor", () => {
    expect(resolveScheme("builtin:no-existe", det, theme).background).toBe(theme.editor);
    expect(resolveScheme("wt", buildDetected([], []), theme).background).toBe(theme.editor);
    expect(resolveScheme("wt", null, theme).background).toBe(theme.editor);
  });

  it("las opciones ofrecen Windows Terminal solo si hay esquema detectado", () => {
    expect(schemeOptions(det).some((o) => o.value === "wt")).toBe(true);
    expect(schemeOptions(null).some((o) => o.value === "wt")).toBe(false);
    expect(schemeOptions(null)[0]).toEqual({ value: "", label: "Igual que el tema del editor" });
  });
});
