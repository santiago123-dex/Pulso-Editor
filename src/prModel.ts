import { t } from "./i18n";
/** Lógica pura de las pull requests (sin red ni DOM). */
export interface PullSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  body?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export type PrState = "open" | "draft" | "merged" | "closed";

export function prState(pr: Pick<PullSummary, "state" | "draft" | "merged_at">): PrState {
  if (pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

export const PR_STATE_LABEL: Record<PrState, string> = { open: t("Abierta"), draft: t("Borrador"), merged: t("Fusionada"), closed: t("Cerrada") };

export const branchLabel = (pr: Pick<PullSummary, "head" | "base">) => `${pr.head.ref} → ${pr.base.ref}`;

/** Letra de estado de un archivo, la misma que usa el panel de Git. */
export function fileLetter(status: string): "A" | "D" | "R" | "M" {
  if (status === "added") return "A";
  if (status === "removed") return "D";
  if (status === "renamed") return "R";
  return "M";
}

export function totals(files: readonly Pick<PullFile, "additions" | "deletions">[]): { additions: number; deletions: number } {
  return files.reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 });
}

/** «feature/mi-cambio_nuevo» → «Mi cambio nuevo». */
export function humanizeBranch(branch: string): string {
  const last = branch.split("/").pop() ?? branch;
  const words = last.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

/** Título propuesto: el del último commit si hay uno; si no, el nombre de la rama en lenguaje normal. */
export const suggestTitle = (lastSubject: string | null, branch: string): string => (lastSubject?.trim() ? lastSubject.trim() : humanizeBranch(branch));

export interface NewPullInput { title: string; head: string; base: string; hasUpstream: boolean }

/** Por qué no se puede crear aún la pull request, en lenguaje de persona; null si todo está bien. */
export function newPullProblem(i: NewPullInput): string | null {
  if (!i.head.trim()) return t("No hay una rama activa. Crea o elige una rama para abrir una pull request.");
  if (i.head === i.base) return t("Estás en «{branch}», la rama a la que irían los cambios. Crea otra rama con tu trabajo y vuelve a intentarlo.", { branch: i.base });
  if (!i.hasUpstream) return t("La rama «{branch}» todavía no está en GitHub. Súbela primero (botón de subir en Control de código) y vuelve a intentarlo.", { branch: i.head });
  if (!i.title.trim()) return t("Escribe un título.");
  return null;
}

/** Texto de un error 422 de GitHub al crear una pull request. */
export function explainCreateError(status: number, body: { message?: string; errors?: { message?: string; code?: string }[] } | null): string {
  const msgs = (body?.errors ?? []).map((e) => e.message).filter(Boolean) as string[];
  const joined = msgs.join(" ");
  if (/already exists/i.test(joined)) return t("Ya hay una pull request abierta para esta rama.");
  if (/no commits between/i.test(joined)) return t("La rama no tiene commits nuevos respecto a la rama de destino: no hay nada que proponer.");
  if (status === 404) return t("GitHub no encontró el repositorio o la rama. Comprueba que la rama esté subida y que tu cuenta tenga acceso.");
  if (status === 403) return t("GitHub no permitió crear la pull request: tu cuenta necesita permiso de escritura en el repositorio.");
  if (msgs.length) return t("GitHub rechazó la pull request: {reason}", { reason: joined });
  return body?.message ? t("GitHub rechazó la pull request: {reason}", { reason: body.message }) : t("GitHub respondió {status}", { status });
}
