import { readJsonStorage, readStorage, removeStorage, writeJsonStorage, writeStorage } from "./core/storage";

/** Carpeta abierta, carpetas recientes y persistencia de la sesión. */
export const ws = { root: null as string | null };

/** Ruta relativa a la carpeta abierta. */
export const rel = (p: string) => (ws.root && p.startsWith(ws.root + "/") ? p.slice(ws.root.length + 1) : p);

const RECENT = "pulso.recent";
const SESSION = "pulso.session";
const PROJECT_LAYOUTS = "pulso.projectLayouts";
const MAX_PROJECT_LAYOUTS = 20;

const layoutKey = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

interface ProjectLayoutEntry {
  layout: unknown;
  at: number;
}

function readProjectLayouts(): Record<string, ProjectLayoutEntry> {
  const raw = readJsonStorage<unknown>(PROJECT_LAYOUTS, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, ProjectLayoutEntry>) : {};
}

/** Guarda la disposición de pestañas asociada a una carpeta concreta (conserva los últimos 20 proyectos). */
export function saveProjectLayout(root: string, layout: unknown) {
  if (!root) return;
  const key = layoutKey(root);
  const map = readProjectLayouts();
  map[key] = { layout, at: Date.now() };
  const entries = Object.entries(map)
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    .slice(0, MAX_PROJECT_LAYOUTS);
  writeJsonStorage(PROJECT_LAYOUTS, Object.fromEntries(entries));
}

/** Recupera la última disposición de pestañas guardada para una carpeta, o null si no hay ninguna. */
export function loadProjectLayout(root: string): unknown | null {
  if (!root) return null;
  const entry = readProjectLayouts()[layoutKey(root)];
  return entry ? (entry.layout ?? null) : null;
}

export function getRecent(): string[] {
  const raw = readJsonStorage<unknown>(RECENT, []);
  return Array.isArray(raw) ? (raw as string[]) : [];
}

export function addRecent(path: string) {
  const list = [path, ...getRecent().filter((p) => p !== path)].slice(0, 10);
  writeJsonStorage(RECENT, list);
}

export function removeRecent(path: string) {
  writeJsonStorage(
    RECENT,
    getRecent().filter((p) => p !== path),
  );
}

export const saveSession = (data: unknown) => {
  writeJsonStorage(SESSION, data);
};
export const clearSession = () => removeStorage(SESSION);

export function loadSession(): { root: string | null; layout: unknown } | null {
  return readJsonStorage<{ root: string | null; layout: unknown } | null>(SESSION, null);
}

const LAST = "pulso.lastRoot";
export const getLastRoot = (): string | null => readStorage(LAST);
export const setLastRoot = (p: string) => {
  writeStorage(LAST, p);
};
export const clearLastRoot = () => removeStorage(LAST);

/**
 * Guardado de la sesión con retraso (para no escribir en cada tecla) y protegido: no escribe nada
 * hasta que se haya leído y restaurado la sesión anterior. Si guardara antes, el estado vacío de un
 * arranque lento pisaría la carpeta y las pestañas del usuario.
 */
export function createSessionPersister(save: () => void, delay = 500) {
  let ready = false;
  let timer = 0;
  return {
    schedule() {
      if (!ready) return;
      clearTimeout(timer);
      timer = window.setTimeout(save, delay);
    },
    /** Guarda ya (al cerrar la ventana). */
    flush() {
      clearTimeout(timer);
      if (ready) save();
    },
    /** A partir de aquí se puede guardar. */
    markReady() {
      ready = true;
      this.schedule();
    },
    isReady: () => ready,
  };
}
