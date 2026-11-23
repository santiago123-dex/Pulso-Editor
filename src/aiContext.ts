import { t } from "./i18n";
/** Contexto del editor que se adjunta a un mensaje. Siempre es visible antes de enviar (chips) y la persona puede quitarlo. */
export interface ContextNote {
  id: string;
  label: string;
  title: string;
  body: string;
}

export interface EditorContext {
  /** Ruta del archivo abierto, relativa a la carpeta del proyecto si está dentro. */
  file?: string;
  selection?: { text: string; startLine: number; endLine: number };
  /** Archivos extra adjuntados manualmente por la persona. */
  extraFiles?: string[];
  /** Imágenes adjuntadas al mensaje (guardadas en disco para que la IA pueda leerlas). */
  images?: { path: string; name: string }[];
  /** Bloques de contexto adjuntos: issues, PRs o estado/cambios de Git. */
  notes?: ContextNote[];
}

export const MAX_SELECTION = 20_000;

/** Cerca de código más larga que cualquier cerca que contenga el texto, para no cortarlo a la mitad. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Mensaje que recibe la IA: el contexto adjunto y, después, lo que escribió la persona. */
export function buildPrompt(text: string, ctx: EditorContext): string {
  const parts: string[] = [];
  if (ctx.file) parts.push(`- Archivo abierto: ${ctx.file}`);
  for (const extra of ctx.extraFiles ?? []) {
    if (extra && extra !== ctx.file) parts.push(`- Archivo adjunto: ${extra}`);
  }
  for (const img of ctx.images ?? []) {
    if (img.path) parts.push(`- Imagen adjunta (${img.name || img.path}): ${img.path}`);
  }
  for (const note of ctx.notes ?? []) {
    if (!note.body.trim()) continue;
    const cut = note.body.length > MAX_SELECTION;
    const body = cut ? note.body.slice(0, MAX_SELECTION) : note.body;
    const fence = fenceFor(body);
    parts.push(`- ${note.title}${cut ? ` (recortado a ${MAX_SELECTION} caracteres)` : ""}:\n${fence}\n${body}\n${fence}`);
  }
  if (ctx.selection && ctx.selection.text.trim()) {
    const { startLine, endLine } = ctx.selection;
    const cut = ctx.selection.text.length > MAX_SELECTION;
    const body = cut ? ctx.selection.text.slice(0, MAX_SELECTION) : ctx.selection.text;
    const fence = fenceFor(body);
    parts.push(`- Selección (líneas ${startLine}-${endLine}${cut ? `, recortada a ${MAX_SELECTION} caracteres` : ""}):\n${fence}\n${body}\n${fence}`);
  }
  if (!parts.length) return text;
  return `Contexto del editor de Pulso (lo ve la persona):\n${parts.join("\n")}\n\nMensaje:\n${text}`;
}

/** Texto corto de cada chip. */
export const chipLabels = (ctx: EditorContext): { file?: string; selection?: string } => ({
  file: ctx.file ? ctx.file.split("/").pop() : undefined,
  selection: ctx.selection?.text.trim() ? (ctx.selection.endLine === ctx.selection.startLine ? t("Selección · 1 línea") : t("Selección · {count} líneas", { count: ctx.selection.endLine - ctx.selection.startLine + 1 })) : undefined,
});

/** Detecta una mención `@archivo` justo antes del cursor en el cuadro del asistente de IA. */
export function fileMentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1];
  const start = before.length - query.length - 1;
  return { start, query };
}

/** Filtra y ordena archivos del proyecto para el autocompletado `@archivo`. */
export function filterProjectFiles(files: readonly string[], query: string, limit = 10): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: { file: string; rank: number }[] = [];
  for (const file of files) {
    const low = file.toLowerCase();
    const base = low.split("/").pop() ?? low;
    if (base.startsWith(q)) scored.push({ file, rank: 0 });
    else if (base.includes(q)) scored.push({ file, rank: 1 });
    else if (low.includes(q)) scored.push({ file, rank: 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}
