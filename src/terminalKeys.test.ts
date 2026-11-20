import { describe, expect, it } from "vitest";
import { terminalKeyAction } from "./terminalKeys";

const ev = (o: Partial<KeyboardEvent>): Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"> => ({
  type: "keydown",
  key: "",
  code: "",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...o,
});

describe("terminalKeyAction", () => {
  it("Ctrl+C sin selección envía interrupt (\\x03)", () => {
    expect(terminalKeyAction(ev({ key: "c", code: "KeyC", ctrlKey: true }), false)).toBe("interrupt");
    expect(terminalKeyAction(ev({ key: "C", code: "KeyC", ctrlKey: true }), false)).toBe("interrupt");
    expect(terminalKeyAction(ev({ key: "Process", code: "KeyC", ctrlKey: true }), false)).toBe("interrupt");
  });

  it("Ctrl+C con selección copia (y luego se limpia para que el siguiente Ctrl+C interrumpa)", () => {
    expect(terminalKeyAction(ev({ key: "c", code: "KeyC", ctrlKey: true }), true)).toBe("copy");
  });

  it("Ctrl+Shift+C copia siempre y Ctrl+Shift+V pega", () => {
    expect(terminalKeyAction(ev({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), true)).toBe("copy-keep");
    expect(terminalKeyAction(ev({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), false)).toBe("copy-keep");
    expect(terminalKeyAction(ev({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), false)).toBe("paste");
  });

  it("Ctrl+Break envía interrupt aunque haya selección", () => {
    expect(terminalKeyAction(ev({ key: "Cancel", code: "Pause", ctrlKey: true }), true)).toBe("interrupt");
  });

  it("ignora eventos keyup/keypress y otras teclas", () => {
    expect(terminalKeyAction(ev({ type: "keyup", key: "c", code: "KeyC", ctrlKey: true }), false)).toBeNull();
    expect(terminalKeyAction(ev({ key: "c", code: "KeyC" }), false)).toBeNull();
    expect(terminalKeyAction(ev({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});
