import { lang, t, t as tr } from "./i18n";
/**
 * Modelo de una conversación con Claude Code a partir de su salida `stream-json`: una función pura que va
 * convirtiendo cada evento en mensajes, bloques de herramientas, uso del plan y resultado. Sin DOM ni procesos.
 */
export type AiProvider = "claude" | "codex" | "antigravity" | "local" | "cloud";

export interface UserImage { path: string; name: string; preview?: string }

export type Block =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; name: string; preview?: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; json: string; result?: string; error?: boolean };

export interface Turn { id: string; role: "user" | "assistant"; blocks: Block[]; done: boolean }

export interface UsageWindow { utilization: number; resetsAt: number }
export interface PlanUsage { fiveHour?: UsageWindow; sevenDay?: UsageWindow }

export interface DeniedAction { tool: string; detail: string; reason: string }

export interface Outcome { ok: boolean; costUsd: number; durationMs: number; message: string; denials: number; deniedActions?: DeniedAction[] }

export interface Conversation {
  messages: Turn[];
  sessionId: string;
  model: string;
  running: boolean;
  usage: PlanUsage;
  outcome: Outcome | null;
  error: string;
  /** Herramientas que cambiaron archivos en este turno (para recargar lo abierto). */
  touched: number;
}

export const emptyConversation = (): Conversation => ({ messages: [], sessionId: "", model: "", running: false, usage: {}, outcome: null, error: "", touched: 0 });

/** Resultados de herramientas muy largos se recortan: la conversación se guarda y se pinta entera. */
export const MAX_RESULT = 4000;

export type AiEvent = { type: string; [k: string]: unknown };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Evento propio: la persona envió este mensaje (con texto y opcionalmente imágenes adjuntas). */
export const userEvent = (text: string, images?: readonly UserImage[]): AiEvent => ({
  type: "pulso_user",
  text,
  ...(images?.length ? { images: images.map((i) => ({ path: i.path, name: i.name, ...(i.preview ? { preview: i.preview } : {}) })) } : {}),
});
/** Evento propio: el proceso terminó. */
/** Traduce los errores conocidos de las herramientas a algo accionable; el resto se deja tal cual. */
export function friendlyToolError(stderr: string): string {
  const s = stderr.trim();
  if (/IneligibleTierError|no longer supported for Gemini Code Assist/i.test(s)) {
    return t("Google ya no permite usar Gemini CLI con cuentas personales: lo migró a Antigravity. Para seguir usando Gemini aquí hace falta una clave de API de Gemini (variable GEMINI_API_KEY) o una cuenta de Workspace/Vertex.");
  }
  if (/not running in a trusted directory/i.test(s)) {
    return t("Gemini CLI no confía en esta carpeta. Ábrela una vez con `gemini` en una terminal y acepta la confianza.");
  }
  return s;
}

export const exitEvent = (code: number | null, stderr: string): AiEvent => ({ type: "pulso_exit", code, stderr });

function blockFrom(raw: unknown): Block | null {
  const b = obj(raw);
  if (b.type === "text") return { kind: "text", text: str(b.text) };
  if (b.type === "thinking") return { kind: "thinking", text: str(b.thinking) };
  if (b.type === "tool_use") return { kind: "tool", id: str(b.id), name: str(b.name), input: obj(b.input), json: "" };
  return null;
}

function parseJson(text: string): Record<string, unknown> {
  try { return obj(JSON.parse(text)); } catch { return {}; }
}

/** Contenido de un `tool_result`: texto, o lista de bloques de texto. */
function resultText(content: unknown): string {
  const t = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => str(obj(c).text)).filter(Boolean).join("\n") : "";
  return t.length > MAX_RESULT ? `${t.slice(0, MAX_RESULT)}\n… ${tr("(recortado)")}` : t;
}

const windowOf = (v: unknown): UsageWindow | undefined => {
  const o = obj(v);
  return typeof o.utilization === "number" ? { utilization: o.utilization, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt : 0 } : undefined;
};

function withTurn(prev: Conversation, idx: number, turn: Turn): Conversation {
  const messages = prev.messages.slice();
  messages[idx] = turn;
  return { ...prev, messages };
}

function withBlock(prev: Conversation, turnIdx: number, blockIdx: number, block: Block): Conversation {
  const turn = prev.messages[turnIdx];
  const blocks = turn.blocks.slice();
  blocks[blockIdx] = block;
  return withTurn(prev, turnIdx, { ...turn, blocks });
}

