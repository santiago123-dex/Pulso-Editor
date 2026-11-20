import { eventKey } from "./commands";

export type TerminalKeyAction = "copy" | "copy-keep" | "interrupt" | "paste" | null;

/**
 * Determina qué acción debe ejecutarse ante un atajo dentro de la terminal integrada.
 * `Ctrl+C` sin selección real (o con `CapsLock`/`KeyC`) envía siempre SIGINT (`\x03`),
 * mientras que `Ctrl+C` con selección copia y limpia la selección para permitir salir con el siguiente `Ctrl+C`.
 */
export function terminalKeyAction(e: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, hasSelection: boolean): TerminalKeyAction {
  if (e.type !== "keydown") return null;
  const k = eventKey(e as KeyboardEvent);
  if (k === "Ctrl+Shift+C") return "copy-keep";
  if (k === "Ctrl+Shift+V") return "paste";
  const ctrlOnly = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  const isInterruptKey =
    k === "Ctrl+C" ||
    (ctrlOnly && (e.code === "KeyC" || e.key.toLowerCase() === "c" || e.code === "Pause" || e.key === "Cancel"));
  if (isInterruptKey) {
    if (hasSelection && (k === "Ctrl+C" || e.code === "KeyC" || e.key.toLowerCase() === "c")) return "copy";
    return "interrupt";
  }
  return null;
}
