import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { readStorage, removeStorage, writeStorage } from "./core/storage";
import type { AiProvider, Turn } from "./aiModel";

/** Conversaciones guardadas en este equipo (en un archivo de los datos de la aplicación): lo justo para volver a verlas y reanudarlas con la sesión de la herramienta. */
export interface SavedChat { id: string; title: string; cwd: string; sessionId: string; model: string; provider?: AiProvider; updatedAt: number; messages: Turn[] }

export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

const KEY = "pulso.ai.chats";
const EMERGENCY_KEY = "pulso.ai.emergency";
export const MAX_CHATS = 30;
export const MAX_BYTES = 1_500_000;
const SAVED_RESULT = 600;
const SAVED_IMAGE_PREVIEW = 40_000;

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

/** Combina historiales conservando la versión más reciente de cada conversación y respetando el límite máximo. */
export function mergeChats(base: readonly SavedChat[], extra: readonly SavedChat[]): SavedChat[] {
  const byId = new Map<string, SavedChat>();
  for (const c of [...base, ...extra]) {
    const prev = byId.get(c.id);
    if (!prev || c.updatedAt >= prev.updatedAt) byId.set(c.id, c);
  }
  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
}

async function flush(): Promise<void> {
  window.clearTimeout(timer);
  timer = 0;
  try { await invoke("ai_history_write", { text: cache }); } catch { /* sin disco: la conversación sigue en pantalla */ }
}

/** Guarda de inmediato en disco y en copia de respaldo síncrona (útil al cerrar mientras ejecuta). */
export function flushHistoryNow(): void {
  writeStorage(EMERGENCY_KEY, cache);
  void flush();
}

/** Historial en memoria respaldado por un archivo; las escrituras se agrupan para no tocar el disco en cada fragmento de respuesta. */
export const historyStore: Store = {
  getItem: () => cache,
  setItem: (_k, v) => { cache = v; if (!timer) timer = window.setTimeout(() => void flush(), 400); },
};

/** Carga el historial del archivo (y recupera si quedó una copia de emergencia al cerrar en plena ejecución). */
export async function initHistory(): Promise<void> {
  let fileText: string | null = null;
  try { fileText = await invoke<string>("ai_history_read"); } catch { /* sin archivo todavía */ }
  const legacy = readStorage(KEY);
  const emergency = readStorage(EMERGENCY_KEY);
  const pick = pickHistory(fileText, legacy);
  cache = pick.text;
  let dirty = pick.migrated;
  if (isList(emergency) && hasChats(emergency)) {
    const merged = mergeChats(loadChats({ getItem: () => cache, setItem: () => {} }), JSON.parse(emergency) as SavedChat[]);
    cache = JSON.stringify(merged);
    dirty = true;
  }
  if (dirty) await flush();
  if (legacy !== null) removeStorage(KEY);
  if (emergency !== null) removeStorage(EMERGENCY_KEY);
  window.addEventListener("blur", () => { if (timer) void flush(); });
  window.addEventListener("pagehide", flushHistoryNow);
  window.addEventListener("beforeunload", flushHistoryNow);
}

/** Identificador seguro para pasarlo a la herramienta y usarlo como clave. */
export const newChatId = (now = Date.now(), rnd = Math.random()) => `c${now.toString(36)}${Math.floor(rnd * 1e6).toString(36)}`;

/** Título: el primer mensaje de la persona, recortado. */
export function titleFrom(messages: readonly Turn[]): string {
  const first = messages.find((m) => m.role === "user")?.blocks.find((b) => b.kind === "text");
  const text = first && first.kind === "text" ? first.text.replace(/\s+/g, " ").trim() : "";
  return text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : t("Conversación nueva");
}

export const sameDir = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

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
      blocks: m.blocks.map((b) => {
        if (b.kind === "tool") return { ...b, json: "", result: b.result && b.result.length > SAVED_RESULT ? `${b.result.slice(0, SAVED_RESULT)}…` : b.result };
        if (b.kind === "image" && b.preview && b.preview.length > SAVED_IMAGE_PREVIEW) return { kind: "image", path: b.path, name: b.name };
        return b;
      }),
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
