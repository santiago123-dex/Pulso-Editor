import { describe, expect, it } from "vitest";
import { planCliOpen } from "./cliOpen";

describe("planCliOpen", () => {
  it("usa la primera carpeta como espacio de trabajo y abre los archivos en su línea", () => {
    const p = planCliOpen(
      [
        { path: "/p/a", kind: "dir" },
        { path: "/p/a/x.ts", kind: "file", line: 7, col: 2 },
        { path: "/p/b", kind: "dir" },
      ],
      "/otro",
    );
    expect(p.folder).toBe("/p/a");
    expect(p.files).toEqual([{ path: "/p/a/x.ts", line: 7, col: 2 }]);
  });
  it("sin carpeta abierta, un archivo suelto abre su carpeta", () => {
    expect(planCliOpen([{ path: "/p/a/x.ts", kind: "file" }], null).folder).toBe("/p/a");
    expect(planCliOpen([{ path: "/p/a/x.ts", kind: "file" }], "/ya").folder).toBeNull();
  });
  it("separa las rutas inexistentes", () => {
    const p = planCliOpen([{ path: "/p/nada", kind: "missing" }], null);
    expect(p).toEqual({ folder: null, files: [], missing: ["/p/nada"] });
  });
});
