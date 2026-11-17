/** Historial de navegación (atrás/adelante) entre archivos y posiciones del editor. */
export interface Loc { path: string; line: number }

export interface NavOptions {
  /** Máximo de posiciones recordadas. */
  limit?: number;
  /** Líneas que hay que moverse en un mismo archivo para contar como un salto nuevo. */
  jump?: number;
}

export function createNav(open: (loc: Loc) => Promise<void>, opts: NavOptions = {}) {
  const limit = opts.limit ?? 100;
  const jump = opts.jump ?? 8;
  let stack: Loc[] = [];
  let idx = -1;
  let busy = false;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());

  /** Abre la posición actual del historial sin que esa apertura se registre como navegación nueva. */
  async function go() {
    busy = true;
    try {
      await open(stack[idx]);
    } finally {
      // Los eventos del editor que provoca la propia apertura llegan un instante después.
      setTimeout(() => { busy = false; }, 80);
    }
    emit();
  }

  return {
    /** Anota dónde está el usuario. Moverse poco dentro de un archivo solo actualiza la posición. */
    record(loc: Loc) {
      if (busy) return;
      const cur = stack[idx];
      if (cur && cur.path === loc.path && Math.abs(cur.line - loc.line) < jump) {
        cur.line = loc.line;
        return;
      }
      stack = stack.slice(0, idx + 1);
      stack.push({ ...loc });
      if (stack.length > limit) stack.shift();
      idx = stack.length - 1;
      emit();
    },
    canBack: () => idx > 0,
    canForward: () => idx >= 0 && idx < stack.length - 1,
    async back(): Promise<boolean> {
      if (idx <= 0) return false;
      idx--;
      await go();
      return true;
    },
    async forward(): Promise<boolean> {
      if (idx < 0 || idx >= stack.length - 1) return false;
      idx++;
      await go();
      return true;
    },
    /** Olvida las posiciones de un archivo (se eliminó o se movió). */
    forget(path: string) {
      const current = stack[idx];
      stack = stack.filter((l) => l.path !== path);
      idx = current && current.path !== path ? stack.indexOf(current) : Math.min(idx, stack.length - 1);
      emit();
    },
    onChange(f: () => void) { subs.add(f); },
    /** Para pruebas y depuración. */
    snapshot: () => ({ stack: stack.map((l) => ({ ...l })), idx }),
  };
}

export type Nav = ReturnType<typeof createNav>;
