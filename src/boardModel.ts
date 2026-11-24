import { t } from "./i18n";
import type { Issue } from "./github";

export type Column = "todo" | "doing" | "review" | "done";

export const COLUMNS: { id: Column; title: string }[] = [
  { id: "todo", title: t("Por hacer") },
  { id: "doing", title: t("En curso") },
  { id: "review", title: t("En revisión") },
  { id: "done", title: t("Hecho") },
];

export const DEFAULT_PROGRESS_LABEL = "in progress";
export const REVIEW_LABEL = "pulso: in review";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const hasLabel = (issue: Issue, label: string) => !!label.trim() && issue.labels.some((l) => same(l.name, label));

/** Una issue cerrada está hecha; una abierta está en curso si lleva la etiqueta elegida y, si no, por hacer. */
export function columnOf(issue: Issue, progressLabel: string): Column {
  if (issue.state === "closed") return "done";
  if (hasLabel(issue, REVIEW_LABEL)) return "review";
  return hasLabel(issue, progressLabel) ? "doing" : "todo";
}

export function groupIssues(issues: Issue[], progressLabel: string): Record<Column, Issue[]> {
  const out: Record<Column, Issue[]> = { todo: [], doing: [], review: [], done: [] };
  for (const i of issues) out[columnOf(i, progressLabel)].push(i);
  return out;
}

export type Step = { op: "addLabel" | "removeLabel" | "open" | "close"; label?: string };

/**
 * Qué hay que hacer en GitHub para pasar una issue a otra columna. Reabrir va antes que etiquetar y cerrar
 * después de quitar la etiqueta, de modo que un fallo a medias no deja una issue cerrada con etiqueta de «en curso».
 */
export function planMove(issue: Issue, to: Column, progressLabel: string): Step[] {
  const from = columnOf(issue, progressLabel);
  if (from === to) return [];
  const label = progressLabel.trim();
  const labeled = hasLabel(issue, progressLabel);
  const reviewing = hasLabel(issue, REVIEW_LABEL);
  const steps: Step[] = [];
  if (to === "done") {
    if (labeled) steps.push({ op: "removeLabel", label });
    if (reviewing && !same(label, REVIEW_LABEL)) steps.push({ op: "removeLabel", label: REVIEW_LABEL });
    steps.push({ op: "close" });
    return steps;
  }
  if (issue.state === "closed") steps.push({ op: "open" });
  if (reviewing && to !== "review" && !same(label, REVIEW_LABEL)) steps.push({ op: "removeLabel", label: REVIEW_LABEL });
  if (to === "doing") { if (!labeled) steps.push({ op: "addLabel", label }); }
  else if (labeled) steps.push({ op: "removeLabel", label });
  if (to === "review" && !reviewing) steps.push({ op: "addLabel", label: REVIEW_LABEL });
  return steps;
}

/** La issue tal como quedaría tras mover la tarjeta; sirve para mostrar el cambio antes de que GitHub responda. */
export function applyMove(issue: Issue, to: Column, progressLabel: string): Issue {
  let labels = issue.labels;
  let state = issue.state;
  for (const s of planMove(issue, to, progressLabel)) {
    if (s.op === "addLabel") labels = [...labels, { name: s.label!, color: "ededed" }];
    else if (s.op === "removeLabel") labels = labels.filter((l) => !same(l.name, s.label!));
    else state = s.op === "close" ? "closed" : "open";
  }
  return { ...issue, labels, state };
}

/** «bug, ui, bug» → ["bug", "ui"]: separa por comas, recorta y quita repetidas sin distinguir mayúsculas. */
export function parseLabels(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export const labelsText = (issue: Issue) => issue.labels.map((l) => l.name).join(", ");

/** Etiquetas con las que nace una issue creada en una columna: «En curso» lleva la de progreso. */
export const labelsForNew = (col: Column, progressLabel: string): string[] => col === "review" ? [REVIEW_LABEL] : (col === "doing" && progressLabel.trim() ? [progressLabel.trim()] : []);

/** Sustituye la issue con el mismo número o, si es nueva, la pone la primera. */
export function upsertIssue(list: Issue[], issue: Issue): Issue[] {
  return list.some((i) => i.number === issue.number) ? list.map((i) => (i.number === issue.number ? issue : i)) : [issue, ...list];
}

const fingerprint = (i: Issue) =>
  [i.number, i.state, i.title, i.comments, i.updated_at ?? "", i.labels.map((l) => l.name).join("\u0001"), (i.assignees ?? []).map((a) => a.login).join("\u0001")].join("\u0002");

/** Dos listas de issues son iguales a efectos del tablero: sirve para no repintar si nada cambió. */
export function sameIssues(a: Issue[], b: Issue[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(fingerprint).sort();
  const right = b.map(fingerprint).sort();
  return left.every((x, i) => x === right[i]);
}

export interface RefreshState { now: number; last: number; minGap: number; interval: number; trigger: "focus" | "timer"; hasToken: boolean; visible: boolean; busy: boolean; blocked: boolean }

/**
 * ¿Toca recargar el tablero solo? Nunca si hay un diálogo, un arrastre o un cambio en curso, ni con la ventana oculta.
 * Al volver a la ventana se recarga si pasó `minGap`; el temporizador solo actúa con token (sin él, 60 consultas
 * por hora se agotan enseguida) y cada `interval`.
 */
export function refreshDue(s: RefreshState): boolean {
  if (s.busy || s.blocked || !s.visible) return false;
  const since = s.now - s.last;
  if (s.trigger === "focus") return since >= s.minGap;
  return s.hasToken && since >= s.interval;
}

/** Definición de una columna personalizada del tablero basada en una etiqueta de GitHub. */
export interface CustomColumnDef { id: string; title: string; label: string }

/** Parsea «Bloqueado=blocked, QA=qa» o líneas «Título=etiqueta» en columnas personalizadas válidas. */
export function parseCustomColumns(raw: string): CustomColumnDef[] {
  const out: CustomColumnDef[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const title = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim();
    const label = (eq >= 0 ? trimmed.slice(eq + 1) : trimmed).trim();
    const key = label.toLowerCase();
    if (!title || !label || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `custom:${key}`, title, label });
  }
  return out;
}

/** Ordena las issues de una columna según la lista de números guardada; las nuevas van al final conservando su orden. */
export function orderColumnIssues(list: readonly Issue[], order: readonly number[]): Issue[] {
  if (!order.length) return [...list];
  const rank = new Map<number, number>();
  order.forEach((n, i) => rank.set(n, i));
  return [...list].sort((a, b) => {
    const ra = rank.get(a.number);
    const rb = rank.get(b.number);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

/** Mueve una issue una posición arriba (`-1`) o abajo (`+1`) dentro del orden de su columna. */
export function moveInOrder(currentOrder: readonly number[], issueNumber: number, delta: -1 | 1, columnNumbers: readonly number[]): number[] {
  const ordered = [
    ...currentOrder.filter((n) => columnNumbers.includes(n)),
    ...columnNumbers.filter((n) => !currentOrder.includes(n)),
  ];
  const idx = ordered.indexOf(issueNumber);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= ordered.length) return ordered;
  const copy = [...ordered];
  [copy[idx], copy[next]] = [copy[next], copy[idx]];
  return copy;
}
