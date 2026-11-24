import { t } from "./i18n";
/** Lógica de atajos de teclado (sin interfaz): conflictos, teclas reservadas y personalizaciones. */
export interface KbCommand {
  id: string;
  label: string;
  key?: string;
}

/** Teclas que el editor (Monaco) o el sistema ya usan; asignarlas a un comando las rompe dentro del editor. */
export const RESERVED: Record<string, string> = {
  "Ctrl+C": t("copiar"),
  "Ctrl+X": t("cortar"),
  "Ctrl+V": t("pegar"),
  "Ctrl+Z": t("deshacer"),
  "Ctrl+Y": t("rehacer"),
  "Ctrl+A": t("seleccionar todo"),
  "Ctrl+F": t("buscar en el archivo"),
  "Ctrl+H": t("reemplazar en el archivo"),
  "Ctrl+G": t("ir a la línea"),
  "Ctrl+D": t("seleccionar la siguiente aparición"),
  "Ctrl+/": t("comentar la línea"),
  "Ctrl+Shift+O": t("ir a un símbolo"),
  F12: t("ir a la definición"),
  "Alt+F4": t("cerrar la ventana"),
};

/** Atajo vigente de un comando, dadas las personalizaciones. "" = sin atajo. */
export function effectiveKey(cmd: KbCommand, overrides: Record<string, string>): string {
  return cmd.id in overrides ? overrides[cmd.id] : (cmd.key ?? "");
}

/** Otros comandos que ya usan esa combinación. */
export function findConflicts(commands: KbCommand[], overrides: Record<string, string>, id: string, key: string): KbCommand[] {
  if (!key) return [];
  return commands.filter((c) => c.id !== id && effectiveKey(c, overrides) === key);
}

/** Descripción de lo que ya hace esa tecla en el editor, si es una de las reservadas. */
export const reservedFor = (key: string): string | undefined => RESERVED[key];

/**
 * Devuelve las personalizaciones tras asignar `key` a `id`, quitando esa tecla a quien la tuviera.
 * Si la tecla coincide con la de fábrica del comando, la personalización desaparece (vuelve al valor por defecto).
 */
export function assignKey(commands: KbCommand[], overrides: Record<string, string>, id: string, key: string): Record<string, string> {
  const next = { ...overrides };
  for (const c of findConflicts(commands, next, id, key)) next[c.id] = "";
  const cmd = commands.find((c) => c.id === id);
  if (cmd && (cmd.key ?? "") === key) delete next[id];
  else next[id] = key;
  // Quien perdió la tecla y por fábrica no tenía ninguna ya no necesita personalización.
  for (const c of commands) if (next[c.id] === "" && !(c.key ?? "")) delete next[c.id];
  return next;
}

/** Vuelve un comando a su atajo de fábrica. */
export function resetKey(overrides: Record<string, string>, id: string): Record<string, string> {
  const next = { ...overrides };
  delete next[id];
  return next;
}

export const isCustom = (overrides: Record<string, string>, id: string) => id in overrides;

/** "Archivo: Guardar" -> categoría "Archivo", nombre "Guardar". Sin prefijo cae en "General". */
export function splitLabel(label: string): { category: string; name: string } {
  const i = label.indexOf(": ");
  return i > 0 && i < 20 ? { category: label.slice(0, i), name: label.slice(i + 2) } : { category: t("General"), name: label };
}

const DISPLAY: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Space: t("Espacio"),
  Tab: "Tab",
  Enter: t("Intro"),
  Backspace: "⌫",
  Delete: t("Supr"),
};

/** "Ctrl+Alt+ArrowRight" -> ["Ctrl", "Alt", "→"] para dibujar cada tecla por separado. */
export function keyParts(key: string): string[] {
  if (!key) return [];
  // El último "+" puede ser la propia tecla ("Ctrl++" no existe, pero "Ctrl+=" sí).
  return key
    .split("+")
    .filter((p) => p !== "")
    .map((p) => DISPLAY[p] ?? p);
}

/** Texto para buscar: quita símbolos para que "ctrl p" y "Ctrl+P" coincidan. */
export const searchable = (s: string) =>
  s
    .toLowerCase()
    .replace(/[+\s]+/g, " ")
    .trim();

/**
 * Cada palabra de la búsqueda debe aparecer en el nombre del comando, ser el comienzo de una de sus
 * teclas ("ctr" encuentra Ctrl, pero una "s" suelta no encuentra cualquier cosa), o, si lleva un
 * punto, estar en su identificador (file.save).
 */
export function matches(cmd: KbCommand, overrides: Record<string, string>, query: string): boolean {
  const q = searchable(query);
  if (!q) return true;
  const label = searchable(cmd.label);
  const keys = searchable(effectiveKey(cmd, overrides)).split(" ").filter(Boolean);
  const id = cmd.id.toLowerCase();
  return q.split(" ").every((w) => label.includes(w) || keys.some((k) => k.startsWith(w)) || (w.includes(".") && id.includes(w)));
}

/** Agrupa por categoría conservando el orden en que aparecen. */
export function groupByCategory<T extends KbCommand>(list: T[]): { category: string; items: T[] }[] {
  const groups: { category: string; items: T[] }[] = [];
  for (const c of list) {
    const { category } = splitLabel(c.label);
    let g = groups.find((x) => x.category === category);
    if (!g) groups.push((g = { category, items: [] }));
    g.items.push(c);
  }
  return groups;
}

/** Hay dos comandos con la misma tecla (no debería pasar; sirve para avisar). */
export function duplicatedKeys(commands: KbCommand[], overrides: Record<string, string>): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const c of commands) {
    const k = effectiveKey(c, overrides);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), c.id]);
  }
  for (const [k, ids] of Array.from(byKey)) if (ids.length < 2) byKey.delete(k);
  return byKey;
}
