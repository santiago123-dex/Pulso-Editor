import { t } from "./i18n";
/**
 * Reemplazo en texto en memoria con las mismas reglas que el backend Rust:
 * línea a línea, conservando finales CRLF/LF y sin interpretar `$` cuando no se usan expresiones regulares.
 */
export interface ReplaceOptions {
  query: string;
  replacement: string;
  caseSensitive: boolean;
  useRegex: boolean;
  wholeWord: boolean;
}

export interface LineEdit {
  lineNumber: number;
  endColumn: number;
  text: string;
}

export interface ReplaceResult {
  count: number;
  edits: LineEdit[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLineRegex(o: ReplaceOptions): RegExp {
  if (!o.query) throw new Error(t("La búsqueda está vacía"));
  let pat = o.useRegex ? o.query : escapeRegExp(o.query);
  if (o.wholeWord) pat = `\\b(?:${pat})\\b`;
  return new RegExp(pat, o.caseSensitive ? "g" : "gi");
}

/** Calcula las líneas modificadas y el número total de reemplazos sin alterar finales de línea. */
export function computeLineReplacements(source: string, o: ReplaceOptions): ReplaceResult {
  const re = buildLineRegex(o);
  const lines = source.split("\n");
  const edits: LineEdit[] = [];
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hasCr = raw.endsWith("\r");
    const body = hasCr ? raw.slice(0, -1) : raw;
    re.lastIndex = 0;
    let out = "";
    let last = 0;
    let lineCount = 0;

    for (let m = re.exec(body); m; m = re.exec(body)) {
      if (m[0].length === 0) {
        if (re.lastIndex >= body.length) break;
        re.lastIndex++;
        continue;
      }
      lineCount++;
      out += body.slice(last, m.index);
      out += o.useRegex ? m[0].replace(new RegExp(re.source, o.caseSensitive ? "" : "i"), o.replacement) : o.replacement;
      last = m.index + m[0].length;
    }

    if (lineCount > 0) {
      out += body.slice(last);
      count += lineCount;
      edits.push({ lineNumber: i + 1, endColumn: body.length + 1, text: out });
    }
  }

  return { count, edits };
}