function markAllDone(messages: Turn[]): Turn[] {
  let changed = false;
  const next = messages.map((t) => {
    if (t.done) return t;
    changed = true;
    return { ...t, done: true };
  });
  return changed ? next : messages;
}

/** Extrae detalles legibles de `denied_actions` (Antigravity) o `permission_denials` (Claude Code). */
export function parseDeniedActions(raw: unknown): DeniedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: DeniedAction[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ tool: t("Acción bloqueada"), detail: item.trim(), reason: "" });
      continue;
    }
    const o = obj(item);
    if (!Object.keys(o).length) continue;
    const tool = str(o.tool_name) || str(o.tool) || str(o.name) || str(o.action) || t("Acción bloqueada");
    const inp = obj(o.tool_input ?? o.input ?? o.parameters ?? o.arguments);
    const detail = str(o.command) || str(o.cmd) || str(o.CommandLine)
      || str(inp.command) || str(inp.cmd) || str(inp.CommandLine)
      || str(o.path) || str(o.file_path) || str(inp.path) || str(inp.file_path) || str(inp.TargetFile)
      || str(o.detail) || str(o.summary);
    const reason = str(o.reason) || str(o.message) || str(o.error) || str(o.description);
    out.push({ tool, detail: detail.slice(0, 220), reason: reason.slice(0, 240) });
  }
  return out;
}

/** ¿Alguna acción denegada requiere ejecución de comandos de terminal? */
export function needsCommandPermission(actions: readonly DeniedAction[] | undefined): boolean {
  if (!actions?.length) return false;
  return actions.some((a) => /(run_command|bash|shell|terminal|command|exec)/i.test(`${a.tool} ${a.detail}`));
}

