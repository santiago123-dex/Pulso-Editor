import type * as monaco from "monaco-editor";

/** A partir de este tamaño (caracteres) se desactivan funciones del editor que recorren todo el documento. */
export const LARGE_FILE_CHARS = 1_000_000;

export const NORMAL_BACKUP_DELAY_MS = 1_000;
export const LARGE_BACKUP_DELAY_MS = 8_000;

export const isLargeFile = (chars: number) => chars >= LARGE_FILE_CHARS;

/** En archivos grandes espaciamos las copias de recuperación para evitar picos al escribir. */
export const backupDelayFor = (chars: number) => (isLargeFile(chars) ? LARGE_BACKUP_DELAY_MS : NORMAL_BACKUP_DELAY_MS);

/**
 * Opciones de Monaco para el modo de archivo grande. La búsqueda de corchetes que encierran el cursor y los
 * resaltados de coincidencias recorren el documento entero en cada movimiento y provocan picos al escribir
 * (medido: ~30 % del tiempo de CPU al teclear en un archivo de 5 MB).
 */
export function largeFileOptions(large: boolean): monaco.editor.IEditorOptions {
  return large
    ? {
        matchBrackets: "never",
        occurrencesHighlight: "off",
        selectionHighlight: false,
        bracketPairColorization: { enabled: false },
        guides: { bracketPairs: false, highlightActiveBracketPair: false },
        folding: false,
        links: false,
      }
    : {
        matchBrackets: "always",
        occurrencesHighlight: "singleFile",
        selectionHighlight: true,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: false, highlightActiveBracketPair: true },
        folding: true,
        links: true,
      };
}
