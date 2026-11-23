/**
 * Aprobación de comandos y de páginas web del agente propio. El agente se detiene y manda una pregunta (`pulso_permission`);
 * aquí se guarda hasta que la persona responde, se pinta como una tarjeta en la conversación y se devuelve la respuesta a Rust.
 * Los comandos de riesgo solo se pueden permitir una vez: no hay «siempre» ni «todo» para ellos.
 */
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { quickPick, setStatus, type PickItem } from "../ui";
import { h } from "../util";
import { ws } from "../workspace";

export interface PermissionRequest {
  id: string;
  tool: "command" | "web";
  /** El comando completo o la dirección. */
  detail: string;
  risky: boolean;
  /** Subagente que lo pide (vacío = el agente principal). */
  agent: string;
}

export type Decision = "once" | "always" | "all" | "deny";

/** Lee un evento de la herramienta; `null` si no es de permisos. */
export function parsePermissionEvent(raw: unknown): { kind: "ask"; req: PermissionRequest } | { kind: "resolved"; id: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.type === "pulso_permission_resolved" && typeof e.id === "string") return { kind: "resolved", id: e.id };
  if (e.type !== "pulso_permission" || typeof e.id !== "string" || typeof e.detail !== "string") return null;
  return {
    kind: "ask",
    req: { id: e.id, tool: e.tool === "web" ? "web" : "command", detail: e.detail, risky: e.risky === true, agent: typeof e.agent === "string" ? e.agent : "" },
  };
}

// ---------- Preguntas pendientes, por conversación ----------

const pending = new Map<string, PermissionRequest[]>();

export function addRequest(conversation: string, req: PermissionRequest): void {
  const list = pending.get(conversation) ?? [];
  if (!list.some((r) => r.id === req.id)) list.push(req);
  pending.set(conversation, list);
}

export function resolveRequest(conversation: string, id: string): void {
  const list = (pending.get(conversation) ?? []).filter((r) => r.id !== id);
  if (list.length) pending.set(conversation, list);
  else pending.delete(conversation);
}

export const pendingFor = (conversation: string): readonly PermissionRequest[] => pending.get(conversation) ?? [];

export function clearConversation(conversation: string): void {
  pending.delete(conversation);
}

/** Opciones que se ofrecen: lo de riesgo solo una vez; la web no guarda reglas. */
export function decisionOptions(req: PermissionRequest): { decision: Decision; label: string; primary?: boolean; ghost?: boolean }[] {
  if (req.risky) return [{ decision: "once", label: tr("Permitir una vez") }, { decision: "deny", label: tr("Denegar"), primary: true }];
  const opts: { decision: Decision; label: string; primary?: boolean; ghost?: boolean }[] = [{ decision: "once", label: tr("Permitir una vez"), primary: true }];
  if (req.tool === "command") opts.push({ decision: "always", label: tr("Permitir siempre este comando") });
  opts.push({ decision: "all", label: tr("Permitir todo en esta conversación") }, { decision: "deny", label: tr("Denegar"), ghost: true });
  return opts;
}

function title(req: PermissionRequest): string {
  const who = req.agent ? tr("El subagente {agent}", { agent: req.agent }) : tr("El agente");
  if (req.tool === "web") return tr("{who} quiere leer una página web", { who });
  return req.risky ? tr("{who} quiere ejecutar un comando peligroso", { who }) : tr("{who} quiere ejecutar un comando", { who });
}

export async function respond(conversation: string, req: PermissionRequest, decision: Decision): Promise<void> {
  resolveRequest(conversation, req.id);
  try {
    await invoke("ai_permission_respond", { id: req.id, decision });
  } catch (e) {
    setStatus(tr("No se pudo enviar la respuesta: {error}", { error: String(e) }), 6000);
  }
}

/** La tarjeta de una pregunta. `onChange` se llama al responder, para volver a pintar la conversación. */
export function buildPermissionCard(conversation: string, req: PermissionRequest, onChange: () => void): HTMLElement {
  const card = h("div", `ai-denial-card ai-perm${req.risky ? " risky" : ""}`);
  card.setAttribute("role", "region");
  card.setAttribute("aria-live", "assertive");
  card.setAttribute("aria-label", tr("El agente espera tu aprobación"));
  const head = h("div", "ai-denial-head");
  head.append(h("span", "ai-denial-badge", req.risky ? tr("RIESGO") : tr("APROBACIÓN")), h("span", "ai-denial-title", title(req)));
  const code = h("pre", "ai-perm-code");
  code.textContent = req.detail;
  const acts = h("div", "ai-denial-acts");
  for (const o of decisionOptions(req)) {
    const b = h("button", `ai-denial-btn${o.primary ? " primary" : ""}${o.ghost ? " ghost" : ""}`, o.label);
    b.type = "button";
    b.onclick = () => { void respond(conversation, req, o.decision).then(onChange); onChange(); };
    acts.append(b);
  }
  card.append(head, code);
  if (req.risky) card.append(h("p", "ai-denial-msg", tr("Este comando puede borrar datos, publicar cambios o modificar el sistema. Revísalo bien: no se puede dejar permitido.")));
  card.append(acts);
  return card;
}

// ---------- Reglas guardadas ----------

interface RuleEntry { kind: "allow" | "deny"; rule: string }

/** Lista las reglas de comandos guardadas para este proyecto; elegir una la quita. */
export function showPermissionRules(): void {
  if (!ws.root) { setStatus(tr("Abre una carpeta de proyecto primero."), 5000); return; }
  const cwd = ws.root;
  quickPick({
    placeholder: tr("Comandos permitidos para este proyecto (elige uno para quitarlo)"),
    empty: tr("No hay reglas guardadas. Se crean con «Permitir siempre este comando»."),
    load: async () => {
      let list: RuleEntry[];
      try {
        list = await invoke<RuleEntry[]>("agent_rules_list", { cwd });
      } catch (e) {
        setStatus(tr("No se pudieron leer las reglas: {error}", { error: String(e) }), 8000);
        return [];
      }
      return list.map<PickItem>((r) => ({
        label: r.rule,
        detail: r.kind === "deny" ? tr("Denegado siempre · elegir para quitar") : tr("Permitido siempre · elegir para quitar"),
        run: async () => {
          try {
            await invoke("agent_rules_remove", { cwd, kind: r.kind, rule: r.rule });
            setStatus(tr("Regla quitada: {rule}", { rule: r.rule }), 5000);
          } catch (e) {
            setStatus(tr("No se pudo quitar la regla: {error}", { error: String(e) }), 8000);
          }
        },
      }));
    },
  });
}