/** Aplica un evento usando structural sharing (O(1) por token en lugar de clonar toda la conversación). */
export function reduce(prev: Conversation, ev: AiEvent): Conversation {
  switch (ev.type) {
    case "pulso_user": {
      const blocks: Block[] = [{ kind: "text", text: str(ev.text) }];
      if (Array.isArray(ev.images)) {
        for (const raw of ev.images) {
          const img = obj(raw);
          const path = str(img.path);
          const name = str(img.name);
          if (path || name) {
            const preview = str(img.preview);
            blocks.push({ kind: "image", path, name: name || path.split("/").pop() || "imagen", ...(preview ? { preview } : {}) });
          }
        }
      }
      return {
        ...prev,
        messages: [...prev.messages, { id: `u${prev.messages.length}`, role: "user", blocks, done: true }],
        running: true,
        outcome: null,
        error: "",
        touched: 0,
      };
    }
    case "system": {
      if (ev.subtype !== "init") return prev;
      const sessionId = str(ev.session_id) || prev.sessionId;
      const model = str(ev.model) || prev.model;
      return sessionId === prev.sessionId && model === prev.model ? prev : { ...prev, sessionId, model };
    }
    case "stream_event": {
      const e = obj(ev.event);
      if (e.type === "message_start") {
        const m = obj(e.message);
        const turn: Turn = { id: str(m.id) || `a${prev.messages.length}`, role: "assistant", blocks: [], done: false };
        return { ...prev, messages: [...prev.messages, turn] };
      }
      const turnIdx = prev.messages.length - 1;
      const turn = prev.messages[turnIdx];
      if (!turn || turn.role !== "assistant") return prev;
      const index = typeof e.index === "number" ? e.index : turn.blocks.length;
      if (e.type === "content_block_start") {
        return withBlock(prev, turnIdx, index, blockFrom(e.content_block) ?? { kind: "text", text: "" });
      }
      if (e.type === "content_block_delta") {
        const d = obj(e.delta);
        const b = turn.blocks[index];
        if (d.type === "text_delta" && b?.kind === "text") {
          return withBlock(prev, turnIdx, index, { ...b, text: b.text + str(d.text) });
        }
        if (d.type === "thinking_delta" && b?.kind === "thinking") {
          return withBlock(prev, turnIdx, index, { ...b, text: b.text + str(d.thinking) });
        }
        if (d.type === "input_json_delta" && b?.kind === "tool") {
          return withBlock(prev, turnIdx, index, { ...b, json: b.json + str(d.partial_json) });
        }
        return prev;
      }
      if (e.type === "content_block_stop") {
        const b = turn.blocks[index];
        if (b?.kind === "tool" && b.json) {
          return withBlock(prev, turnIdx, index, { ...b, input: parseJson(b.json) });
        }
        return prev;
      }
      if (e.type === "message_stop") {
        return turn.done ? prev : withTurn(prev, turnIdx, { ...turn, done: true });
      }
      return prev;
    }
    case "assistant": {
      // Instantánea del mensaje: es la versión definitiva de los bloques que ya trae (conserva resultados de herramientas).
      const m = obj(ev.message);
      const id = str(m.id);
      const content = Array.isArray(m.content) ? m.content : [];
      const existingIdx = prev.messages.findIndex((t) => t.id === id && t.role === "assistant");
      const baseTurn: Turn = existingIdx >= 0
        ? prev.messages[existingIdx]
        : { id: id || `a${prev.messages.length}`, role: "assistant", blocks: [], done: false };
      const blocks = baseTurn.blocks.slice();
      content.forEach((raw, i) => {
        const b = blockFrom(raw);
        if (!b) return;
        const old = blocks[i];
        if (b.kind === "tool" && old?.kind === "tool" && old.id === b.id) {
          blocks[i] = { ...b, result: old.result, error: old.error };
        } else {
          blocks[i] = b;
        }
      });
      const updatedTurn: Turn = { ...baseTurn, blocks };
      if (existingIdx >= 0) return withTurn(prev, existingIdx, updatedTurn);
      return { ...prev, messages: [...prev.messages, updatedTurn] };
    }
    case "user": {
      const m = obj(ev.message);
      const results = (Array.isArray(m.content) ? m.content : [])
        .map(obj)
        .filter((r) => r.type === "tool_result");
      if (!results.length) return prev;
      let touched = prev.touched;
      let anyChanged = false;
      const messages = prev.messages.map((t) => {
        let turnChanged = false;
        const blocks = t.blocks.map((b) => {
          if (b.kind !== "tool") return b;
          const match = results.find((r) => str(r.tool_use_id) === b.id);
          if (!match) return b;
          turnChanged = true;
          anyChanged = true;
          const isErr = match.is_error === true;
          if (!isErr && isFileChange(b)) touched++;
          return { ...b, result: resultText(match.content), error: isErr };
        });
        return turnChanged ? { ...t, blocks } : t;
      });
      return anyChanged ? { ...prev, messages, touched } : prev;
    }
    case "rate_limit_event": {
      const w = obj(obj(ev.rate_limit_info).unifiedWindows);
      return {
        ...prev,
        usage: { fiveHour: windowOf(w.five_hour) ?? prev.usage.fiveHour, sevenDay: windowOf(w.seven_day) ?? prev.usage.sevenDay },
      };
    }
    case "result": {
      const ok = ev.subtype === "success" && ev.is_error !== true;
      const deniedActions = parseDeniedActions(ev.permission_denials);
      const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0;
      return {
        ...prev,
        running: false,
        sessionId: str(ev.session_id) || prev.sessionId,
        outcome: {
          ok,
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0,
          durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : 0,
          message: str(ev.result),
          denials,
          ...(deniedActions.length ? { deniedActions } : {}),
        },
        error: ok ? prev.error : str(ev.result) || t("La herramienta terminó con un error."),
        messages: markAllDone(prev.messages),
      };
    }
    case "pulso_exit": {
      if (!prev.running) return prev;
      const stderr = str(ev.stderr).trim();
      return {
        ...prev,
        running: false,
        messages: markAllDone(prev.messages),
        error: ev.code === null ? t("La conversación se detuvo.") : friendlyToolError(stderr) || t("La herramienta terminó con el código {code} sin responder.", { code: String(ev.code) }),
      };
    }
    default:
      return prev;
  }
}

export const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
export const isFileChange = (b: Block): boolean => b.kind === "tool" && FILE_TOOLS.includes(b.name);

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;

