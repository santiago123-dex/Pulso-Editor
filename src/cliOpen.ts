/** Qué hacer con las rutas que llegan por la línea de comandos (`pulso archivo`, `pulso carpeta`, `pulso -g archivo:línea`). */
export type CliTarget = { path: string; kind: "file" | "dir" | "missing"; line?: number | null; col?: number | null };

export type CliPlan = {
  /** Carpeta que pasa a ser el espacio de trabajo (la primera carpeta indicada, o la del primer archivo si no hay ninguna abierta). */
  folder: string | null;
  files: { path: string; line: number; col: number }[];
  missing: string[];
};

const parentDir = (p: string) => p.replace(/\/[^/]*$/, "") || "/";

export function planCliOpen(targets: CliTarget[], currentRoot: string | null): CliPlan {
  const folder = targets.find((t) => t.kind === "dir")?.path ?? null;
  const files = targets
    .filter((t) => t.kind === "file")
    .map((t) => ({ path: t.path, line: Math.max(1, t.line ?? 1), col: Math.max(1, t.col ?? 1) }));
  const missing = targets.filter((t) => t.kind === "missing").map((t) => t.path);
  return { folder: folder ?? (!currentRoot && files[0] ? parentDir(files[0].path) : null), files, missing };
}
