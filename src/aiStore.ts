import type { Turn } from "./aiModel";

/** Conversaciones guardadas en este equipo (localStorage): lo justo para volver a verlas y reanudarlas con la sesión de la herramienta. */
export interface SavedChat { id: string; title: string; cwd: string; sessionId: string; model: string; updatedAt: number; messages: Turn[] }

export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

const KEY = "pulso.ai.chats";
export const MAX_CHATS = 30;
export const MAX_BYTES = 1_500_000;
const SAVED_RESULT = 600;

/** Identificador seguro para pasarlo a la herramienta y usarlo como clave. */
export const newChatId = (now = Date.now(), rnd = Math.random()) => `c${now.toString(36)}${Math.floor(rnd * 1e6).toString(36)}`;

/** Título: el primer mensaje de la persona, recortado. */
export function titleFrom(messages: readonly Turn[]): string {
  const first = messages.find((m) => m.role === "user")?.blocks.find((b) => b.kind === "text");
  const text = first && first.kind === "text" ? first.text.replace(/\s+/g, " ").trim() : "";
  return text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : "Conversación nueva";
}

const sameDir = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export const chatsFor = (chats: readonly SavedChat[], cwd: string): SavedChat[] => chats.filter((c) => sameDir(c.cwd, cwd));

export function loadChats(store: Store = localStorage): SavedChat[] {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is SavedChat => !!c && typeof c.id === "string" && typeof c.cwd === "string" && Array.isArray(c.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function compact(chat: SavedChat): SavedChat {
  return {
    ...chat,
    messages: chat.messages.map((m) => ({
      ...m,
      done: true,
      blocks: m.blocks.map((b) => (b.kind === "tool" ? { ...b, json: "", result: b.result && b.result.length > SAVED_RESULT ? `${b.result.slice(0, SAVED_RESULT)}…` : b.result } : b)),
    })),
  };
}

/** Guarda o actualiza una conversación. Si no cabe, se descartan las más antiguas; nunca se pierde la que se está guardando. */
export function saveChat(chat: SavedChat, store: Store = localStorage): void {
  const all = [compact(chat), ...loadChats(store).filter((c) => c.id !== chat.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
  let text = JSON.stringify(all);
  while (text.length > MAX_BYTES && all.length > 1) {
    // La más antigua que no sea la actual.
    const drop = all.map((c, i) => ({ c, i })).filter((x) => x.c.id !== chat.id).pop();
    if (!drop) break;
    all.splice(drop.i, 1);
    text = JSON.stringify(all);
  }
  try { store.setItem(KEY, text); } catch { /* sin espacio: la conversación sigue en pantalla */ }
}

export function deleteChat(id: string, store: Store = localStorage): void {
  try { store.setItem(KEY, JSON.stringify(loadChats(store).filter((c) => c.id !== id))); } catch { /* nada que hacer */ }
}
