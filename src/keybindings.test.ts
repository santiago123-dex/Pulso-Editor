import { describe, expect, it } from "vitest";
import {
  assignKey,
  duplicatedKeys,
  effectiveKey,
  findConflicts,
  groupByCategory,
  isCustom,
  keyParts,
  matches,
  reservedFor,
  resetKey,
  searchable,
  splitLabel,
  type KbCommand,
} from "./keybindings";

const cmds: KbCommand[] = [
  { id: "file.save", label: "Archivo: Guardar", key: "Ctrl+S" },
  { id: "file.open", label: "Archivo: Abrir carpeta…", key: "Ctrl+O" },
  { id: "terminal.toggle", label: "Terminal: Mostrar u ocultar", key: "Ctrl+J" },
  { id: "view.search", label: "Ver: Buscar en archivos", key: "Ctrl+Shift+F" },
  { id: "palette", label: "Paleta de comandos" },
];

describe("atajo vigente", () => {
  it("usa el de fábrica salvo que haya una personalización", () => {
    expect(effectiveKey(cmds[0], {})).toBe("Ctrl+S");
    expect(effectiveKey(cmds[0], { "file.save": "Ctrl+Alt+S" })).toBe("Ctrl+Alt+S");
  });

  it("una personalización vacía quita el atajo", () => {
    expect(effectiveKey(cmds[0], { "file.save": "" })).toBe("");
  });

  it("un comando sin atajo de fábrica devuelve cadena vacía", () => {
    expect(effectiveKey(cmds[4], {})).toBe("");
  });
});

describe("conflictos", () => {
  it("encuentra a quien ya usa la combinación", () => {
    expect(findConflicts(cmds, {}, "file.open", "Ctrl+S").map((c) => c.id)).toEqual(["file.save"]);
  });

  it("no se considera conflicto consigo mismo ni con una tecla vacía", () => {
    expect(findConflicts(cmds, {}, "file.save", "Ctrl+S")).toEqual([]);
    expect(findConflicts(cmds, { "file.save": "" }, "file.open", "")).toEqual([]);
  });

  it("tiene en cuenta las personalizaciones, no solo las teclas de fábrica", () => {
    const o = { "file.save": "Ctrl+K" };
    expect(findConflicts(cmds, o, "file.open", "Ctrl+S")).toEqual([]);
    expect(findConflicts(cmds, o, "file.open", "Ctrl+K").map((c) => c.id)).toEqual(["file.save"]);
  });

  it("avisa de las teclas que ya usa el editor", () => {
    expect(reservedFor("Ctrl+Z")).toBe("deshacer");
    expect(reservedFor("Ctrl+C")).toBe("copiar");
    expect(reservedFor("Ctrl+Shift+F")).toBeUndefined();
  });
});

describe("asignar un atajo", () => {
  it("guarda la personalización", () => {
    expect(assignKey(cmds, {}, "file.save", "Ctrl+Alt+S")).toEqual({ "file.save": "Ctrl+Alt+S" });
  });

  it("al quitar la tecla a otro comando lo deja sin atajo", () => {
    const next = assignKey(cmds, {}, "file.open", "Ctrl+S");
    expect(next["file.open"]).toBe("Ctrl+S");
    expect(next["file.save"]).toBe("");
    expect(effectiveKey(cmds[0], next)).toBe("");
  });

  it("volver a poner la tecla de fábrica elimina la personalización", () => {
    const o = assignKey(cmds, {}, "file.save", "Ctrl+Alt+S");
    expect(assignKey(cmds, o, "file.save", "Ctrl+S")).toEqual({});
  });

  it("quitar el atajo (cadena vacía) lo deja sin tecla", () => {
    expect(assignKey(cmds, {}, "file.save", "")).toEqual({ "file.save": "" });
  });

  it("un comando sin atajo de fábrica al que se le quita la tecla no deja personalización", () => {
    const o = assignKey(cmds, {}, "palette", "Ctrl+P");
    expect(o).toEqual({ palette: "Ctrl+P" });
    expect(assignKey(cmds, o, "palette", "")).toEqual({});
  });

  it("no modifica el objeto original", () => {
    const o = { "file.save": "Ctrl+K" };
    assignKey(cmds, o, "file.open", "Ctrl+K");
    expect(o).toEqual({ "file.save": "Ctrl+K" });
  });

  it("intercambiar dos atajos a mano deja a cada comando con la tecla del otro", () => {
    let o = assignKey(cmds, {}, "file.save", "Ctrl+O");
    o = assignKey(cmds, o, "file.open", "Ctrl+S");
    expect(effectiveKey(cmds[0], o)).toBe("Ctrl+O");
    expect(effectiveKey(cmds[1], o)).toBe("Ctrl+S");
    expect(duplicatedKeys(cmds, o).size).toBe(0);
  });
});

