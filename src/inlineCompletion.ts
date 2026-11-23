import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { extractInlineContext, shouldTriggerInline } from "./inlineCompletionModel";
import { state } from "./settings";

/**
 * Proveedor de autocompletado de IA en línea (texto fantasma con Tab) respaldado por Ollama local.
 * Si Ollama no está en marcha, entra en pausa silenciosa de 60 s para no entorpecer la escritura.
 */
const DEBOUNCE_MS = 420;
const OFFLINE_BACKOFF_MS = 60_000;

let registered = false;
let offlineUntil = 0;

export function resetInlineAiBackoff() {
  offlineUntil = 0;
}

export function initInlineCompletions() {
  if (registered || !("__TAURI_INTERNALS__" in window)) return;
  registered = true;

  monaco.languages.registerInlineCompletionsProvider("*", {
    async provideInlineCompletions(model, position, _context, token) {
      if (!state.settings.inlineAiEnabled) return { items: [] };
      if (Date.now() < offlineUntil) return { items: [] };
      if (model.uri.scheme !== "file" && model.uri.scheme !== "pulso") return { items: [] };

      const ctx = extractInlineContext(model.getValue(), position.lineNumber, position.column);
      if (!shouldTriggerInline(ctx.prefix)) return { items: [] };

      // Debounce cancelable para no saturar Ollama mientras se teclea.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, DEBOUNCE_MS);
        token.onCancellationRequested(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (token.isCancellationRequested) return { items: [] };

      try {
        const suggestion = await invoke<string>("ai_inline_complete", {
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          language: model.getLanguageId(),
          model: state.settings.inlineAiModel || "",
        });
        if (token.isCancellationRequested || !suggestion) return { items: [] };
        return {
          items: [
            {
              insertText: suggestion,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column
              ),
            },
          ],
        };
      } catch {
        offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
        return { items: [] };
      }
    },
    freeInlineCompletions() {
      // Nada que liberar
    },
  });
}
