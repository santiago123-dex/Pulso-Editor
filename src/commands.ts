import { state } from "./settings";
import { overlayOpen } from "./ui";

export interface Command {
  id: string;
  label: string;
  /** Atajo por defecto, p. ej. "Ctrl+Shift+P". */
  key?: string;
  /** Palabras extra para la paleta (la primera pesa más), p. ej. "theme tema color". */
  keywords?: string;
  run: () => void | Promise<void>;
}

export const commands: Command[] = [];
export const register = (...c: Command[]) => { commands.push(...c); };

/** Atajo vigente de un comando (el personalizado tiene prioridad; "" = ninguno). */
export function keyOf(c: Command): string {
  const o = state.settings.keybindings;
  return c.id in o ? o[c.id] : c.key ?? "";
}

/** Convierte un evento de teclado a "Ctrl+Shift+P". Devuelve "" si solo es un modificador. */
export function eventKey(e: KeyboardEvent): string {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return "";
  let k = e.key;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === "Backquote") k = "`";
  else if (k.length === 1) k = k.toUpperCase();
  if (k === " ") k = "Space";
  if (k === "+") k = "=";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(k);
  return parts.join("+");
}

let capture: ((key: string | null) => void) | null = null;

/** Espera la siguiente combinación de teclas (para reasignar atajos). null = cancelado. */
export function captureKey(cb: (key: string | null) => void) {
  capture = cb;
}

/** True si el foco está dentro de la terminal integrada. */
export const inTerminal = () => !!(document.activeElement as HTMLElement | null)?.closest?.("#panel");

/**
 * Con el foco en la terminal, las teclas sin Shift ni Alt (Ctrl+P, Ctrl+W, Ctrl+B…) son del shell:
 * el historial, borrar palabra, etc. Solo pasan a la aplicación las combinaciones con Shift/Alt,
 * las teclas de función y el atajo para ocultar la terminal.
 */
export function allowedInTerminal(cmd: Command, key: string): boolean {
  return cmd.id === "terminal.toggle" || /(^|\+)(Shift|Alt)\+/.test(key) || /^F\d+$/.test(key);
}

export function initKeys() {
  window.addEventListener("keydown", (e) => {
    if (capture) {
      e.preventDefault();
      e.stopPropagation();
      const done = capture;
      if (e.key === "Escape") { capture = null; done(null); return; }
      if (e.key === "Backspace" || e.key === "Delete") { capture = null; done(""); return; }
      const k = eventKey(e);
      if (!k || !(/^(Ctrl|Alt)/.test(k) || /^F\d+$/.test(k))) return;
      capture = null;
      done(k);
      return;
    }
    if (overlayOpen()) return;
    const k = eventKey(e);
    if (!k) return;
    const cmd = commands.find((c) => keyOf(c) === k);
    if (!cmd) return;
    if (inTerminal() && !allowedInTerminal(cmd, k)) return;
    e.preventDefault();
    e.stopPropagation();
    void cmd.run();
  }, true);
}