/** Frase corta de lo que hizo una herramienta: «Leyó a.ts», «Editó b.ts»… */
export function toolSummary(b: Extract<Block, { kind: "tool" }>): string {
  const i = b.input;
  const file = str(i.file_path) || str(i.notebook_path) || str(i.path) || str(i.Path) || str(i.TargetFile) || str(i.DirectoryPath);
  const pat = str(i.pattern) || str(i.Pattern) || str(i.Query);
  const cmd = str(i.command) || str(i.CommandLine);
  switch (b.name) {
    case "Read": return file ? t("Leyó {file}", { file: baseName(file) }) : t("Leyó un archivo");
    case "Edit": case "MultiEdit": return file ? t("Editó {file}", { file: baseName(file) }) : t("Editó un archivo");
    case "Write": return file ? t("Escribió {file}", { file: baseName(file) }) : t("Escribió un archivo");
    case "NotebookEdit": return file ? t("Editó {file}", { file: baseName(file) }) : t("Editó un cuaderno");
    case "Glob": return pat ? t("Buscó archivos «{pattern}»", { pattern: pat }) : file ? t("Exploró {file}", { file: baseName(file) }) : t("Buscó archivos");
    case "Grep": return pat ? t("Buscó «{pattern}»", { pattern: pat }) : t("Buscó en los archivos");
    case "Bash": return t("Quiso ejecutar un comando");
    case "Command": return cmd ? t("Ejecutó {command}", { command: cmd }) : t("Ejecutó un comando");
    case "WebFetch": case "WebSearch": return t("Consultó la web");
    case "TodoWrite": return t("Actualizó la lista de tareas");
    case "Skill": return str(i.name) ? t("Usó la skill {name}", { name: str(i.name) }) : t("Usó una skill");
    case "Task": return str(i.description) ? t("Subagente {agent}: {description}", { agent: str(i.agent), description: str(i.description) }) : t("Lanzó un subagente");
    default: return b.name || t("Usó una herramienta");
  }
}

function mapAgyToolName(raw: string): string {
  switch (raw) {
    case "read_file": case "read_many_files": case "view_file": return "Read";
    case "write_file": case "write_to_file": return "Write";
    case "replace": case "edit_file": case "replace_file_content": case "multi_replace_file_content": return "Edit";
    case "list_directory": case "list_dir": case "glob": case "find_by_name": return "Glob";
    case "search_file_content": case "grep": case "grep_search": return "Grep";
    case "run_shell_command": case "run_command": return "Command";
    case "google_web_search": case "web_fetch": case "search_web": case "read_url_content": return "WebSearch";
    default: return raw || "Tool";
  }
}

/**
 * Normaliza líneas JSONL de Codex CLI y Antigravity CLI (`agy`) al formato `AiEvent` común.
 * Para Claude Code devuelve el evento original sin cambios.
 */
