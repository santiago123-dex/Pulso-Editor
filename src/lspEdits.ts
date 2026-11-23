import { t } from "./i18n";
/** Edición de texto según el protocolo LSP, sin Monaco: posiciones línea/carácter en unidades UTF-16. */
export interface LspPosition { line: number; character: number }
export interface LspEdit { range: { start: LspPosition; end: LspPosition }; newText: string }

/** Desplazamiento de cada línea (soporta \n, \r\n y \r). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) i++; starts.push(i + 1); }
    else if (c === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetOf(starts: number[], text: string, p: LspPosition): number {
  if (p.line < 0 || p.line >= starts.length) throw new Error(t("Posición fuera del archivo (línea {line})", { line: p.line + 1 }));
  // LSP permite un carácter más allá del final de la línea: se recorta al final de la línea.
  let lineEnd = p.line + 1 < starts.length ? starts[p.line + 1] : text.length;
  while (lineEnd > starts[p.line] && (text.charCodeAt(lineEnd - 1) === 10 || text.charCodeAt(lineEnd - 1) === 13)) lineEnd--;
  return Math.min(starts[p.line] + Math.max(0, p.character), lineEnd);
}

/** Aplica las ediciones al texto. Lanza si se solapan o se salen del archivo, para no escribir algo incoherente. */
export function applyTextEdits(text: string, edits: readonly LspEdit[]): string {
  const starts = lineStarts(text);
  const spans = edits.map((e, order) => ({ s: offsetOf(starts, text, e.range.start), e: offsetOf(starts, text, e.range.end), text: e.newText, order }));
  for (const sp of spans) if (sp.e < sp.s) throw new Error(t("Edición con el final antes del principio"));
  spans.sort((a, b) => a.s - b.s || a.e - b.e || a.order - b.order);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].s < spans[i - 1].e) throw new Error(t("Ediciones solapadas"));
  }
  let out = "";
  let at = 0;
  for (const sp of spans) { out += text.slice(at, sp.s) + sp.text; at = sp.e; }
  return out + text.slice(at);
}

export interface WorkspaceEditLike {
  changes?: Record<string, LspEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri: string }; edits?: LspEdit[]; kind?: string }>;
}

/** Agrupa las ediciones por archivo. Lanza si el servidor pide crear, renombrar o borrar archivos (aún no se admite). */
export function collectEdits(edit: WorkspaceEditLike | null | undefined): Map<string, LspEdit[]> {
  const out = new Map<string, LspEdit[]>();
  const add = (uri: string, edits: LspEdit[]) => out.set(uri, [...(out.get(uri) ?? []), ...edits]);
  if (!edit) return out;
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const c of edit.documentChanges ?? []) {
    if (c.kind || !c.textDocument) throw new Error(t("El servidor pidió crear, renombrar o borrar archivos, que Pulso aún no admite"));
    add(c.textDocument.uri, c.edits ?? []);
  }
  return out;
}
