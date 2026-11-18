import { describe, expect, it } from "vitest";
import { emptyConversation, exitEvent, isAuthError, isFileChange, MAX_RESULT, percent, planLabel, reduce, resetIn, toolSummary, userEvent, type AiEvent, type Block, type Conversation } from "./aiModel";

const run = (events: AiEvent[], start: Conversation = emptyConversation()) => events.reduce(reduce, start);
const se = (event: unknown): AiEvent => ({ type: "stream_event", event });
const msgStart = (id: string) => se({ type: "message_start", message: { id } });
const delta = (index: number, d: unknown) => se({ type: "content_block_delta", index, delta: d });

describe("respuesta de texto en vivo", () => {
  it("construye el texto con los fragmentos y fija la sesión y el modelo", () => {
    const c = run([
      userEvent("hola"),
      { type: "system", subtype: "init", session_id: "S1", model: "claude-sonnet-5-5" },
      msgStart("m1"),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      delta(0, { type: "text_delta", text: "Ho" }),
      delta(0, { type: "text_delta", text: "la" }),
      se({ type: "message_stop" }),
    ]);
    expect(c.sessionId).toBe("S1");
    expect(c.model).toBe("claude-sonnet-5-5");
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.messages[1].blocks).toEqual([{ kind: "text", text: "Hola" }]);
    expect(c.messages[1].done).toBe(true);
    expect(c.running).toBe(true);
  });
  it("la instantánea del mensaje sustituye lo acumulado sin duplicar", () => {
    const c = run([
      msgStart("m1"),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      delta(0, { type: "text_delta", text: "ok" }),
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }] } },
    ]);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].blocks).toEqual([{ kind: "text", text: "ok" }]);
  });
  it("una instantánea sin mensaje previo lo crea", () => {
    const c = run([{ type: "assistant", message: { id: "x", content: [{ type: "text", text: "solo instantánea" }] } }]);
    expect(c.messages[0].blocks).toEqual([{ kind: "text", text: "solo instantánea" }]);
  });
  it("el razonamiento queda aparte del texto", () => {
    const c = run([
      msgStart("m1"),
      se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      delta(0, { type: "thinking_delta", thinking: "pienso" }),
      se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      delta(1, { type: "text_delta", text: "digo" }),
    ]);
    expect(c.messages[0].blocks).toEqual([{ kind: "thinking", text: "pienso" }, { kind: "text", text: "digo" }]);
  });
});

describe("herramientas", () => {
  const toolTurn = [
    msgStart("m1"),
    se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Read", input: {} } }),
    delta(0, { type: "input_json_delta", partial_json: '{"file_path": "C:\\\\p\\\\a' }),
    delta(0, { type: "input_json_delta", partial_json: '.ts"}' }),
    se({ type: "content_block_stop", index: 0 }),
  ];
  it("acumula el JSON de la entrada por trozos y lo lee al cerrar el bloque", () => {
    const b = run(toolTurn).messages[0].blocks[0] as Extract<Block, { kind: "tool" }>;
    expect(b.name).toBe("Read");
    expect(b.input).toEqual({ file_path: "C:\\p\\a.ts" });
    expect(toolSummary(b)).toBe("Leyó a.ts");
  });
  it("el resultado se enlaza con su herramienta, y la instantánea posterior lo conserva", () => {
    const c = run([
      ...toolTurn,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1\tcontenido" }] } },
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:\\p\\a.ts" } }] } },
    ]);
    const b = c.messages[0].blocks[0] as Extract<Block, { kind: "tool" }>;
    expect(b.result).toBe("1\tcontenido");
    expect(b.error).toBe(false);
  });
  it("un resultado en lista de bloques se une y uno enorme se recorta; un error se marca", () => {
    const c = run([
      ...toolTurn,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], is_error: true }] } },
    ]);
    const b = c.messages[0].blocks[0] as Extract<Block, { kind: "tool" }>;
    expect(b.result).toBe("a\nb");
    expect(b.error).toBe(true);
    const big = run([...toolTurn, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(MAX_RESULT + 500) }] } }]);
    expect((big.messages[0].blocks[0] as Extract<Block, { kind: "tool" }>).result!.length).toBeLessThan(MAX_RESULT + 40);
  });
  it("cuenta los cambios de archivo correctos para recargar lo abierto, y no los fallidos ni las lecturas", () => {
    const edit = (id: string, name: string): AiEvent[] => [
      se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }),
    ];
    const c = run([
      msgStart("m1"), ...edit("e1", "Edit"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } },
      msgStart("m2"), ...edit("e2", "Write"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e2", content: "no", is_error: true }] } },
      msgStart("m3"), ...edit("r1", "Read"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "ok" }] } },
    ]);
    expect(c.touched).toBe(1);
    expect(isFileChange({ kind: "tool", id: "x", name: "Edit", input: {}, json: "" })).toBe(true);
    expect(isFileChange({ kind: "text", text: "" })).toBe(false);
  });
  it("resume en español lo que hizo cada herramienta", () => {
    const t = (name: string, input: Record<string, unknown>): Extract<Block, { kind: "tool" }> => ({ kind: "tool", id: "x", name, input, json: "" });
    expect(toolSummary(t("Edit", { file_path: "src/b.ts" }))).toBe("Editó b.ts");
    expect(toolSummary(t("Write", { file_path: "src/c.ts" }))).toBe("Escribió c.ts");
    expect(toolSummary(t("Glob", { pattern: "**/*.ts" }))).toBe("Buscó archivos «**/*.ts»");
    expect(toolSummary(t("Grep", { pattern: "foo" }))).toBe("Buscó «foo»");
    expect(toolSummary(t("Bash", {}))).toBe("Quiso ejecutar un comando");
    expect(toolSummary(t("Cosa", {}))).toBe("Cosa");
  });
});

