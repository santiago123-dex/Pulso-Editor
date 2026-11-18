/**
 * Modelo de una conversación con Claude Code a partir de su salida `stream-json`: una función pura que va
 * convirtiendo cada evento en mensajes, bloques de herramientas, uso del plan y resultado. Sin DOM ni procesos.
 */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; json: string; result?: string; error?: boolean };

export interface Turn { id: string; role: "user" | "assistant"; blocks: Block[]; done: boolean }

export interface UsageWindow { utilization: number; resetsAt: number }
export interface PlanUsage { fiveHour?: UsageWindow; sevenDay?: UsageWindow }

export interface Outcome { ok: boolean; costUsd: number; durationMs: number; message: string; denials: number }

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

/** Evento propio: la persona envió este mensaje. */
export const userEvent = (text: string): AiEvent => ({ type: "pulso_user", text });
/** Evento propio: el proceso terminó. */
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
  return t.length > MAX_RESULT ? `${t.slice(0, MAX_RESULT)}\n… (recortado)` : t;
}

const clone = (c: Conversation): Conversation => ({ ...c, messages: c.messages.map((m) => ({ ...m, blocks: m.blocks.map((b) => ({ ...b })) })), usage: { ...c.usage } });

const windowOf = (v: unknown): UsageWindow | undefined => {
  const o = obj(v);
  return typeof o.utilization === "number" ? { utilization: o.utilization, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt : 0 } : undefined;
};

/** Aplica un evento. Devuelve una conversación nueva; la anterior no se modifica. */
export function reduce(prev: Conversation, ev: AiEvent): Conversation {
  const c = clone(prev);
  const last = () => c.messages[c.messages.length - 1];
  switch (ev.type) {
    case "pulso_user":
      c.messages.push({ id: `u${c.messages.length}`, role: "user", blocks: [{ kind: "text", text: str(ev.text) }], done: true });
      c.running = true; c.outcome = null; c.error = ""; c.touched = 0;
      return c;
    case "system": {
      if (ev.subtype === "init") { c.sessionId = str(ev.session_id) || c.sessionId; c.model = str(ev.model) || c.model; }
      return c;
    }
    case "stream_event": {
      const e = obj(ev.event);
      if (e.type === "message_start") {
        const m = obj(e.message);
        c.messages.push({ id: str(m.id) || `a${c.messages.length}`, role: "assistant", blocks: [], done: false });
        return c;
      }
      const turn = last();
      if (!turn || turn.role !== "assistant") return c;
      const index = typeof e.index === "number" ? e.index : turn.blocks.length;
      if (e.type === "content_block_start") {
        turn.blocks[index] = blockFrom(e.content_block) ?? { kind: "text", text: "" };
      } else if (e.type === "content_block_delta") {
        const d = obj(e.delta);
        const b = turn.blocks[index];
        if (d.type === "text_delta" && b?.kind === "text") b.text += str(d.text);
        else if (d.type === "thinking_delta" && b?.kind === "thinking") b.text += str(d.thinking);
        else if (d.type === "input_json_delta" && b?.kind === "tool") b.json += str(d.partial_json);
      } else if (e.type === "content_block_stop") {
        const b = turn.blocks[index];
        if (b?.kind === "tool" && b.json) b.input = parseJson(b.json);
      } else if (e.type === "message_stop") {
        turn.done = true;
      }
      return c;
    }
    case "assistant": {
      // Instantánea del mensaje: es la versión definitiva de los bloques que ya trae (conserva resultados de herramientas).
      const m = obj(ev.message);
      const id = str(m.id);
      const content = Array.isArray(m.content) ? m.content : [];
      let turn = c.messages.find((t) => t.id === id && t.role === "assistant");
      if (!turn) { turn = { id: id || `a${c.messages.length}`, role: "assistant", blocks: [], done: false }; c.messages.push(turn); }
      content.forEach((raw, i) => {
        const b = blockFrom(raw);
        if (!b) return;
        const old = turn!.blocks[i];
        if (b.kind === "tool" && old?.kind === "tool" && old.id === b.id) { b.result = old.result; b.error = old.error; }
        turn!.blocks[i] = b;
      });
      return c;
    }
    case "user": {
      const m = obj(ev.message);
      for (const raw of Array.isArray(m.content) ? m.content : []) {
        const r = obj(raw);
        if (r.type !== "tool_result") continue;
        for (const t of c.messages) for (const b of t.blocks) {
          if (b.kind === "tool" && b.id === str(r.tool_use_id)) {
            b.result = resultText(r.content);
            b.error = r.is_error === true;
            if (!b.error && isFileChange(b)) c.touched++;
          }
        }
      }
      return c;
    }
    case "rate_limit_event": {
      const w = obj(obj(ev.rate_limit_info).unifiedWindows);
      c.usage = { fiveHour: windowOf(w.five_hour) ?? c.usage.fiveHour, sevenDay: windowOf(w.seven_day) ?? c.usage.sevenDay };
      return c;
    }
    case "result": {
      c.running = false;
      c.sessionId = str(ev.session_id) || c.sessionId;
      const ok = ev.subtype === "success" && ev.is_error !== true;
      const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0;
      c.outcome = { ok, costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0, durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : 0, message: str(ev.result), denials };
      if (!ok) c.error = str(ev.result) || "La herramienta terminó con un error.";
      for (const t of c.messages) t.done = true;
      return c;
    }
    case "pulso_exit": {
      if (!c.running) return c;
      c.running = false;
      for (const t of c.messages) t.done = true;
      const stderr = str(ev.stderr).trim();
      c.error = ev.code === null ? "La conversación se detuvo." : stderr || `La herramienta terminó con el código ${String(ev.code)} sin responder.`;
      return c;
    }
    default:
      return c;
  }
}

