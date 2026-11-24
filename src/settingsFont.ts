/**
 * Tipo de letra de fábrica del editor: la misma que usa VS Code en Windows (Consolas, con Courier New de reserva), que es la que se ve
 * más nítida a tamaño 14 y la que ya conoce quien viene de VS Code.
 */
export const CONSOLAS_STACK = 'Consolas, "Courier New", monospace';

/** La letra de fábrica anterior (Cascadia Code primero). */
export const OLD_DEFAULT_FONT = '"Cascadia Code", "JetBrains Mono", Consolas, monospace';

/**
 * Quien nunca cambió la letra (su ajuste guardado es exactamente la de fábrica anterior) pasa a la nueva. Quien eligió una a propósito en
 * Configuración (incluida «Cascadia Code», que se guarda con otra cadena) la conserva.
 */
export function dropOldFontDefault(saved: Record<string, unknown>): void {
  if (saved.fontFamily === OLD_DEFAULT_FONT) delete saved.fontFamily;
}
