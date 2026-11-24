/** Crear, guardar y recuperar las conversaciones del panel. */

import { type AiProvider, createProviderNormalizer, emptyConversation } from "../aiModel";
import { type SavedChat, flushHistoryNow, newChatId, saveChat, titleFrom } from "../aiStore";
import { removeStorage, writeJsonStorage } from "../core/storage";
import { t as tr } from "../i18n";
import { ws } from "../workspace";
import { type Live, S, lives } from "./chatState";

// ---------- Conversaciones ----------
export function fromSaved(c: SavedChat): Live {
  const rawProv = c.provider as string | undefined;
  const prov: AiProvider =
    rawProv === "codex"
      ? "codex"
      : rawProv === "antigravity" || rawProv === "gemini"
        ? "antigravity"
        : rawProv === "local"
          ? "local"
          : rawProv === "cloud"
            ? "cloud"
            : "claude";
  return {
    id: c.id,
    provider: prov,
    normalize: createProviderNormalizer(prov, c.model || ""),
    cwd: c.cwd,
    title: c.title,
    convo: {
      ...emptyConversation(),
      messages: c.messages,
      sessionId: c.sessionId,
      model: c.model,
      usage: prov === "claude" ? S.usage : {},
    },
  };
}

export function newLive(): Live {
  const live: Live = {
    id: newChatId(),
    provider: S.activeProvider,
    normalize: createProviderNormalizer(S.activeProvider, S.model),
    convo: { ...emptyConversation(), usage: S.activeProvider === "claude" ? S.usage : {} },
    cwd: ws.root ?? "",
    title: tr("Conversación nueva"),
  };
  lives.set(live.id, live);
  return live;
}

export function persist(live: Live, flushNow = false) {
  if (!live.convo.messages.length) return;
  live.title = titleFrom(live.convo.messages);
  saveChat({
    id: live.id,
    title: live.title,
    cwd: live.cwd,
    sessionId: live.convo.sessionId,
    model: live.convo.model,
    provider: live.provider,
    updatedAt: Date.now(),
    messages: live.convo.messages,
  });
  if (flushNow) flushHistoryNow();
}

export const INTERRUPTED_KEY = "pulso.ai.interrupted";

export function saveRunningBeforeExit() {
  let active: Live | null = null;
  for (const l of lives.values()) {
    if (!l.convo.messages.length) continue;
    persist(l);
    if (l.convo.running && (!active || l === S.current)) active = l;
  }
  if (active) writeJsonStorage(INTERRUPTED_KEY, { id: active.id, cwd: active.cwd });
  else removeStorage(INTERRUPTED_KEY);
  flushHistoryNow();
}