export function createProviderNormalizer(provider: AiProvider, fallbackModel = ""): (raw: AiEvent) => AiEvent[] {
  // El agente local (Ollama) ya emite el formato de Claude Code desde Rust.
  if (provider === "claude" || provider === "local" || provider === "cloud") return (raw) => [raw];

  let turnStart = Date.now();
  let agySeq = 0;
  let agyStreamedText = false;
  const agySteps = new Map<number, { id: string; text: string; kind: "text" | "thinking" | "tool" }>();
  let codexToolSeq = 0;

  const codexRateLimitEvent = (rlRaw: unknown): AiEvent | null => {
    const rl = obj(rlRaw);
    const p = obj(rl.primary);
    const s = obj(rl.secondary);
    if (typeof p.used_percent !== "number" && typeof s.used_percent !== "number") return null;
    return {
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: typeof p.used_percent === "number" ? { utilization: p.used_percent / 100, resetsAt: typeof p.resets_at === "number" ? p.resets_at : 0 } : undefined,
          seven_day: typeof s.used_percent === "number" ? { utilization: s.used_percent / 100, resetsAt: typeof s.resets_at === "number" ? s.resets_at : 0 } : undefined,
        },
      },
    };
  };

  return (raw: AiEvent): AiEvent[] => {
    if (provider === "codex") {
      switch (raw.type) {
        case "event_msg": {
          const pl = obj(raw.payload);
          if (str(pl.type) === "token_count") {
            const rl = codexRateLimitEvent(pl.rate_limits);
            if (rl) return [rl];
          }
          return [];
        }
        case "thread.started":
          turnStart = Date.now();
          return [{ type: "system", subtype: "init", session_id: str(raw.thread_id), model: fallbackModel }];
        case "turn.started":
          turnStart = Date.now();
          return [];
        case "item.started":
        case "item.completed": {
          const item = obj(raw.item);
          const kind = str(item.type);
          const id = str(item.id) || `cx_${++codexToolSeq}`;
          const done = raw.type === "item.completed";
          if (kind === "agent_message" && done && str(item.text)) {
            return [{ type: "assistant", message: { id, content: [{ type: "text", text: str(item.text) }] } }];
          }
          if (kind === "reasoning" && done && str(item.text)) {
            return [{ type: "assistant", message: { id, content: [{ type: "thinking", thinking: str(item.text) }] } }];
          }
          if (kind === "command_execution") {
            const cmd = str(item.command);
            const evs: AiEvent[] = [{ type: "assistant", message: { id, content: [{ type: "tool_use", id, name: "Command", input: { command: cmd } }] } }];
            if (done) {
              const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
              const isErr = str(item.status) === "failed" || exitCode !== 0;
              evs.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: str(item.aggregated_output) || (isErr ? `Código ${exitCode}` : "ok"), is_error: isErr }] } });
            }
            return evs;
          }
          if (kind === "file_change" && done) {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const evs: AiEvent[] = [];
            changes.forEach((ch, idx) => {
              const cObj = obj(ch);
              const fp = str(cObj.path);
              const act = str(cObj.kind) === "add" ? "Write" : "Edit";
              const tid = `${id}_${idx}`;
              evs.push({ type: "assistant", message: { id: tid, content: [{ type: "tool_use", id: tid, name: act, input: { file_path: fp, kind: str(cObj.kind) } }] } });
              evs.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tid, content: `${str(cObj.kind) || "update"} ${fp}`, is_error: str(item.status) === "failed" }] } });
            });
            return evs;
          }
          if (kind === "mcp_tool_call" || kind === "web_search") {
            const name = str(item.tool) || (kind === "web_search" ? "WebSearch" : "MCP");
            const input = kind === "web_search" ? { query: str(item.query) } : obj(item.arguments);
            const evs: AiEvent[] = [{ type: "assistant", message: { id, content: [{ type: "tool_use", id, name, input }] } }];
            if (done) {
              const isErr = str(item.status) === "failed" || !!item.error;
              const out = item.error ? JSON.stringify(item.error) : str(item.result) || JSON.stringify(item.result ?? "ok");
              evs.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: isErr }] } });
            }
            return evs;
          }
          return [];
        }
        case "turn.completed": {
          const out: AiEvent[] = [];
          const rl = codexRateLimitEvent(raw.rate_limits);
          if (rl) out.push(rl);
          out.push({ type: "result", subtype: "success", is_error: false, duration_ms: Math.max(0, Date.now() - turnStart), total_cost_usd: 0, result: "ok" });
          return out;
        }
        case "turn.failed":
          return [{ type: "result", subtype: "error", is_error: true, result: str(obj(raw.error).message) || t("La ejecución de Codex falló.") }];
        case "error":
          return [{ type: "result", subtype: "error", is_error: true, result: str(raw.message) || t("Error de Codex CLI.") }];
        default:
          return [];
      }
    }

    // Antigravity CLI (`agy --output-format stream-json`)
    const agyEv = str(raw.event) || str(raw.type);
    switch (agyEv) {
      case "init": {
        turnStart = Date.now();
        agyStreamedText = false;
        agySteps.clear();
        const init = obj(raw.init);
        return [{ type: "system", subtype: "init", session_id: str(raw.conversation_id) || str(raw.session_id), model: str(init.model) || str(raw.model) || fallbackModel }];
      }
      case "step_update": {
        const su = obj(raw.step_update);
        const idx = typeof su.step_index === "number" ? su.step_index : ++agySeq;
        const stepType = str(su.step_type);
        const state = str(su.state);
        if (stepType === "user_input") return [];
        if (stepType === "error_message") {
          const msg = str(su.text) || str(su.text_delta) || str(su.error);
          return msg ? [{ type: "result", subtype: "error", is_error: true, result: msg }] : [];
        }
        if (stepType === "thinking" || stepType === "thought") {
          const delta = str(su.thinking_delta) || str(su.text_delta) || str(su.text);
          if (!delta) return [];
          const prev = agySteps.get(idx) ?? { id: `agy_t_${idx}`, text: "", kind: "thinking" as const };
          prev.text = su.text_delta || su.thinking_delta ? prev.text + delta : delta;
          agySteps.set(idx, prev);
          return [{ type: "assistant", message: { id: prev.id, content: [{ type: "thinking", thinking: prev.text }] } }];
        }
        if (stepType === "agent_response") {
          const delta = str(su.text_delta) || str(su.text);
          if (!delta) return [];
          agyStreamedText = true;
          const prev = agySteps.get(idx) ?? { id: `agy_m_${idx}`, text: "", kind: "text" as const };
          prev.text = su.text_delta ? prev.text + delta : delta;
          agySteps.set(idx, prev);
          return [{ type: "assistant", message: { id: prev.id, content: [{ type: "text", text: prev.text }] } }];
        }
        const ti = obj(su.tool_info);
        const toolNameRaw = str(ti.name) || str(su.tool_name) || str(su.name) || (stepType && stepType !== "planner_response" && stepType !== "tool" ? stepType : "");
        if (toolNameRaw) {
          const id = str(su.tool_id) || `agy_tool_${idx}`;
          const name = mapAgyToolName(toolNameRaw);
          const input = obj(ti.parameters ?? su.input ?? su.parameters ?? su.arguments);
          const evs: AiEvent[] = [{ type: "assistant", message: { id, content: [{ type: "tool_use", id, name, input }] } }];
          if (state === "DONE" || state === "ERROR") {
            const errObj = obj(ti.error ?? su.error);
            const errMsg = str(errObj.message) || str(ti.error) || str(su.error);
            const isErr = state === "ERROR" || su.is_error === true || !!errMsg;
            const out = str(ti.output) || str(ti.result) || str(su.output) || str(su.result) || errMsg || (isErr ? "Error" : "ok");
            evs.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: isErr }] } });
          }
          return evs;
        }
        return [];
      }
      case "result": {
        const res = obj(raw.result ?? raw);
        const sid = str(res.conversation_id) || str(raw.conversation_id);
        const denied = Array.isArray(res.denied_actions) ? res.denied_actions : [];
        const finalText = str(res.response);
        const blockedHeadless = denied.length > 0 && !agyStreamedText && !finalText;
        const ok = str(res.status).toUpperCase() === "SUCCESS" && !blockedHeadless;
        const durSec = typeof res.duration_seconds === "number" ? res.duration_seconds : 0;
        const durationMs = durSec > 0 ? Math.round(durSec * 1000) : Math.max(0, Date.now() - turnStart);
        const out: AiEvent[] = [];
        if (!agyStreamedText && finalText) {
          out.push({ type: "assistant", message: { id: `agy_final_${++agySeq}`, content: [{ type: "text", text: finalText }] } });
        }
        const errMsg = blockedHeadless
          ? t("Antigravity necesitó permiso para ejecutar un comando y no puede pedir confirmación en este modo.")
          : friendlyToolError(str(res.error) || t("Antigravity terminó con error."));
        out.push({
          type: "result",
          subtype: ok ? "success" : "error",
          is_error: !ok,
          session_id: sid || undefined,
          duration_ms: durationMs,
          total_cost_usd: 0,
          permission_denials: denied,
          result: ok ? "ok" : errMsg,
        });
        return out;
      }
      default:
        return [];
    }
  };
}

