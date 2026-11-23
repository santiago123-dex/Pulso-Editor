/** Lógica pura para preparar contexto y filtrar disparos del autocompletado de IA en línea. */

export interface InlineContext {
  prefix: string;
  suffix: string;
}

const MAX_PREFIX = 3000;
const MAX_SUFFIX = 1000;

/** Extrae texto antes y después del cursor (línea/columna 1-based) dentro de límites seguros. */
export function extractInlineContext(text: string, line: number, col: number): InlineContext {
  const lines = text.split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
  const curLine = lines[idx] ?? "";
  const safeCol = Math.max(0, Math.min(curLine.length, col - 1));

  const beforeLines = lines.slice(0, idx);
  beforeLines.push(curLine.slice(0, safeCol));
  const rawPrefix = beforeLines.join("\n");

  const afterLines = [curLine.slice(safeCol), ...lines.slice(idx + 1)];
  const rawSuffix = afterLines.join("\n");

  const prefix = rawPrefix.length > MAX_PREFIX ? rawPrefix.slice(rawPrefix.length - MAX_PREFIX) : rawPrefix;
  const suffix = rawSuffix.length > MAX_SUFFIX ? rawSuffix.slice(0, MAX_SUFFIX) : rawSuffix;
  return { prefix, suffix };
}

/** Evita peticiones innecesarias cuando la línea actual está vacía o el prefijo es demasiado corto. */
export function shouldTriggerInline(prefix: string): boolean {
  if (prefix.trim().length < 4) return false;
  const lastLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  return lastLine.trim().length >= 2;
}
