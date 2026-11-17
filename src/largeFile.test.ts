import { describe, expect, it } from "vitest";
import { isLargeFile, LARGE_FILE_CHARS, largeFileOptions } from "./largeFile";

describe("modo de archivo grande", () => {
  it("se activa justo en el umbral", () => {
    expect(isLargeFile(LARGE_FILE_CHARS - 1)).toBe(false);
    expect(isLargeFile(LARGE_FILE_CHARS)).toBe(true);
  });
  it("desactiva las funciones que recorren todo el documento", () => {
    const o = largeFileOptions(true);
    expect(o.matchBrackets).toBe("never");
    expect(o.occurrencesHighlight).toBe("off");
    expect(o.selectionHighlight).toBe(false);
  });
  it("restablece las opciones normales al volver a un archivo pequeño", () => {
    const o = largeFileOptions(false);
    expect(o.matchBrackets).toBe("always");
    expect(o.occurrencesHighlight).toBe("singleFile");
    expect(o.selectionHighlight).toBe(true);
  });
});
