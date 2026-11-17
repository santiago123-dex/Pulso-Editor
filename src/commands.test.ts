import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ settings: { keybindings: {} as Record<string, string> }, overlay: false }));
vi.mock("./settings", () => ({ state: { get settings() { return h.settings; } } }));
vi.mock("./ui", () => ({ overlayOpen: () => h.overlay }));

import { allowedInTerminal, eventKey, keyOf, type Command } from "./commands";

const ev = (o: Partial<KeyboardEvent>) => ({ key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o }) as KeyboardEvent;
const cmd = (id: string, key?: string): Command => ({ id, label: id, key, run: () => {} });

beforeEach(() => { h.settings.keybindings = {}; });

describe("eventKey", () => {
  it("combina modificadores en orden fijo y pone la letra en mayúscula", () => {
    expect(eventKey(ev({ key: "p", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+P");
    expect(eventKey(ev({ key: "s", ctrlKey: true }))).toBe("Ctrl+S");
    expect(eventKey(ev({ key: "z", altKey: true }))).toBe("Alt+Z");
    expect(eventKey(ev({ key: "k", ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+K");
  });

  it("Cmd en Mac cuenta como Ctrl", () => {
    expect(eventKey(ev({ key: "s", metaKey: true }))).toBe("Ctrl+S");
  });

  it("un modificador solo no es un atajo", () => {
    for (const key of ["Control", "Shift", "Alt", "Meta"]) expect(eventKey(ev({ key, ctrlKey: true }))).toBe("");
  });

  it("los dígitos usan el código físico, así Ctrl+Shift+1 no se vuelve '!'", () => {
    expect(eventKey(ev({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(eventKey(ev({ key: "1", code: "Digit1", ctrlKey: true }))).toBe("Ctrl+1");
  });

  it("teclas especiales conservan su nombre", () => {
    expect(eventKey(ev({ key: "Tab", ctrlKey: true }))).toBe("Ctrl+Tab");
    expect(eventKey(ev({ key: "ArrowRight", ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+ArrowRight");
    expect(eventKey(ev({ key: "F2" }))).toBe("F2");
    expect(eventKey(ev({ key: " ", ctrlKey: true }))).toBe("Ctrl+Space");
  });

  it("'+' se trata como '=' para que Ctrl+= funcione con y sin Shift", () => {
    expect(eventKey(ev({ key: "+", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+=");
    expect(eventKey(ev({ key: "=", ctrlKey: true }))).toBe("Ctrl+=");
  });
});

describe("keyOf", () => {
  it("usa el atajo por defecto", () => {
    expect(keyOf(cmd("a", "Ctrl+S"))).toBe("Ctrl+S");
    expect(keyOf(cmd("b"))).toBe("");
  });

  it("el atajo personalizado tiene prioridad", () => {
    h.settings.keybindings = { a: "Ctrl+Alt+S" };
    expect(keyOf(cmd("a", "Ctrl+S"))).toBe("Ctrl+Alt+S");
  });

  it("una cadena vacía personalizada quita el atajo", () => {
    h.settings.keybindings = { a: "" };
    expect(keyOf(cmd("a", "Ctrl+S"))).toBe("");
  });
});

describe("tecla ` (terminal)", () => {
  it("se detecta por posición física: en teclados latinos ` es una tecla muerta", () => {
    expect(eventKey(ev({ key: "Dead", code: "Backquote", ctrlKey: true }))).toBe("Ctrl+`");
    expect(eventKey(ev({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+`");
  });
});

describe("atajos con el foco en la terminal", () => {
  const c = (id: string) => cmd(id);

  it("las teclas Ctrl solas son del shell (historial, borrar palabra…)", () => {
    for (const k of ["Ctrl+P", "Ctrl+W", "Ctrl+B", "Ctrl+S", "Ctrl+O", "Ctrl+N", "Ctrl+,", "Ctrl+Tab"]) {
      expect(allowedInTerminal(c("x"), k), k).toBe(false);
    }
  });

  it("pasan a la aplicación las combinaciones con Shift o Alt y las teclas de función", () => {
    for (const k of ["Ctrl+Shift+P", "Ctrl+Shift+F", "Ctrl+Shift+E", "Ctrl+Alt+ArrowRight", "Alt+Z", "F11", "F2"]) {
      expect(allowedInTerminal(c("x"), k), k).toBe(true);
    }
  });

  it("ocultar la terminal funciona siempre, aunque su atajo no lleve Shift", () => {
    expect(allowedInTerminal(c("terminal.toggle"), "Ctrl+`")).toBe(true);
  });

  it("no confunde una tecla llamada Shift o Alt con el modificador", () => {
    expect(allowedInTerminal(c("x"), "Ctrl+A")).toBe(false);
  });
});
