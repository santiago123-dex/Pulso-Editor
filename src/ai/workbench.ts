/** La pantalla de bienvenida del asistente (sin conversación todavía). */

import { chatsFor, loadChats } from "../aiStore";
import { agoFrom } from "../historyModel";
import { t as tr } from "../i18n";
import { baseName, h } from "../util";
import { ws } from "../workspace";
import { editorContext } from "./attachments";
import { EFFORTS, EXAMPLES, PROVIDERS } from "./catalog";
import { S, ctl, lives, q } from "./chatState";
import { fromSaved } from "./conversations";
import { findModelOption } from "./modelOptions";
import { buildProviderTabs } from "./popovers";
import { fillQuotaCard, fillScopeStrip } from "./quota";

export function buildEmptyWorkbench(): HTMLElement {
  const meta = PROVIDERS[S.activeProvider];
  const empty = h("div", "ai-empty ai-bench");
  const main = h("div", "ai-bench-main");

  const modeShort = S.mode === "full" ? tr("Agente") : S.mode === "edit" ? tr("Puede editar") : tr("Solo leer");
  const modeCls = S.mode === "full" ? " full" : S.mode === "edit" ? " edit" : "";
  const eyebrow = h("div", "ai-bench-eyebrow");
  eyebrow.append(
    h("span", `ai-meta-pill${modeCls}`, modeShort),
    buildProviderTabs(),
  );

  const hero = h("div", "ai-bench-hero");
  const wsName = baseName(ws.root ?? "") || tr("Proyecto");
  hero.append(
    h("div", "ai-empty-title", tr("Mesa de trabajo · {folder}", { folder: wsName })),
    h("p", "ai-bench-lead", tr("Conversa directo sobre el código abierto usando tu sesión local de {provider}, sin claves almacenadas.", { provider: meta.title })),
  );

  const scope = h("div", "ai-scope-strip");
  fillScopeStrip(scope, editorContext());

  const exWrap = h("div", "ai-examples");
  for (const ex of EXAMPLES) {
    const b = h("button", "ai-example");
    b.type = "button";
    b.append(h("span", "ai-example-tag", ex.tag), h("span", "ai-example-main", ex.label));
    b.onclick = () => { const t = q<HTMLTextAreaElement>(".ai-input")!; t.value = ex.prompt; t.focus(); ctl.autosize(); };
    exWrap.append(b);
  }
  main.append(eyebrow, hero, scope, exWrap);

  const rail = h("div", "ai-bench-rail");
  const quotaCard = h("div", "ai-inst-card ai-inst-quota");
  fillQuotaCard(quotaCard);

  const threadsCard = h("div", "ai-inst-card ai-inst-threads");
  const thHead = h("div", "ai-inst-head");
  const thLeft = h("div", "ai-inst-head-left");
  thLeft.append(h("span", "ai-inst-kicker", tr("Sesiones recientes")));
  const allBtn = h("button", "ai-inst-sync", tr("Ver todo"));
  allBtn.type = "button";
  allBtn.onclick = () => { S.historyOpen = true; ctl.renderBody(); };
  thHead.append(thLeft, allBtn);
  threadsCard.append(thHead);

  const recent = chatsFor(loadChats(), ws.root ?? "").slice(0, 3);
  if (recent.length) {
    const list = h("div", "ai-thread-list");
    for (const c of recent) {
      const btn = h("button", "ai-thread-row");
      btn.type = "button";
      btn.append(h("span", "ai-thread-name", c.title), h("span", "ai-thread-when", agoFrom(c.updatedAt)));
      btn.onclick = () => {
        const opened = lives.get(c.id) ?? (() => { const l = fromSaved(c); lives.set(l.id, l); return l; })();
        ctl.switchProvider(opened.provider);
        S.current = opened;
        ctl.renderBody();
      };
      list.append(btn);
    }
    threadsCard.append(list);
  } else {
    const spec = h("div", "ai-inst-spec");
    const activeOpt = findModelOption(S.model);
    const effOpt = EFFORTS.find((e) => e.value === S.effort)?.label ?? "Auto";
    spec.append(
      h("div", "ai-spec-row", tr("Motor activo: {model}", { model: activeOpt.label })),
      h("div", "ai-spec-row", tr("Esfuerzo: {effort} · Modo: {mode}", { effort: effOpt, mode: S.mode === "full" ? tr("Agente completo") : S.mode === "edit" ? tr("Edición directa") : tr("Solo lectura") })),
      h("div", "ai-inst-note", tr("Tus hilos guardados en {folder} aparecerán aquí para retomarlos en un clic.", { folder: wsName })),
    );
    threadsCard.append(spec);
  }

  rail.append(quotaCard, threadsCard);
  empty.append(main, rail);
  return empty;
}

/** Estado de revisión de propuestas de diff generadas por la IA en esta sesión. */
