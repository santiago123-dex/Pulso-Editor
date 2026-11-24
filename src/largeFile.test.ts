import { describe, expect, it } from "vitest";
import {
  backupDelayFor,
  isLargeFile,
  LARGE_BACKUP_DELAY_MS,
  LARGE_FILE_CHARS,
  largeFileOptions,
  NORMAL_BACKUP_DELAY_MS,
} from "./largeFile";

describe("modo de archivo grande", () => {
  it("se activa justo en el umbral", () => {
    expect(isLargeFile(LARGE_FILE_CHARS - 1)).toBe(false);
    expect(isLargeFile(LARGE_FILE_CHARS)).toBe(true);
  });
  it("espacia las copias de recuperación en archivos grandes", () => {
    expect(backupDelayFor(10_000)).toBe(NORMAL_BACKUP_DELAY_MS);
    expect(backupDelayFor(LARGE_FILE_CHARS)).toBe(LARGE_BACKUP_DELAY_MS);
  });
  it("desactiva las funciones que recorren todo el documento", () => {
    const o = largeFileOptions(true);
    expect(o.matchBrackets).toBe("never");
    expect(o.occurrencesHighlight).toBe("off");
    expect(o.selectionHighlight).toBe(false);
    expect(o.folding).toBe(false);
    expect(o.links).toBe(false);
  });
  it("restablece las opciones normales al volver a un archivo pequeño", () => {
    const o = largeFileOptions(false);
    expect(o.matchBrackets).toBe("always");
    expect(o.occurrencesHighlight).toBe("singleFile");
    expect(o.selectionHighlight).toBe(true);
    expect(o.folding).toBe(true);
  });
});
