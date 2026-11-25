/** Reglas del uso en vivo (sin DOM): cada cuánto consultarlo y qué cifras de la herramienta son nuevas. */

import type { PlanUsage } from "../aiModel";

/** Cada cuánto se revisa si toca consultar y se repinta la cuenta atrás. */
export const USAGE_TICK_MS = 15_000;
/** Antigüedad máxima de las cifras mientras hay una respuesta en curso. */
export const USAGE_RUNNING_MS = 45_000;
/** Antigüedad máxima en reposo, para recoger el uso gastado fuera de Pulso. */
export const USAGE_IDLE_MS = 120_000;
/** Al volver a la ventana o abrir el panel, no se repite una consulta más reciente que esto. */
export const USAGE_RETURN_MS = 20_000;

export function usageIsDue(attemptedAt: number, maxAgeMs: number, nowMs: number): boolean {
  return nowMs - attemptedAt >= maxAgeMs;
}

/**
 * Aplica sobre `shown` solo las ventanas que acaba de traer un evento; `null` si no trajo ninguna.
 * La conversación guarda las cifras de su último turno: copiarlas enteras en cada evento pisaría
 * una consulta más reciente con datos viejos.
 */
export function usageFromEvent(shown: PlanUsage, before: PlanUsage, after: PlanUsage): PlanUsage | null {
  const fiveHour = after.fiveHour !== before.fiveHour ? after.fiveHour : undefined;
  const sevenDay = after.sevenDay !== before.sevenDay ? after.sevenDay : undefined;
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour: fiveHour ?? shown.fiveHour, sevenDay: sevenDay ?? shown.sevenDay };
}
