import { describe, expect, it } from "vitest";
import { createProviderNormalizer, emptyConversation, exitEvent, formatModelName, isAuthError, isFileChange, MAX_RESULT, percent, planLabel, friendlyToolError, parseResetText, parseUsageText, pruneUsage, reduce, remainingPercent, resetClockText, resetCountdown, resetIn, resetTimeFromIso, toolSummary, touchedFiles, usedPercent, usedRatio, userEvent, type AiEvent, type Block, type Conversation } from "./aiModel";

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
  it("calcula el porcentaje usado, descarta ventanas vencidas, formatea modelos y archivos modificados", () => {
    const w = (u: number, s: number) => ({ utilization: u, resetsAt: NOW / 1000 + s });
    expect(usedRatio(w(0.67, 10))).toBeCloseTo(0.67);
    expect(usedPercent(w(0.67, 10))).toBe("67%");
    expect(usedPercent(undefined)).toBe("—");
    expect(pruneUsage({ fiveHour: w(0.5, -10), sevenDay: w(0.44, 3600) }, NOW)).toEqual({
      fiveHour: undefined,
      sevenDay: w(0.44, 3600),
    });
    expect(resetClockText(w(0.5, 3600), NOW)).toContain("Se restablece");
    expect(resetCountdown(w(0.1, 6 * 86400 + 23 * 3600), NOW)).toBe("6d 23h");
    expect(resetCountdown(w(0.1, 4 * 3600 + 19 * 60), NOW)).toBe("4h 19m");
    expect(resetCountdown(w(0.1, 600), NOW)).toBe("10m");
    expect(resetCountdown(w(0.1, -1), NOW)).toBe("ahora");
    expect(formatModelName("claude-sonnet-5-5-20260514")).toBe("Claude Sonnet 5.5");
    expect(formatModelName("claude-sonnet-4-8")).toBe("Claude Sonnet 4.8");
    expect(formatModelName("claude-3-7-sonnet-20250219")).toBe("Claude Sonnet 3.7");
    expect(touchedFiles([
      {
        id: "1",
        role: "assistant",
        done: true,
        blocks: [
          { kind: "tool", id: "a", name: "Read", input: { file_path: "a.ts" }, json: "", result: "ok" },
          { kind: "tool", id: "b", name: "Edit", input: { file_path: "src\\b.ts" }, json: "", result: "ok" },
          { kind: "tool", id: "c", name: "Write", input: { file_path: "src/b.ts" }, json: "", result: "ok" },
          { kind: "tool", id: "d", name: "Edit", input: { file_path: "src/fail.ts" }, json: "", result: "err", error: true },
        ],
      },
    ])).toEqual(["src/b.ts"]);
  });
});

describe("uso real del plan (/usage)", () => {
  const NOW = Date.UTC(2026, 10, 18, 15, 0, 0); // 10:00 en Bogotá
  const text = [
    "You are currently using your subscription",
    "",
    "Current session: 68% used · resets Nov 18, 12pm (America/Bogota)",
    "Current week (all models): 44% used · resets Nov 22, 4pm (America/Bogota)",
  ].join("\n");

  it("lee los porcentajes y los reinicios con su zona horaria", () => {
    const u = parseUsageText(text, NOW);
    expect(u.fiveHour?.utilization).toBeCloseTo(0.68);
    expect(u.sevenDay?.utilization).toBeCloseTo(0.44);
    expect(u.fiveHour?.resetsAt).toBe(Date.UTC(2026, 10, 18, 17, 0, 0) / 1000);
    expect(u.sevenDay?.resetsAt).toBe(Date.UTC(2026, 10, 22, 21, 0, 0) / 1000);
  });

  it("una hora sin fecha es la próxima vez que ocurra", () => {
    expect(parseResetText("12:30pm (UTC)", NOW)).toBe(Date.UTC(2026, 10, 19, 12, 30, 0) / 1000);
    expect(parseResetText("11pm (UTC)", NOW)).toBe(Date.UTC(2026, 10, 18, 23, 0, 0) / 1000);
    // Cerca de medianoche entre zonas horarias, usa el día de la zona indicada y no el del reloj local.
    const lateBogota = Date.UTC(2026, 10, 19, 2, 0, 0); // 21:00 del 18 en Bogotá, 02:00 del 19 en UTC
    expect(parseResetText("11pm (America/Bogota)", lateBogota)).toBe(Date.UTC(2026, 10, 19, 4, 0, 0) / 1000);
    expect(parseResetText("11pm (UTC)", lateBogota)).toBe(Date.UTC(2026, 10, 19, 23, 0, 0) / 1000);
  });

  it("tolera separadores alternos en /usage", () => {
    const alt = "Current session: 12% used - resets 11pm (UTC)\nCurrent week (all models): 8% used | resets Nov 22, 4pm (UTC)";
    const u = parseUsageText(alt, NOW);
    expect(u.fiveHour?.utilization).toBeCloseTo(0.12);
    expect(u.sevenDay?.utilization).toBeCloseTo(0.08);
    expect(u.fiveHour?.resetsAt).toBe(Date.UTC(2026, 10, 18, 23, 0, 0) / 1000);
  });

  it("si no entiende el texto no inventa nada", () => {
    expect(parseUsageText("nada que ver", NOW)).toEqual({ fiveHour: undefined, sevenDay: undefined });
    expect(parseResetText("pronto", NOW)).toBe(0);
  });
});

