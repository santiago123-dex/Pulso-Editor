import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "./events";

describe("EventBus tipado", () => {
  it("entrega eventos y devuelve una función de cancelación (unsubscribe)", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const off = bus.on("overlay", (kind) => seen.push(kind));

    bus.emit("overlay", "board");
    bus.emit("overlay", "ai");
    off();
    bus.emit("overlay", "chat");

    expect(seen).toEqual(["board", "ai"]);
  });

  it("permite eventos sin payload y cancelar dentro del propio handler sin saltar oyentes", () => {
    const bus = createEventBus();
    const calls: string[] = [];
    const offA = bus.on("scm-refreshed", () => {
      calls.push("a");
      offA();
    });
    bus.on("scm-refreshed", () => calls.push("b"));

    bus.emit("scm-refreshed");
    bus.emit("scm-refreshed");

    expect(calls).toEqual(["a", "b", "b"]);
  });

  it("clear elimina todos los oyentes", () => {
    const bus = createEventBus();
    const fn = vi.fn();
    bus.on("issues-changed", fn);
    bus.clear();
    bus.emit("issues-changed");
    expect(fn).not.toHaveBeenCalled();
  });
});
