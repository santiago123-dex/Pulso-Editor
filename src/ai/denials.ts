/** Tarjetas de acciones denegadas y propuestas de cambios del asistente. */

import { type DeniedAction, needsCommandPermission, touchedFiles } from "../aiModel";
import { writeStorage } from "../core/storage";
import { t as tr } from "../i18n";
import { h } from "../util";
import { clearActiveIssueWork, createPrForActiveIssue, getActiveIssueWork } from "../workflow/issueWorkflow";
import { type AiMode, type Live, S, ctl, q } from "./chatState";

export const proposalStatus = new Map<string, "applied" | "discarded">();
/** Tarjetas de permiso bloqueado descartadas manualmente por turno. */
export const dismissedDenials = new Set<string>();

export function buildDenialCard(live: Live, denials: number, actions: readonly DeniedAction[] | undefined, dismissKey: string): HTMLElement {
  const card = h("div", "ai-denial-card");
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", tr("Permiso requerido por el agente"));

  const wantsFull = S.mode !== "read" || needsCommandPermission(actions);
  const targetMode: AiMode = wantsFull ? "full" : "edit";
  const targetLabel = targetMode === "full" ? tr("Agente") : tr("Puede editar");

  const head = h("div", "ai-denial-head");
  head.append(
    h("span", "ai-denial-badge", "PERMISO REQUERIDO"),
    h("span", "ai-denial-title", denials === 1 ? tr("El agente necesitó ejecutar una acción bloqueada") : tr("El agente necesitó ejecutar {count} acciones bloqueadas", { count: denials })),
  );
  card.append(head);

  if (actions?.length) {
    const list = h("div", "ai-denial-list");
    for (const a of actions.slice(0, 4)) {
      const row = h("div", "ai-denial-item");
      row.append(h("span", "ai-denial-tool", a.tool));
      if (a.detail) row.append(h("code", "ai-denial-detail", a.detail));
      if (a.reason) row.append(h("span", "ai-denial-reason", a.reason));
      list.append(row);
    }
    card.append(list);
  } else {
    const explain = targetMode === "full"
      ? tr("El modo actual no permite ejecutar comandos de terminal (como run_command o Bash). Aprueba esta acción para que el agente pueda completar la tarea.")
      : tr("El modo «Solo leer» impide modificar archivos. Aprueba la edición para que el agente pueda continuar.");
    card.append(h("p", "ai-denial-msg", explain));
  }

  const acts = h("div", "ai-denial-acts");
  const onceBtn = h("button", "ai-denial-btn primary", tr("Permitir una vez y continuar"));
  onceBtn.type = "button";
  onceBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    const contPrompt = targetMode === "full"
      ? "El usuario aprobó ejecutar el comando o herramienta que quedó bloqueada en el paso anterior. Ejecútalo ahora y completa la tarea pendiente."
      : "El usuario aprobó modificar archivos para el paso anterior. Aplica los cambios y completa la tarea pendiente.";
    void ctl.dispatchPrompt(live, tr("Permiso concedido (una vez) · continuar"), contPrompt, targetMode);
  };

  const switchBtn = h("button", "ai-denial-btn", tr("Activar «{mode}» y continuar", { mode: targetLabel }));
  switchBtn.type = "button";
  switchBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    S.mode = targetMode;
    writeStorage("pulso.ai.mode", S.mode);
    writeStorage(targetMode === "full" ? "pulso.ai.fullOk" : "pulso.ai.editOk", "1");
    ctl.build();
    const contPrompt = targetMode === "full"
      ? "El usuario activó el modo Agente completo (edición y comandos de terminal aprobados). Ejecuta lo que quedó pendiente y completa la tarea."
      : "El usuario activó el modo Puede editar. Aplica los cambios y completa la tarea pendiente.";
    void ctl.dispatchPrompt(live, tr("Modo «{mode}» activado · continuar", { mode: targetLabel }), contPrompt, targetMode);
  };

  const dismissBtn = h("button", "ai-denial-btn ghost", tr("No permitir"));
  dismissBtn.type = "button";
  dismissBtn.onclick = () => {
    dismissedDenials.add(dismissKey);
    ctl.renderBody();
  };

  acts.append(onceBtn, switchBtn, dismissBtn);
  card.append(acts);
  return card;
}

export function renderIssueBanner() {
  const banner = q(".ai-issue-banner");
  if (!banner) return;
  const work = getActiveIssueWork();
  if (!work) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  const info = h("div", "ai-issue-info");
  info.append(
    h("span", "ai-issue-num", `#${work.number}`),
    h("span", "ai-issue-title", work.title),
    h("code", "ai-issue-branch", work.branch),
  );
  const acts = h("div", "ai-issue-acts");
  const prBtn = h("button", "ai-issue-btn primary", tr("Crear PR"));
  prBtn.type = "button";
  prBtn.title = tr("Crear pull request enlazando Closes #{number}", { number: work.number });
  prBtn.onclick = () => {
    const files = S.current ? touchedFiles(S.current.convo.messages) : [];
    void createPrForActiveIssue(files);
  };
  const endBtn = h("button", "ai-issue-btn", tr("Finalizar"));
  endBtn.type = "button";
  endBtn.title = tr("Dejar de asociar esta issue al asistente");
  endBtn.onclick = () => { clearActiveIssueWork(); renderIssueBanner(); };
  acts.append(prBtn, endBtn);
  banner.replaceChildren(info, acts);
}

/** Caché incremental de nodos renderizados por turno: evita reconstruir toda la conversación en cada token (O(1) por frame). */
