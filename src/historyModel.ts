/** Lógica pura del historial de Git, de la culpa (blame) y de fechas relativas. */
export interface CommitInfo { hash: string; short: string; author: string; email: string; date: string; subject: string; refs: string[] }
export interface CommitFile { status: string; path: string; orig: string | null }

export const PAGE = 40;

export interface RefChip { label: string; kind: "head" | "branch" | "remote" | "tag" }

/** `HEAD -> main, origin/main, tag: v1` → etiquetas legibles; `origin/HEAD` no aporta nada y se omite. */
export function refChips(refs: readonly string[]): RefChip[] {
  const out: RefChip[] = [];
  for (const raw of refs) {
    const r = raw.trim();
    if (!r || /\/HEAD$/.test(r)) continue;
    if (r.startsWith("HEAD -> ")) out.push({ label: r.slice(8), kind: "head" });
    else if (r === "HEAD") out.push({ label: "HEAD", kind: "head" });
    else if (r.startsWith("tag: ")) out.push({ label: r.slice(5), kind: "tag" });
    else if (r.includes("/")) out.push({ label: r, kind: "remote" });
    else out.push({ label: r, kind: "branch" });
  }
  return out;
}

/** Une una página nueva al historial sin repetir commits. */
export function mergeCommits(existing: readonly CommitInfo[], more: readonly CommitInfo[]): CommitInfo[] {
  const seen = new Set(existing.map((c) => c.hash));
  return [...existing, ...more.filter((c) => !seen.has(c.hash))];
}

/** Si la última página vino completa puede haber más. */
export const mayHaveMore = (batch: readonly unknown[], limit = PAGE) => batch.length >= limit;

/** «hace 5 min», «hace 3 h», «hace 2 d», «hace 3 meses», «hace 2 años». */
export function agoFrom(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  if (d < 30) return `hace ${d} d`;
  if (d < 365) { const m = Math.round(d / 30); return `hace ${m} ${m === 1 ? "mes" : "meses"}`; }
  const y = Math.round(d / 365);
  return `hace ${y} ${y === 1 ? "año" : "años"}`;
}

export const agoIso = (iso: string, now = Date.now()) => { const t = Date.parse(iso); return Number.isNaN(t) ? "" : agoFrom(t, now); };

export const STATUS_LABEL: Record<string, string> = { M: "Modificado", A: "Añadido", D: "Eliminado", R: "Renombrado" };

/** Ruta de un archivo relativa a la raíz del repositorio, o null si está fuera (sin distinguir mayúsculas, como en Windows). */
export function relativeToTop(path: string, top: string): string | null {
  const p = path.replace(/\\/g, "/");
  const t = top.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.toLowerCase().startsWith(t.toLowerCase() + "/")) return p.slice(t.length + 1);
  return null;
}

export interface BlameLine { line: number; hash: string; author: string; time: number; summary: string }

/** Texto de la anotación de culpa de una línea; para una línea sin commit lo dice. */
export function blameText(b: BlameLine | undefined, now = Date.now()): string {
  if (!b) return "";
  if (!b.hash) return "Cambio sin confirmar";
  const summary = b.summary.length > 60 ? `${b.summary.slice(0, 57)}…` : b.summary;
  return `${b.author}, ${agoFrom(b.time * 1000, now)} · ${summary}`;
}