describe("restablecer", () => {
  it("resetKey vuelve al atajo de fábrica", () => {
    const o = { "file.save": "Ctrl+Alt+S", "file.open": "" };
    const next = resetKey(o, "file.save");
    expect(next).toEqual({ "file.open": "" });
    expect(isCustom(next, "file.save")).toBe(false);
    expect(isCustom(next, "file.open")).toBe(true);
  });
});

describe("presentación", () => {
  it("separa categoría y nombre", () => {
    expect(splitLabel("Archivo: Guardar")).toEqual({ category: "Archivo", name: "Guardar" });
    expect(splitLabel("Paleta de comandos")).toEqual({ category: "General", name: "Paleta de comandos" });
  });

  it("no toma como categoría un texto largo con dos puntos", () => {
    expect(splitLabel("Una descripción muy larga que contiene: dos puntos").category).toBe("General");
  });

  it("dibuja cada tecla por separado con símbolos para las flechas", () => {
    expect(keyParts("Ctrl+Shift+P")).toEqual(["Ctrl", "Shift", "P"]);
    expect(keyParts("Ctrl+Alt+ArrowRight")).toEqual(["Ctrl", "Alt", "→"]);
    expect(keyParts("Ctrl+=")).toEqual(["Ctrl", "="]);
    expect(keyParts("")).toEqual([]);
  });

  it("agrupa por categoría conservando el orden", () => {
    const g = groupByCategory(cmds);
    expect(g.map((x) => x.category)).toEqual(["Archivo", "Terminal", "Ver", "General"]);
    expect(g[0].items.map((c) => c.id)).toEqual(["file.save", "file.open"]);
  });
});

describe("búsqueda", () => {
  it("encuentra por nombre, por id y por tecla sin importar el formato", () => {
    expect(matches(cmds[0], {}, "guardar")).toBe(true);
    expect(matches(cmds[0], {}, "file.save")).toBe(true);
    expect(matches(cmds[0], {}, "ctrl+s")).toBe(true);
    expect(matches(cmds[0], {}, "CTRL S")).toBe(true);
    expect(matches(cmds[0], {}, "terminal")).toBe(false);
  });

  it("busca por la tecla personalizada vigente, no por la de fábrica", () => {
    const o = { "file.save": "Ctrl+Alt+K" };
    expect(matches(cmds[0], o, "alt k")).toBe(true);
    expect(matches(cmds[0], o, "ctrl s")).toBe(false);
  });

  it("todas las palabras deben coincidir", () => {
    expect(matches(cmds[3], {}, "buscar archivos")).toBe(true);
    expect(matches(cmds[3], {}, "buscar guardar")).toBe(false);
  });

  it("una búsqueda vacía lo muestra todo", () => {
    expect(matches(cmds[0], {}, "   ")).toBe(true);
    expect(searchable("Ctrl+Shift+P")).toBe("ctrl shift p");
  });
});

describe("duplicados", () => {
  it("detecta dos comandos con la misma tecla", () => {
    const o = { palette: "Ctrl+S" };
    expect(Array.from(duplicatedKeys(cmds, o).entries())).toEqual([["Ctrl+S", ["file.save", "palette"]]]);
  });

  it("sin duplicados devuelve vacío", () => {
    expect(duplicatedKeys(cmds, {}).size).toBe(0);
  });
});