/** ¿El error indica que falta iniciar sesión? */
export const isAuthError = (text: string): boolean => /not logged in|please run \/login|\/login|invalid api key|authentication|unauthorized|sign in|oauth|401/i.test(text);

export function percent(w: UsageWindow | undefined): string { return w ? `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)} %` : "—"; }

/** Proporción usada de una ventana (0..1). */
export function usedRatio(w: UsageWindow | undefined): number {
  return w ? Math.max(0, Math.min(1, w.utilization)) : 0;
}

/** Porcentaje usado legible («67%», «44%» o «—»). */
export function usedPercent(w: UsageWindow | undefined): string {
  return w ? `${Math.round(usedRatio(w) * 100)}%` : "—";
}

/** Proporción restante de una ventana (0..1). */
export function remainingRatio(w: UsageWindow | undefined): number {
  return w ? Math.max(0, Math.min(1, 1 - usedRatio(w))) : 1;
}

/** Porcentaje disponible legible («87%», «100%» o «—»). */
export function remainingPercent(w: UsageWindow | undefined): string {
  return w ? `${Math.round(remainingRatio(w) * 100)}%` : "—";
}

/** Convierte una fecha ISO-8601 («2026-11-25T15:17:00Z») a segundos Unix; 0 si no es válida. */
export function resetTimeFromIso(iso: string): number {
  if (!iso?.trim()) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : 0;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante dado. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(utcMs))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** Instante UTC (ms) de una fecha y hora de pared en la zona `tz` (o la del sistema si no se conoce). */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string | undefined): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  try {
    const first = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(first, tz);
  } catch { return new Date(y, mo, d, h, mi).getTime(); }
}

function tzDateParts(utcMs: number, tz: string | undefined): { year: number; month: number; day: number } {
  const validTz = tz && /^[\w/+-]+$/.test(tz) ? tz : undefined;
  try {
    const p: Record<string, number> = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone: validTz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(utcMs))) {
      if (x.type !== "literal") p[x.type] = Number(x.value);
    }
    if (p.year && p.month && p.day) return { year: p.year, month: p.month - 1, day: p.day };
  } catch { /* cae a la fecha local */ }
  const d = new Date(utcMs);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

