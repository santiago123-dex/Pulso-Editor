import type { Problem, Severity } from "./problemsModel";

/** Diagnóstico devuelto por el comando Rust `project_check`. */
export interface ProjectDiagnostic {
  path: string;
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  severity: string;
  message: string;
  source: string;
  code?: string | null;
}

export interface ProjectCheckResult {
  tools: string[];
  items: ProjectDiagnostic[];
  duration_ms: number;
  note?: string | null;
}

export type ProblemScope = "open" | "project";

function toSeverity(raw: string): Severity {
  if (raw === "error") return "error";
  if (raw === "warning") return "warning";
  return "info";
}

export function fromProjectDiagnostics(list: readonly ProjectDiagnostic[]): Problem[] {
  return list.map((d) => ({
    path: d.path,
    line: Math.max(1, d.line),
    col: Math.max(1, d.col),
    endLine: Math.max(1, d.end_line || d.line),
    endCol: Math.max(1, d.end_col || d.col),
    severity: toSeverity(d.severity),
    message: d.message,
    source: d.source,
    code: d.code ?? undefined,
  }));
}

/**
 * Combina diagnósticos de archivos abiertos con resultados del análisis completo,
 * eliminando duplicados exactos (mismo archivo, línea, columna y mensaje).
 */
export function mergeProblems(open: readonly Problem[], project: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const p of [...open, ...project]) {
    const key = `${p.path.toLowerCase()}:${p.line}:${p.col}:${p.code ?? ""}:${p.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