export const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
export const isFileChange = (b: Block): boolean => b.kind === "tool" && FILE_TOOLS.includes(b.name);

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;

/** Frase corta de lo que hizo una herramienta: «Leyó a.ts», «Editó b.ts»… */
export function toolSummary(b: Extract<Block, { kind: "tool" }>): string {
  const i = b.input;
  const file = str(i.file_path) || str(i.notebook_path) || str(i.path);
  switch (b.name) {
    case "Read": return file ? `Leyó ${baseName(file)}` : "Leyó un archivo";
    case "Edit": case "MultiEdit": return file ? `Editó ${baseName(file)}` : "Editó un archivo";
    case "Write": return file ? `Escribió ${baseName(file)}` : "Escribió un archivo";
    case "NotebookEdit": return file ? `Editó ${baseName(file)}` : "Editó un cuaderno";
    case "Glob": return `Buscó archivos${str(i.pattern) ? ` «${str(i.pattern)}»` : ""}`;
    case "Grep": return `Buscó${str(i.pattern) ? ` «${str(i.pattern)}»` : " en los archivos"}`;
    case "Bash": return "Quiso ejecutar un comando";
    case "WebFetch": case "WebSearch": return "Consultó la web";
    default: return b.name || "Usó una herramienta";
  }
}

/** ¿El error indica que falta iniciar sesión? */
export const isAuthError = (text: string): boolean => /not logged in|please run \/login|\/login|invalid api key|authentication|unauthorized|sign in|oauth|401/i.test(text);

export function percent(w: UsageWindow | undefined): string { return w ? `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)} %` : "—"; }

/** «en 2 h 10 min», «en 3 d» o «ya». */
export function resetIn(w: UsageWindow | undefined, nowMs = Date.now()): string {
  if (!w?.resetsAt) return "";
  const s = Math.round(w.resetsAt - nowMs / 1000);
  if (s <= 0) return "ya";
  if (s < 3600) return `en ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return m ? `en ${h} h ${m} min` : `en ${h} h`; }
  return `en ${Math.round(s / 86400)} d`;
}

/** Texto de un plan: «Pro», «Max»… */
export const planLabel = (plan: string): string => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "");
