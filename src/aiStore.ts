import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, Turn } from "./aiModel";

/** Conversaciones guardadas en este equipo (en un archivo de los datos de la aplicación): lo justo para volver a verlas y reanudarlas con la sesión de la herramienta. */
export interface SavedChat { id: string; title: string; cwd: string; sessionId: string; model: string; provider?: AiProvider; updatedAt: number; messages: Turn[] }

export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

const KEY = "pulso.ai.chats";
export const MAX_CHATS = 30;
export const MAX_BYTES = 1_500_000;
const SAVED_RESULT = 600;

const isList = (text: string | null | undefined): text is string => {
  if (!text) return false;
  try { return Array.isArray(JSON.parse(text)); } catch { return false; }
};
const hasChats = (text: string) => (JSON.parse(text) as unknown[]).length > 0;

/** Qué historial usar al arrancar: el del archivo si tiene conversaciones; si no, el que quedó en localStorage de versiones anteriores. */
export function pickHistory(fileText: string | null, legacyText: string | null): { text: string; migrated: boolean } {
  if (isList(fileText) && hasChats(fileText)) return { text: fileText, migrated: false };
  if (isList(legacyText) && hasChats(legacyText)) return { text: legacyText, migrated: true };
  return { text: isList(fileText) ? fileText : "[]", migrated: false };
}

let cache = "[]";
let timer = 0;

async function flush(): Promise<void> {
  window.clearTimeout(timer);
  timer = 0;
  try { await invoke("ai_history_write", { text: cache }); } catch { /* sin disco: la conversación sigue en pantalla */ }
}

/** Historial en memoria respaldado por un archivo; las escrituras se agrupan para no tocar el disco en cada fragmento de respuesta. */
export const historyStore: Store = {
  getItem: () => cache,
  setItem: (_k, v) => { cache = v; if (!timer) timer = window.setTimeout(() => void flush(), 400); },
};

/** Carga el historial del archivo (y trae el de localStorage si es la primera vez). Llamar una vez al iniciar. */
export async function initHistory(): Promise<void> {
  let fileText: string | null = null;
  try { fileText = await invoke<string>("ai_history_read"); } catch { /* sin archivo todavía */ }
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(KEY); } catch { /* sin acceso */ }
  const pick = pickHistory(fileText, legacy);
  cache = pick.text;
  if (pick.migrated) {
    await flush();
    try { localStorage.removeItem(KEY); } catch { /* nada que hacer */ }
  } else if (legacy !== null) {
    try { localStorage.removeItem(KEY); } catch { /* nada que hacer */ }
  }
  window.addEventListener("blur", () => { if (timer) void flush(); });
}

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

export function loadChats(store: Store = historyStore): SavedChat[] {
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
export function saveChat(chat: SavedChat, store: Store = historyStore): void {
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

export function deleteChat(id: string, store: Store = historyStore): void {
  try { store.setItem(KEY, JSON.stringify(loadChats(store).filter((c) => c.id !== id))); } catch { /* nada que hacer */ }
}