/** «Nov 18, 12pm (America/Bogota)» o «12:30pm (UTC)» → segundos Unix; 0 si no se entiende. */
export function parseResetText(raw: string, nowMs = Date.now()): number {
  const zone = /\(([^)]+)\)\s*$/.exec(raw.trim());
  const tz = zone?.[1].trim();
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(raw.trim());
  if (!m) return 0;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") h += 12;
  const mi = m[4] ? Number(m[4]) : 0;
  const base = tzDateParts(nowMs, tz);
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return 0;
    let ms = wallToUtc(base.year, mo, Number(m[2]), h, mi, tz);
    if (ms < nowMs - 7 * 86400_000) ms = wallToUtc(base.year + 1, mo, Number(m[2]), h, mi, tz);
    return Math.round(ms / 1000);
  }
  let ms = wallToUtc(base.year, base.month, base.day, h, mi, tz);
  while (ms <= nowMs) ms += 86400_000;
  return Math.round(ms / 1000);
}

/** Lee el texto de `/usage` («Current session: 68% used · resets Nov 18, 12pm (America/Bogota)»). */
export function parseUsageText(text: string, nowMs = Date.now()): PlanUsage {
  const win = (label: RegExp): UsageWindow | undefined => {
    const m = label.exec(text);
    if (!m) return undefined;
    return { utilization: Math.min(1, Math.max(0, Number(m[1]) / 100)), resetsAt: m[2] ? parseResetText(m[2], nowMs) : 0 };
  };
  return {
    fiveHour: win(/^\s*Current session:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*(?:[·•|,–-]\s*|\s+)resets\s+(.+?))?\s*$/im),
    sevenDay: win(/^\s*Current week\s*\(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*(?:[·•|,–-]\s*|\s+)resets\s+(.+?))?\s*$/im),
  };
}

/** Descarta ventanas cuyo reinicio ya venció para no mostrar cifras viejas. */
export function pruneUsage(u: PlanUsage, nowMs = Date.now()): PlanUsage {
  const valid = (w: UsageWindow | undefined) => (w && (!w.resetsAt || w.resetsAt * 1000 > nowMs) ? w : undefined);
  return { fiveHour: valid(u.fiveHour), sevenDay: valid(u.sevenDay) };
}

/** Hora exacta de restablecimiento en español: «Se restablece a las 12:00 p. m.» o «Se restablece el dom, 4:00 p. m.». */
export function resetClockText(w: UsageWindow | undefined, nowMs = Date.now()): string {
  if (!w?.resetsAt) return "";
  const targetMs = w.resetsAt * 1000;
  if (targetMs <= nowMs) return t("Se restablece ahora");
  const d = new Date(targetMs);
  const now = new Date(nowMs);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(lang(), { hour: "numeric", minute: "2-digit" });
  if (sameDay) return t("Se restablece a las {time}", { time });
  const day = d.toLocaleDateString(lang(), { weekday: "short" }).replace(/\.$/, "");
  return t("Se restablece el {day}, {time}", { day, time });
}

/** Convierte un identificador técnico («claude-sonnet-5-5-20260514») en nombre específico legible («Claude Sonnet 5.5»). */
export function formatModelName(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const clean = s.replace(/-\d{8}$/, "");
  const m = /^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d+))?$/i.exec(clean);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    const ver = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `Claude ${fam} ${ver}`;
  }
  const legacy = /^claude-(\d+)-(\d+)-(sonnet|opus|haiku)$/i.exec(clean);
  if (legacy) {
    const fam = legacy[3].charAt(0).toUpperCase() + legacy[3].slice(1).toLowerCase();
    return `Claude ${fam} ${legacy[1]}.${legacy[2]}`;
  }
  const gem = /^gemini-(.+)$/i.exec(s);
  if (gem) {
    return `Gemini ${gem[1].split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ")}`;
  }
  const oss = /^gpt-oss-(\d+[a-z]*)-([a-z]+)$/i.exec(s);
  if (oss) {
    return `GPT-OSS ${oss[1].toUpperCase()} (${oss[2].charAt(0).toUpperCase() + oss[2].slice(1)})`;
  }
  const gpt = /^(gpt-[a-z0-9.-]+|o\d+[a-z0-9-]*)$/i.exec(s);
  if (gpt) {
    return gpt[1].replace(/^gpt/i, "GPT").replace(/-codex$/i, " Codex");
  }
  return s;
}