describe("resultado, uso del plan y salida del proceso", () => {
  it("el resultado cierra el turno con coste y duración", () => {
    const c = run([userEvent("x"), { type: "result", subtype: "success", is_error: false, session_id: "S2", total_cost_usd: 0.05, duration_ms: 1200, result: "hecho", permission_denials: [{}, {}] }]);
    expect(c.running).toBe(false);
    expect(c.sessionId).toBe("S2");
    expect(c.outcome).toEqual({ ok: true, costUsd: 0.05, durationMs: 1200, message: "hecho", denials: 2 });
    expect(c.error).toBe("");
  });
  it("un resultado con error lo deja como error visible", () => {
    const c = run([userEvent("x"), { type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · Please run /login" }]);
    expect(c.outcome?.ok).toBe(false);
    expect(c.error).toContain("Invalid API key");
    expect(isAuthError(c.error)).toBe(true);
    expect(isAuthError("se acabó el tiempo")).toBe(false);
  });
  it("guarda el uso de las ventanas del plan y los eventos siguientes lo actualizan", () => {
    const rl = (a: number, b: number) => ({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: a, resetsAt: 100 }, seven_day: { utilization: b, resetsAt: 200 } } } });
    const c = run([rl(0.51, 0.42), rl(0.54, 0.42)]);
    expect(c.usage).toEqual({ fiveHour: { utilization: 0.54, resetsAt: 100 }, sevenDay: { utilization: 0.42, resetsAt: 200 } });
    expect(percent(c.usage.fiveHour)).toBe("54 %");
    expect(percent(undefined)).toBe("—");
    expect(percent({ utilization: 3, resetsAt: 0 })).toBe("100 %");
  });
  it("si el proceso termina sin resultado se explica con su salida de error; un corte manual no es un fallo", () => {
    const sin = run([userEvent("x"), exitEvent(1, "claude: command failed")]);
    expect(sin.running).toBe(false);
    expect(sin.error).toBe("claude: command failed");
    expect(run([userEvent("x"), exitEvent(2, "")]).error).toMatch(/código 2/);
    expect(run([userEvent("x"), exitEvent(null, "")]).error).toBe("La conversación se detuvo.");
    const ya = run([userEvent("x"), { type: "result", subtype: "success", is_error: false }, exitEvent(0, "")]);
    expect(ya.error).toBe("");
  });
  it("los eventos desconocidos y los mal formados no rompen nada, y la entrada no se modifica", () => {
    const base = run([userEvent("x")]);
    const copia = JSON.stringify(base);
    expect(run([{ type: "raro" }, { type: "stream_event" }, { type: "user" }, { type: "assistant" }, { type: "system" }, { type: "pulso_truncated" }], base).messages.length).toBeGreaterThanOrEqual(1);
    reduce(base, { type: "result", subtype: "success" });
    expect(JSON.stringify(base)).toBe(copia);
  });
});

describe("etiquetas del plan", () => {
  const NOW = 1_700_000_000_000;
  it("cuánto falta para que se reinicie la ventana", () => {
    const w = (s: number) => ({ utilization: 0.5, resetsAt: NOW / 1000 + s });
    expect(resetIn(w(-5), NOW)).toBe("ya");
    expect(resetIn(w(30 * 60), NOW)).toBe("en 30 min");
    expect(resetIn(w(2 * 3600 + 600), NOW)).toBe("en 2 h 10 min");
    expect(resetIn(w(3 * 3600), NOW)).toBe("en 3 h");
    expect(resetIn(w(3 * 86400), NOW)).toBe("en 3 d");
    expect(resetIn(undefined, NOW)).toBe("");
  });
  it("capitaliza el nombre del plan", () => { expect(planLabel("pro")).toBe("Pro"); expect(planLabel("")).toBe(""); });
});
