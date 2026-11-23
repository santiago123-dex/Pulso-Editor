import { t } from "./i18n";
/** Contexto del editor que se adjunta a un mensaje. Siempre es visible antes de enviar (chips) y la persona puede quitarlo. */
export interface EditorContext {
  /** Ruta del archivo abierto, relativa a la carpeta del proyecto si está dentro. */
  file?: string;
  selection?: { text: string; startLine: number; endLine: number };
  /** Archivos extra adjuntados manualmente por la persona. */
  extraFiles?: string[];
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
