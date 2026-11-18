import { describe, expect, it } from "vitest";
import { explorerKey, type ExplorerEntry } from "./explorerNavigation";

const entries: ExplorerEntry[] = [
  { path: "C:/proyecto/src", isDir: true, expanded: true },
  { path: "C:/proyecto/src/app.ts", isDir: false, expanded: false },
  { path: "C:/proyecto/src/nested", isDir: true, expanded: false },
  { path: "C:/proyecto/readme.md", isDir: false, expanded: false },
];

describe("navegación del explorador", () => {
  it("recorre solo las entradas visibles y respeta los límites", () => {
    expect(explorerKey(entries, null, "ArrowDown")).toEqual({ kind: "select", path: entries[0].path });
    expect(explorerKey(entries, entries[0].path, "ArrowUp")?.path).toBe(entries[0].path);
    expect(explorerKey(entries, entries[1].path, "ArrowDown")?.path).toBe(entries[2].path);
    expect(explorerKey(entries, entries[0].path, "End")?.path).toBe(entries[3].path);
    expect(explorerKey(entries, entries[3].path, "Home")?.path).toBe(entries[0].path);
    expect(explorerKey([], null, "ArrowDown")).toBeNull();
  });

  it("expande, entra, contrae y vuelve al padre", () => {
    expect(explorerKey(entries, entries[2].path, "ArrowRight")).toEqual({ kind: "expand", path: entries[2].path });
    expect(explorerKey(entries, entries[0].path, "ArrowRight")).toEqual({ kind: "select", path: entries[1].path });
    expect(explorerKey(entries, entries[0].path, "ArrowLeft")).toEqual({ kind: "collapse", path: entries[0].path });
    expect(explorerKey(entries, entries[1].path, "ArrowLeft")).toEqual({ kind: "select", path: entries[0].path });
    expect(explorerKey(entries, entries[3].path, "ArrowLeft")).toBeNull();
  });

  it("Enter abre archivos y Enter o Espacio alternan carpetas", () => {
    expect(explorerKey(entries, entries[1].path, "Enter")).toEqual({ kind: "open", path: entries[1].path });
    expect(explorerKey(entries, entries[2].path, "Enter")).toEqual({ kind: "expand", path: entries[2].path });
    expect(explorerKey(entries, entries[0].path, " ")).toEqual({ kind: "collapse", path: entries[0].path });
    expect(explorerKey(entries, entries[1].path, " ")).toBeNull();
  });
});
