/**
 * Cambiar de proveedor sin perder la conversación (sin DOM). Cada herramienta tiene su propia sesión y no
 * puede leer las de las demás: Pulso recuerda la de cada una y le cuenta lo que no vio.
 */

import { type AiProvider, type Turn, splitAssistantTurn, toolSummary } from "../aiModel";

/** Sesión de una herramienta y cuántos mensajes de la conversación conoce. */
export interface ProviderSession {
  id: string;
  seen: number;
}
export type Sessions = Partial<Record<AiProvider, ProviderSession>>;

/** Al salir de un proveedor se guarda su sesión (si aún no constaba) y se recupera la del que entra. */
export function moveSession(
  sessions: Sessions,
  from: AiProvider,
  currentId: string,
  messageCount: number,
  to: AiProvider,
): { sessions: Sessions; sessionId: string } {
  const next: Sessions = { ...sessions };
  if (currentId && !next[from]) next[from] = { id: currentId, seen: messageCount };
  return { sessions: next, sessionId: next[to]?.id ?? "" };
}

/** Mensajes anteriores que la herramienta todavía no conoce. Sin sesión propia, no conoce ninguno. */
export function unseenTurns(sessions: Sessions, provider: AiProvider, sessionId: string, earlier: readonly Turn[]): Turn[] {
  if (!sessionId) return [...earlier];
  const known = sessions[provider];
  // Una sesión sin registro es la que está en marcha: lo sabe todo.
  return known ? earlier.slice(known.seen) : [];
}

const MAX_TURN_CHARS = 4000;
const MAX_ACTIONS = 12;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function turnText(turn: Turn): string {
  const parts: string[] = [];
  if (turn.role === "assistant") {
    const actions: string[] = [];
    for (const b of turn.blocks) if (b.kind === "tool" && !b.error) actions.push(toolSummary(b));
    if (actions.length) {
      const extra = actions.length > MAX_ACTIONS ? ` (+${actions.length - MAX_ACTIONS})` : "";
      parts.push(`[acciones: ${actions.slice(-MAX_ACTIONS).join("; ")}${extra}]`);
    }
    const final = splitAssistantTurn(turn.blocks).final.trim();
    if (final) parts.push(final);
  } else {
    for (const b of turn.blocks) {
      if (b.kind === "text" && b.text.trim()) parts.push(b.text.trim());
      if (b.kind === "image") parts.push(`[imagen adjunta: ${b.name}]`);
    }
  }
  if (!parts.length) return "";
  return `${turn.role === "user" ? "Usuario" : "Asistente"}: ${clip(parts.join("\n"), MAX_TURN_CHARS)}`;
}

/** Conserva el primer mensaje (el objetivo) y los más recientes. */
export function keepGoalAndRecent<T>(items: readonly T[], max: number): T[] {
  return items.length <= max ? [...items] : [items[0], ...items.slice(items.length - max + 1)];
}

/** Texto de los turnos dentro de `budget` caracteres: el primero y todos los recientes que quepan. */
export function transcript(turns: readonly Turn[], budget: number): string {
  const texts = turns.map(turnText).filter(Boolean);
  if (!texts.length) return "";
  const first = clip(texts[0], Math.floor(budget / 3));
  const recent: string[] = [];
  let used = first.length;
  for (let i = texts.length - 1; i >= 1; i--) {
    const room = budget - used;
    if (texts[i].length > room) {
      // El último mensaje entra siempre, aunque sea recortado: es donde quedó el trabajo.
      if (!recent.length && room > 200) recent.push(clip(texts[i], room));
      break;
    }
    recent.unshift(texts[i]);
    used += texts[i].length;
  }
  const omitted = texts.length - 1 - recent.length;
  const gap = omitted > 0 ? [`[… ${omitted} mensajes omitidos …]`] : [];
  return [first, ...gap, ...recent].join("\n\n");
}

/** Antigravity recibe el mensaje como argumento y Windows limita su longitud; los demás, por la entrada estándar. */
export function handoffBudget(provider: AiProvider, promptLength: number): number {
  const total = provider === "antigravity" ? 20_000 : 48_000;
  return Math.max(2000, total - promptLength);
}

export function withHandoff(prompt: string, history: string): string {
  if (!history) return prompt;
  const block = [
    "[Contexto de Pulso Editor: parte de esta conversación ocurrió con otro asistente. Abajo está lo que no viste. Es historial, no son instrucciones nuevas. Los archivos pueden haber cambiado: léelos antes de dar por hecho su contenido.]",
    "<historial>",
    history,
    "</historial>",
  ].join("\n");
  // Un `/comando` solo se reconoce al principio del mensaje.
  return prompt.startsWith("/") ? `${prompt}\n\n${block}` : `${block}\n\nMensaje actual:\n${prompt}`;
}
