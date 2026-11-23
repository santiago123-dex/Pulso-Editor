import { t } from "./i18n";
/** Lógica pura para ejecutar los scripts de package.json desde la terminal. */
export interface ScriptItem { name: string; command: string }
export type Manager = "npm" | "pnpm" | "yarn" | "bun";

/** Solo nombres seguros: se escriben tal cual en la terminal, así que no se admite nada que un shell interprete. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.\-/@]*$/;

/** Scripts de un package.json (texto). Devuelve [] si no es JSON válido o no tiene scripts. Omite nombres no seguros. */
export function parseScripts(text: string): ScriptItem[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  const scripts = (data as { scripts?: unknown } | null)?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const out: ScriptItem[] = [];
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command === "string" && SAFE_NAME.test(name)) out.push({ name, command });
  }
  return out;
}

/** Gestor de paquetes según el archivo de bloqueo presente; npm si no hay ninguno. */
export function detectManager(files: readonly string[]): Manager {
  const has = (n: string) => files.includes(n);
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  return "npm";
}

/** Línea que se escribe en la terminal. Lanza si el nombre no es seguro. */
export function scriptCommand(manager: Manager, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(t("Nombre de script no válido: {name}", { name }));
  return `${manager} run ${name}`;
}
