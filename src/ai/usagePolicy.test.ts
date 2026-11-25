import { describe, expect, it } from "vitest";
import { emptyConversation, reduce } from "../aiModel";
import { USAGE_IDLE_MS, USAGE_RUNNING_MS, usageFromEvent, usageIsDue } from "./usagePolicy";

const win = (utilization: number) => ({ utilization, resetsAt: 4_102_444_800 });

describe("uso en vivo", () => {
  it("un evento sin cifras no pisa una consulta reciente con las de la conversación", () => {
    const convo = { ...emptyConversation(), usage: { fiveHour: win(0.1), sevenDay: win(0.2) } };
    const after = reduce(convo, { type: "system", subtype: "init", session_id: "s" });
    const fetched = { fiveHour: win(0.6), sevenDay: win(0.7) };
    expect(usageFromEvent(fetched, convo.usage, after.usage)).toBeNull();
  });

  it("un evento de límites cambia solo la ventana que trae", () => {
    const convo = { ...emptyConversation(), usage: { fiveHour: win(0.1), sevenDay: win(0.2) } };
    const after = reduce(convo, {
      type: "rate_limit_event",
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: 4_102_444_800 } } },
    });
    const fetched = { fiveHour: win(0.6), sevenDay: win(0.7) };
    const next = usageFromEvent(fetched, convo.usage, after.usage);
    expect(next?.fiveHour?.utilization).toBe(0.8);
    expect(next?.sevenDay?.utilization).toBe(0.7);
  });

  it("consulta antes durante una respuesta que en reposo", () => {
    const now = 1_000_000;
    const attempted = now - USAGE_RUNNING_MS;
    expect(usageIsDue(attempted, USAGE_RUNNING_MS, now)).toBe(true);
    expect(usageIsDue(attempted, USAGE_IDLE_MS, now)).toBe(false);
  });
});