/** Formato compacto de reinicio para el panel de uso: «6d 23h», «4h 19m», «15m» o «ahora». */
export function resetCountdown(w: UsageWindow | undefined, nowMs = Date.now()): string {
  if (!w?.resetsAt) return "";
  const s = Math.round(w.resetsAt - nowMs / 1000);
  if (s <= 0) return "ahora";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Rutas únicas modificadas con éxito en una conversación (último turno o completa). */
export function touchedFiles(messages: readonly Turn[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of messages) {
    for (const b of t.blocks) {
      if (b.kind !== "tool" || b.error || !isFileChange(b)) continue;
      const p = str(b.input.file_path) || str(b.input.notebook_path) || str(b.input.path) || str(b.input.Path) || str(b.input.TargetFile);
      if (!p) continue;
      const normP = p.replace(/\\/g, "/");
      const key = normP.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(normP); }
    }
  }
  return out;
}

/** «en 2 h 10 min», «en 3 d» o «ya». */
export function resetIn(w: UsageWindow | undefined, nowMs = Date.now()): string {
  if (!w?.resetsAt) return "";
  const s = Math.round(w.resetsAt - nowMs / 1000);
  if (s <= 0) return t("ya");
  if (s < 3600) return t("en {n} min", { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return m ? t("en {h} h {m} min", { h, m }) : t("en {h} h", { h }); }
  return t("en {n} d", { n: Math.round(s / 86400) });
}

/** Texto de un plan: «Pro», «Max»… */
export const planLabel = (plan: string): string => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "");

/**
 * Divide un turno del asistente en «actividad» (lo que hizo por el camino: razonamiento, herramientas y textos intermedios)
 * y la respuesta final (el último texto con contenido que ya no va seguido de más trabajo). Así la conversación muestra
 * primero la respuesta y deja el proceso plegado.
 */
export function splitAssistantTurn(blocks: Block[]): { activity: Block[]; final: string } {
  let finalIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.kind === "text") {
      if (b.text.trim()) { finalIdx = i; break; }
      continue;
    }
    if (b.kind === "thinking" && !b.text.trim()) continue;
    break;
  }
  const activity = blocks.filter((b, i) => i !== finalIdx && (b.kind === "tool" || (b.kind !== "image" && b.text.trim() !== "")));
  const fb = finalIdx >= 0 ? blocks[finalIdx] : undefined;
  return { activity, final: fb && fb.kind === "text" ? fb.text : "" };
}

/** Resumen de la actividad: qué está haciendo ahora (en vivo) o qué hizo (al terminar). */
export function activitySummary(items: Block[], running: boolean): { now: string; counts: string } {
  let reads = 0; let edits = 0; let searches = 0; let cmds = 0; let other = 0; let now = "";
  for (const b of items) {
    if (b.kind !== "tool") continue;
    now = toolSummary(b);
    if (b.name === "Read") reads++;
    else if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(b.name)) edits++;
    else if (["Glob", "Grep", "WebSearch", "WebFetch"].includes(b.name)) searches++;
    else if (b.name === "Command" || b.name === "Bash") cmds++;
    else other++;
  }
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => { if (n) parts.push(n === 1 ? one : many.replace("{n}", String(n))); };
  add(reads, t("1 archivo leído"), t("{n} archivos leídos"));
  add(edits, t("1 edición"), t("{n} ediciones"));
  add(searches, t("1 búsqueda"), t("{n} búsquedas"));
  add(cmds, t("1 comando"), t("{n} comandos"));
  add(other, t("1 acción"), t("{n} acciones"));
  if (!parts.length && items.some((b) => b.kind === "thinking")) parts.push(t("razonamiento"));
  return { now: running ? now || t("Leyendo tu mensaje") : "", counts: parts.join(" · ") };
}

/** «8 s», «1 min 05 s». */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/**
 * Une los turnos seguidos del asistente en uno solo: algunas herramientas (Antigravity) mandan cada paso como un mensaje
 * aparte, y la persona debe ver una sola respuesta con una sola actividad. `parts` guarda los turnos originales para
 * saber si algo cambió sin comparar el contenido.
 */
export function mergeAssistantRuns(messages: Turn[]): { turn: Turn; parts: Turn[] }[] {
  const out: { turn: Turn; parts: Turn[] }[] = [];
  for (const t of messages) {
    const prev = out[out.length - 1];
    if (t.role === "assistant" && prev && prev.turn.role === "assistant") {
      prev.parts.push(t);
      prev.turn = { id: prev.parts[0]!.id, role: "assistant", blocks: prev.parts.flatMap((p) => p.blocks), done: t.done };
    } else {
      out.push({ turn: t, parts: [t] });
    }
  }
  return out;
}
