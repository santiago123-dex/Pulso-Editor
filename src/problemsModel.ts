import { t } from "./i18n";
/** Lógica pura del panel de problemas (sin Monaco ni DOM) para poder probarla. */

export type Severity = "error" | "warning" | "info";

export interface Problem {
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: Severity;
  message: string;
  source?: string;
  code?: string;
}

/** Valores de `monaco.MarkerSeverity`: Hint = 1, Info = 2, Warning = 4, Error = 8. Las pistas (Hint) no son problemas. */
export function severityOf(markerSeverity: number): Severity | null {
  if (markerSeverity >= 8) return "error";
  if (markerSeverity >= 4) return "warning";
  if (markerSeverity >= 2) return "info";
  return null;
}

export interface Counts { error: number; warning: number; info: number }

export function countProblems(list: readonly Problem[]): Counts {
  const c: Counts = { error: 0, warning: 0, info: 0 };
  for (const p of list) c[p.severity]++;
  return c;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export interface FileProblems { path: string; items: Problem[]; counts: Counts }

/**
 * Agrupa por archivo. Los archivos con más errores van primero; dentro de cada uno, por línea.
 * `onlyErrors` oculta avisos e información.
 */
export function groupProblems(list: readonly Problem[], onlyErrors = false): FileProblems[] {
  const by = new Map<string, Problem[]>();
  for (const p of list) {
    if (onlyErrors && p.severity !== "error") continue;
    const arr = by.get(p.path);
    if (arr) arr.push(p); else by.set(p.path, [p]);
  }
  const out: FileProblems[] = [];
  for (const [path, items] of by) {
    items.sort((a, b) => a.line - b.line || a.col - b.col || RANK[a.severity] - RANK[b.severity]);
    out.push({ path, items, counts: countProblems(items) });
  }
  return out.sort((a, b) => b.counts.error - a.counts.error || b.counts.warning - a.counts.warning || a.path.localeCompare(b.path));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

/** «2 errores, 1 aviso» o «Sin problemas». */
export function summaryText(c: Counts): string {
  const parts: string[] = [];
  if (c.error) parts.push(plural(c.error, t("1 error"), t("{n} errores")));
  if (c.warning) parts.push(plural(c.warning, t("1 aviso"), t("{n} avisos")));
  if (c.info) parts.push(plural(c.info, t("1 información"), t("{n} informaciones")));
  return parts.length ? parts.join(", ") : t("Sin problemas");
}

/** Texto corto de la barra de estado: «✖ 2  ⚠ 1». Vacío si no hay errores ni avisos. */
export function statusText(c: Counts): string {
  if (!c.error && !c.warning) return "";
  return [c.error ? `✖ ${c.error}` : "", c.warning ? `⚠ ${c.warning}` : ""].filter(Boolean).join("  ");
}

/** Longitud a seleccionar al abrir el problema: solo si termina en la misma línea. */
export function selectionLength(p: Problem): number {
  return p.endLine === p.line ? Math.max(0, p.endCol - p.col) : 0;
}
