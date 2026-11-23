import { describe, expect, it } from "vitest";
import { formatBytes, isBinaryImageFile, isImageFile, isMarkdownFile } from "./preview";

describe("preview helpers", () => {
  it("reconoce imágenes binarias, SVG y Markdown", () => {
    expect(isBinaryImageFile("logo.png")).toBe(true);
    expect(isBinaryImageFile("foto.JPEG")).toBe(true);
    expect(isBinaryImageFile("icono.svg")).toBe(false);
    expect(isImageFile("icono.svg")).toBe(true);
    expect(isImageFile("src/main.ts")).toBe(false);
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("docs/guia.MDX")).toBe(true);
    expect(isMarkdownFile("src/main.ts")).toBe(false);
  });

  it("formatea tamaños de archivo de forma legible", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_572_864)).toBe("1.50 MB");
  });
});
