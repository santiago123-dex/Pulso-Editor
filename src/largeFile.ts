import type * as monaco from "monaco-editor";

/** A partir de este tamaño (caracteres) se desactivan funciones del editor que recorren todo el documento. */
export const LARGE_FILE_CHARS = 1_000_000;

export const isLargeFile = (chars: number) => chars >= LARGE_FILE_CHARS;

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
      }
    : {
        matchBrackets: "always",
        occurrencesHighlight: "singleFile",
        selectionHighlight: true,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: false, highlightActiveBracketPair: true },
      };
}
