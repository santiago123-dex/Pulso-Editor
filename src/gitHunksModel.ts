/** Lógica pura para fragmentos de diff y detección/resolución de conflictos de Git. */

export interface DiffHunk {
  index: number;
  header: string;
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  added: number;
  removed: number;
  patch: string;
}

export interface ConflictBlock {
  /** Línea 1-based de `<<<<<<<` */
  startLine: number;
  /** Línea 1-based de `=======` */
  sepLine: number;
  /** Línea 1-based de `>>>>>>>` */
  endLine: number;
  currentLabel: string;
  incomingLabel: string;
  currentText: string;
  incomingText: string;
}

export type ConflictChoice = "current" | "incoming" | "both";

/** Detecta bloques de conflicto estándar de Git (`<<<<<<<`, `=======`, `>>>>>>>`) en un texto. */
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/);
  const out: ConflictBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const startIdx = i;
    const currentLabel = lines[i].slice(7).trim() || "HEAD";
    let sepIdx = -1;
    let endIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("<<<<<<<")) break;
      if (sepIdx < 0 && lines[j].startsWith("=======")) {
        sepIdx = j;
      } else if (sepIdx >= 0 && lines[j].startsWith(">>>>>>>")) {
        endIdx = j;
        break;
      }
    }
    if (sepIdx >= 0 && endIdx > sepIdx) {
      out.push({
        startLine: startIdx + 1,
        sepLine: sepIdx + 1,
        endLine: endIdx + 1,
        currentLabel,
        incomingLabel: lines[endIdx].slice(7).trim() || "entrante",
        currentText: lines.slice(startIdx + 1, sepIdx).join("\n"),
        incomingText: lines.slice(sepIdx + 1, endIdx).join("\n"),
      });
      i = endIdx + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Devuelve el texto de reemplazo para un bloque de conflicto según la elección del usuario. */
export function resolveConflictText(block: ConflictBlock, choice: ConflictChoice): string {
  if (choice === "current") return block.currentText;
  if (choice === "incoming") return block.incomingText;
  if (!block.currentText) return block.incomingText;
  if (!block.incomingText) return block.currentText;
  return `${block.currentText}\n${block.incomingText}`;
}