describe("adaptadores para Codex CLI y Gemini CLI", () => {
  it("normaliza eventos de Codex CLI (hilo, razonamiento, cambios y fin)", () => {
    const norm = createProviderNormalizer("codex", "gpt-5.4");
    const raw: AiEvent[] = [
      { type: "thread.started", thread_id: "th_99" },
      { type: "item.completed", item: { id: "i1", type: "reasoning", text: "Analizo el módulo." } },
      { type: "item.completed", item: { id: "i2", type: "file_change", status: "completed", changes: [{ path: "src/app.ts", kind: "update" }] } },
      { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Listo." } },
      { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 25, resets_at: 1900000100 }, secondary: { used_percent: 14, resets_at: 1900500000 } } } },
      { type: "turn.completed" },
    ];
    let convo = reduce(emptyConversation(), userEvent("mejora app.ts"));
    for (const r of raw) for (const ev of norm(r)) convo = reduce(convo, ev);
    expect(convo.sessionId).toBe("th_99");
    expect(convo.model).toBe("gpt-5.4");
    expect(convo.touched).toBe(1);
    expect(convo.outcome?.ok).toBe(true);
    expect(convo.usage.fiveHour?.utilization).toBeCloseTo(0.25);
    expect(convo.usage.sevenDay?.utilization).toBeCloseTo(0.14);
    expect(touchedFiles(convo.messages)).toEqual(["src/app.ts"]);
    expect(formatModelName("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  });

  it("normaliza eventos de Antigravity CLI (stream-json, pasos y cuotas restantes)", () => {
    const norm = createProviderNormalizer("antigravity", "gemini-4-hydrogen-high");
    const raw = [
      { type: "init", event: "init", conversation_id: "agy_1", init: { cwd: "." } },
      { type: "step_update", event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
      { type: "step_update", event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: { Path: "src/a.ts" } } } },
      { type: "step_update", event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: { Path: "src/a.ts" }, output: "ok" } } },
      { type: "step_update", event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hola " } },
      { type: "step_update", event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "mundo" } },
      { type: "result", event: "result", result: { conversation_id: "agy_1", status: "SUCCESS", response: "Hola mundo", duration_seconds: 1.5 } },
    ] as unknown as AiEvent[];
    let convo = reduce(emptyConversation(), userEvent("lee a.ts"));
    for (const r of raw) for (const ev of norm(r)) convo = reduce(convo, ev);
    expect(convo.sessionId).toBe("agy_1");
    expect(convo.model).toBe("gemini-4-hydrogen-high");
    expect(convo.outcome?.ok).toBe(true);
    expect(convo.outcome?.durationMs).toBe(1500);
    expect(formatModelName("gemini-4-hydrogen-high")).toBe("Gemini 4 Hydrogen High");
    expect(formatModelName("gpt-oss-120b-medium")).toBe("GPT-OSS 120B (Medium)");
    expect(remainingPercent({ utilization: 0.13, resetsAt: 0 })).toBe("87%");
    expect(resetTimeFromIso("2026-11-25T15:17:00Z")).toBe(1795619820);
    const assistantTurns = convo.messages.filter((m) => m.role === "assistant");
    expect(assistantTurns.some((t) => t.blocks.some((b) => b.kind === "text" && b.text === "Hola mundo"))).toBe(true);
    const readTool = assistantTurns.flatMap((t) => t.blocks).find((b) => b.kind === "tool" && b.name === "Read");
    expect(readTool?.kind === "tool" && toolSummary(readTool)).toBe("Leyó a.ts");
  });
});

describe("errores conocidos de las herramientas", () => {
  it("explica que Gemini CLI ya no sirve con cuentas personales", () => {
    const msg = friendlyToolError("An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.");
    expect(msg).toContain("Antigravity");
    expect(msg).toContain("GEMINI_API_KEY");
  });
  it("explica la carpeta no confiable y deja el resto tal cual", () => {
    expect(friendlyToolError("Gemini CLI is not running in a trusted directory.")).toContain("no confía");
    expect(friendlyToolError("  boom  ")).toBe("boom");
  });
});
