/**
 * Bus de eventos tipado de Pulso Editor.
 * Reemplaza eventos sueltos en `window` (`CustomEvent`), `Set` sin `unsubscribe` y clicks sintéticos al DOM.
 */
export interface PulsoEvents {
  overlay: "ai" | "board" | "chat" | "diff";
  "issues-changed": undefined;
  "scm-refreshed": undefined;
  "workspace-changed": { root: string | null };
  "issue-workflow-start": { issueNumber: number; title: string; body: string; branch: string };
}

type Handler<T> = (payload: T) => void;

export interface EventBus {
  on<K extends keyof PulsoEvents>(event: K, handler: Handler<PulsoEvents[K]>): () => void;
  emit<K extends keyof PulsoEvents>(
    ...args: PulsoEvents[K] extends undefined ? [event: K] : [event: K, payload: PulsoEvents[K]]
  ): void;
  clear(): void;
}

export function createEventBus(): EventBus {
  const map = new Map<keyof PulsoEvents, Set<Handler<unknown>>>();

  return {
    on(event, handler) {
      let set = map.get(event);
      if (!set) {
        set = new Set();
        map.set(event, set);
      }
      set.add(handler as Handler<unknown>);
      return () => {
        set?.delete(handler as Handler<unknown>);
      };
    },
    emit(event, payload?: unknown) {
      const set = map.get(event);
      if (!set) return;
      for (const fn of [...set]) {
        fn(payload);
      }
    },
    clear() {
      map.clear();
    },
  };
}

export const bus = createEventBus();
