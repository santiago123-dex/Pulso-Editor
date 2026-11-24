/**
 * Lógica pura del orden y visibilidad de los botones de la barra de actividad izquierda.
 */
export interface ActivityConfig {
  order: string[];
  hidden: string[];
}

export interface ActivityStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "pulso.activityBar";

/** Normaliza el orden guardado respecto a los botones disponibles actualmente y asegura al menos uno visible. */
export function normalizeActivity(saved: Partial<ActivityConfig> | null | undefined, defaults: readonly string[]): ActivityConfig {
  const valid = new Set(defaults);
  const seen = new Set<string>();
  const order: string[] = [];

  for (const id of saved?.order ?? []) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of defaults) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  const hiddenSet = new Set<string>();
  for (const id of saved?.hidden ?? []) {
    if (valid.has(id)) hiddenSet.add(id);
  }
  // Nunca ocultar todos los botones: al menos una vista debe quedar accesible.
  if (order.length > 0 && order.every((id) => hiddenSet.has(id))) {
    hiddenSet.delete(order[0]);
  }

  return { order, hidden: order.filter((id) => hiddenSet.has(id)) };
}

/** Mueve `id` a la posición `toIndex` dentro de `order`. */
export function moveActivity(order: readonly string[], id: string, toIndex: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const clamped = Math.max(0, Math.min(order.length - 1, toIndex));
  if (from === clamped) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(clamped, 0, id);
  return next;
}

/** Desplaza `id` un lugar arriba (-1) o abajo (+1) entre los elementos visibles. */
export function stepVisibleActivity(cfg: ActivityConfig, id: string, delta: -1 | 1): string[] {
  const hidden = new Set(cfg.hidden);
  const visible = cfg.order.filter((x) => !hidden.has(x));
  const vi = visible.indexOf(id);
  if (vi < 0) return [...cfg.order];
  const targetVi = vi + delta;
  if (targetVi < 0 || targetVi >= visible.length) return [...cfg.order];
  const neighbor = visible[targetVi];
  const targetIdx = cfg.order.indexOf(neighbor);
  return moveActivity(cfg.order, id, targetIdx);
}

/** Alterna la visibilidad de `id`, evitando ocultar el último botón visible. */
export function toggleActivityVisible(cfg: ActivityConfig, id: string): ActivityConfig {
  const hidden = new Set(cfg.hidden);
  if (hidden.has(id)) {
    hidden.delete(id);
  } else {
    const visibleCount = cfg.order.filter((x) => !hidden.has(x)).length;
    if (visibleCount <= 1) return { order: [...cfg.order], hidden: [...cfg.hidden] };
    hidden.add(id);
  }
  return { order: [...cfg.order], hidden: cfg.order.filter((x) => hidden.has(x)) };
}

export function firstVisibleActivity(cfg: ActivityConfig): string | null {
  const hidden = new Set(cfg.hidden);
  return cfg.order.find((id) => !hidden.has(id)) ?? null;
}

export function loadActivity(defaults: readonly string[], store: ActivityStore = localStorage): ActivityConfig {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? "null") as Partial<ActivityConfig> | null;
    return normalizeActivity(raw, defaults);
  } catch {
    return normalizeActivity(null, defaults);
  }
}

export function saveActivity(cfg: ActivityConfig, store: ActivityStore = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* sin espacio */
  }
}
