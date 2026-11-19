import { describe, expect, it } from "vitest";
import {
  firstVisibleActivity,
  loadActivity,
  moveActivity,
  normalizeActivity,
  saveActivity,
  stepVisibleActivity,
  toggleActivityVisible,
} from "./activityOrder";

const DEFAULTS = ["explorer", "search", "git", "issues", "ai", "prs", "chat", "problems"];

describe("activityOrder", () => {
  it("normaliza órdenes guardados, descarta obsoletos y agrega nuevas vistas al final", () => {
    const cfg = normalizeActivity(
      { order: ["ai", "obsoleto", "explorer", "ai"], hidden: ["search", "obsoleto"] },
      DEFAULTS,
    );
    expect(cfg.order).toEqual(["ai", "explorer", "search", "git", "issues", "prs", "chat", "problems"]);
    expect(cfg.hidden).toEqual(["search"]);
  });

  it("nunca permite dejar todas las vistas ocultas al normalizar o alternar", () => {
    const norm = normalizeActivity({ order: ["a", "b"], hidden: ["a", "b"] }, ["a", "b"]);
    expect(norm.hidden).toEqual(["b"]);

    const oneLeft = toggleActivityVisible({ order: ["a", "b"], hidden: ["b"] }, "a");
    expect(oneLeft.hidden).toEqual(["b"]);
  });

  it("mueve botones y salta elementos ocultos al subir o bajar", () => {
    expect(moveActivity(["a", "b", "c", "d"], "c", 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveActivity(["a", "b", "c", "d"], "a", 99)).toEqual(["b", "c", "d", "a"]);

    const cfg = { order: ["a", "b", "c", "d"], hidden: ["b"] };
    expect(stepVisibleActivity(cfg, "c", -1)).toEqual(["c", "a", "b", "d"]);
    expect(stepVisibleActivity(cfg, "a", 1)).toEqual(["b", "c", "a", "d"]);
    expect(stepVisibleActivity(cfg, "a", -1)).toEqual(["a", "b", "c", "d"]);
  });

  it("persiste y recupera configuración desde el almacenamiento", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const cfg = toggleActivityVisible({ order: [...DEFAULTS], hidden: [] }, "problems");
    saveActivity({ ...cfg, order: moveActivity(cfg.order, "ai", 0) }, store);
    const loaded = loadActivity(DEFAULTS, store);
    expect(loaded.order[0]).toBe("ai");
    expect(loaded.hidden).toEqual(["problems"]);
    expect(firstVisibleActivity(loaded)).toBe("ai");
  });
});
