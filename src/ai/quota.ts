/** Cuotas y uso real del plan: tarjeta de cuotas, franja de contexto y popovers de uso y de atajos. */

import { type EditorContext } from "../aiContext";
import {
  type AiProvider,
  type UsageWindow,
  formatModelName,
  planLabel,
  remainingPercent,
  remainingRatio,
  resetClockText,
  resetCountdown,
} from "../aiModel";
import { t as tr } from "../i18n";
import { baseName, h } from "../util";
import { renderFoot } from "./accountView";
import { attachProjectFile } from "./attachments";
import { type AntigravityBucket, PROVIDERS, QUICK_PROMPTS } from "./catalog";
import { S, ctl, q, seconds, tools } from "./chatState";
import { dismissPopover, openPopover, usageRing } from "./popoverBase";
import { agyWindowFromBucket, providerUsage, refreshExtraUsage, refreshUsage } from "./usageSync";

export async function syncAccountAndUsage(): Promise<void> {
  S.toolAt = 0;
  await ctl.detect(true);
  await Promise.all([
    tools.claude?.logged_in ? (S.usageInFlight ?? refreshUsage()) : Promise.resolve(false),
    tools.codex?.logged_in || tools.antigravity?.logged_in ? refreshExtraUsage() : Promise.resolve(false),
  ]);
}

export function agyBucketLabel(b: AntigravityBucket): string {
  if (b.window === "5h") return tr("Límite 5 h");
  if (b.window === "weekly") return tr("Límite semanal");
  return b.name || tr("Límite");
}

export function fillQuotaCard(card: HTMLElement) {
  const meta = PROVIDERS[S.activeProvider];
  const curUsage = providerUsage();
  card.replaceChildren();
  const head = h("div", "ai-inst-head");
  const headLeft = h("div", "ai-inst-head-left");
  const planBadgeText =
    S.activeProvider === "claude"
      ? S.tool?.plan
        ? tr("Plan {plan}", { plan: planLabel(S.tool.plan) })
        : tr("Conectado")
      : S.activeProvider === "codex"
        ? S.tool?.plan && S.tool.plan !== "ChatGPT"
          ? tr("Plan {plan}", { plan: planLabel(S.tool.plan) })
          : "ChatGPT"
        : S.tool?.plan || meta.short;
  headLeft.append(h("span", "ai-inst-kicker", tr("Cuotas del plan")), h("span", "ai-inst-plan", planBadgeText));
  const syncBtn = h("button", "ai-inst-sync", S.usageSyncing ? tr("Actualizando…") : tr("Sincronizar"));
  syncBtn.type = "button";
  syncBtn.disabled = S.usageSyncing;
  syncBtn.title = tr("Actualizar límites disponibles del plan");
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = tr("Actualizando…");
    void syncAccountAndUsage().finally(() => {
      if (card.isConnected) fillQuotaCard(card);
    });
  };
  head.append(headLeft, syncBtn);
  card.append(head);

  if (S.activeProvider === "antigravity") {
    const meters = h("div", "ai-inst-meters");
    if (S.agyUsage?.groups?.length) {
      for (const g of S.agyUsage.groups) {
        for (const b of g.buckets) {
          const w = agyWindowFromBucket(b);
          const row = h("div", "ai-inst-row");
          const top = h("div", "ai-inst-row-top");
          top.append(
            h("span", "ai-inst-lbl", `${g.name} · ${agyBucketLabel(b)}`),
            h("span", "ai-inst-val", tr("{pct} disp.", { pct: remainingPercent(w) })),
          );
          const track = h("div", "ai-inst-track");
          const rem = remainingRatio(w);
          const bar = h("div", `ai-inst-fill${rem <= 0.1 ? " high" : rem <= 0.3 ? " warn" : ""}`);
          bar.style.width = `${Math.round(rem * 100)}%`;
          track.append(bar);
          const cd = resetCountdown(w);
          const reset = cd && cd !== "ahora" ? tr("Se reinicia en {time}", { time: cd }) : resetClockText(w);
          row.append(top, track);
          if (reset) row.append(h("div", "ai-inst-sub", reset));
          meters.append(row);
        }
      }
    } else {
      card.append(h("div", "ai-inst-note", tr("Consultando límites de Antigravity…")));
      return;
    }
    card.append(meters);
    return;
  }

  const meters = h("div", "ai-inst-meters");
  for (const [label, w] of [
    [tr("Ventana 5 h"), curUsage.fiveHour],
    [tr("Semanal"), curUsage.sevenDay],
  ] as const) {
    const row = h("div", "ai-inst-row");
    const top = h("div", "ai-inst-row-top");
    top.append(h("span", "ai-inst-lbl", label), h("span", "ai-inst-val", w ? `${remainingPercent(w)} disp.` : "—"));
    const track = h("div", "ai-inst-track");
    const rem = remainingRatio(w);
    const bar = h("div", `ai-inst-fill${rem <= 0.1 ? " high" : rem <= 0.3 ? " warn" : ""}`);
    bar.style.width = `${w ? Math.round(rem * 100) : 0}%`;
    track.append(bar);
    const cd = resetCountdown(w);
    const clock = resetClockText(w);
    const emptyMsg =
      S.activeProvider === "claude"
        ? S.usageSyncing
          ? tr("Leyendo /usage…")
          : tr("Sin datos en esta ventana")
        : tr("Consultando límites de ChatGPT…");
    const reset = cd && cd !== "ahora" ? tr("Se reinicia en {time}", { time: cd }) : clock || emptyMsg;
    row.append(top, track, h("div", "ai-inst-sub", reset));
    meters.append(row);
  }
  card.append(meters);

  if (S.activeProvider === "claude" && S.usageError) {
    card.append(h("div", "ai-inst-note err", S.usageError));
  } else if (S.activeProvider === "claude" && S.usageSyncing) {
    card.append(h("div", "ai-inst-note", tr("Sincronizando límites reales con Claude Code…")));
  }
}

export function fillScopeStrip(box: HTMLElement, ctx: EditorContext) {
  box.replaceChildren();
  const label = h("span", "ai-scope-lbl", tr("Alcance"));
  const pills = h("div", "ai-scope-pills");
  if (ctx.file) {
    pills.append(h("span", "ai-scope-item active", baseName(ctx.file)));
  } else {
    pills.append(h("span", "ai-scope-item", tr("Sin archivo activo")));
  }
  if (ctx.selection) {
    pills.append(h("span", "ai-scope-item sel", `L${ctx.selection.startLine}–${ctx.selection.endLine}`));
  }
  for (const ex of S.extraFiles) {
    if (ex !== ctx.file) pills.append(h("span", "ai-scope-item", baseName(ex)));
  }
  const add = h("button", "ai-scope-add", tr("+ Adjuntar"));
  add.type = "button";
  add.onclick = attachProjectFile;
  box.append(label, pills, add);
}

export function syncTelemetryViews() {
  renderFoot();
  const quota = q(".ai-inst-quota");
  if (quota) fillQuotaCard(quota);
}

export function usageRingRow(title: string, w: UsageWindow | undefined, emptyText: string): HTMLElement {
  const row = h("div", "ai-usage-row");
  const left = h("div", "ai-usage-row-left");
  left.append(h("span", "ai-usage-label", title));
  const cd = resetCountdown(w);
  const clock = resetClockText(w);
  const sub = cd && cd !== "ahora" ? tr("Se reinicia en {time}", { time: cd }) : clock || emptyText;
  left.append(h("span", "ai-usage-reset", sub));
  const right = h("div", "ai-usage-row-right");
  right.append(h("span", "ai-usage-pct", w ? `${remainingPercent(w)} disp.` : "—"), usageRing(w ? remainingRatio(w) : 0, 16));
  row.append(left, right);
  return row;
}

export function populateUsageContainer(pop: HTMLElement, onRefreshDone: () => void) {
  const prov = S.current?.convo.messages.length ? S.current.provider : S.activeProvider;
  pop.replaceChildren();
  const head = h("div", "ai-usage-pop-head");
  head.append(h("span", "ai-usage-group", tr("Uso")));
  const syncBtn = h("button", "ai-usage-sync", S.usageSyncing ? tr("Actualizando…") : tr("Actualizar"));
  syncBtn.type = "button";
  syncBtn.disabled = S.usageSyncing;
  syncBtn.onclick = () => {
    syncBtn.disabled = true;
    syncBtn.textContent = tr("Actualizando…");
    void syncAccountAndUsage().finally(onRefreshDone);
  };
  head.append(syncBtn);
  pop.append(head);

  const order: AiProvider[] = [
    prov,
    ...(["claude", "codex", "antigravity", "local", "cloud"] as const).filter((p) => p !== prov && !!tools[p]?.logged_in),
  ];
  for (const id of order) {
    const t = tools[id] ?? (id === prov ? S.tool : null);
    if (id === "antigravity") {
      if (S.agyUsage?.groups?.length) {
        for (const g of S.agyUsage.groups) {
          const sec = h("div", "ai-usage-section");
          sec.append(h("div", "ai-usage-sec-title", g.name));
          for (const b of g.buckets) {
            sec.append(usageRingRow(agyBucketLabel(b), agyWindowFromBucket(b), tr("Sin datos")));
          }
          pop.append(sec);
        }
      } else {
        const sec = h("div", "ai-usage-section");
        sec.append(h("div", "ai-usage-sec-title", "Antigravity"), h("div", "ai-usage-note", tr("Consultando límites de tu cuenta…")));
        pop.append(sec);
      }
      continue;
    }
    const sec = h("div", "ai-usage-section");
    if (id === "cloud") {
      sec.append(
        h("div", "ai-usage-sec-title", tr("Modelos en la nube")),
        h("div", "ai-usage-note", tr("Pagas a tu proveedor según los tokens usados. Cada respuesta muestra su coste.")),
      );
      pop.append(sec);
      continue;
    }
    if (id === "local") {
      // Un modelo local no tiene cuotas ni límites de plan.
      sec.append(
        h("div", "ai-usage-sec-title", "Ollama (local)"),
        h("div", "ai-usage-note", tr("Se ejecuta en este equipo: sin límites de uso.")),
      );
      pop.append(sec);
      continue;
    }
    if (id === "claude") {
      const cur = providerUsage("claude");
      const title = t?.plan ? "Claude Code · " + tr("Plan {plan}", { plan: planLabel(t.plan) }) : "Claude Code";
      sec.append(
        h("div", "ai-usage-sec-title", title),
        usageRingRow(tr("Límite semanal"), cur.sevenDay, S.usageSyncing ? tr("Consultando /usage…") : tr("Pendiente de lectura")),
        usageRingRow(tr("Límite 5 h"), cur.fiveHour, S.usageSyncing ? tr("Consultando /usage…") : tr("Pendiente de lectura")),
      );
      if (S.usageError) sec.append(h("div", "ai-usage-note err", S.usageError));
    } else {
      const cur = providerUsage("codex");
      const title =
        t?.plan && t.plan !== "ChatGPT" ? "ChatGPT / Codex · " + tr("Plan {plan}", { plan: planLabel(t.plan) }) : "ChatGPT / Codex";
      sec.append(
        h("div", "ai-usage-sec-title", title),
        usageRingRow(tr("Límite semanal"), cur.sevenDay, tr("Consultando app-server…")),
        usageRingRow(tr("Límite 5 h"), cur.fiveHour, tr("Consultando app-server…")),
      );
    }
    pop.append(sec);
  }

  const convo = S.current?.convo;
  if (convo && (convo.model || convo.outcome)) {
    const sess = h("div", "ai-usage-sess");
    if (convo.model) sess.append(h("div", "ai-usage-meta", tr("Modelo activo: {model}", { model: formatModelName(convo.model) })));
    if (convo.outcome?.durationMs)
      sess.append(h("div", "ai-usage-meta", tr("Último turno: {secs} s", { secs: seconds(convo.outcome.durationMs) })));
    if (convo.outcome && convo.outcome.costUsd > 0)
      sess.append(h("div", "ai-usage-meta", tr("Coste reportado: {cost}", { cost: "$" + convo.outcome.costUsd.toFixed(4) })));
    pop.append(sess);
  }
}

export function openUsagePopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-usage-pop");
  const fill = () =>
    populateUsageContainer(pop, () => {
      if (pop.isConnected) fill();
    });
  fill();
  openPopover(anchor, pop, "above");
  if (tools.claude?.logged_in || S.activeProvider === "claude") {
    void refreshUsage().finally(() => {
      if (pop.isConnected) fill();
    });
  }
  if (tools.codex?.logged_in || tools.antigravity?.logged_in) {
    void refreshExtraUsage().finally(() => {
      if (pop.isConnected) fill();
    });
  }
}

export function openQuickPromptsPopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-quick-pop");
  pop.append(h("div", "ai-pop-head", tr("Acciones rápidas")));
  for (const item of QUICK_PROMPTS) {
    const row = h("button", "ai-pop-item");
    row.type = "button";
    const left = h("span", "ai-pop-main");
    left.append(h("span", "ai-pop-name", item.label));
    row.append(left, h("span", "ai-pop-badge", item.tag));
    row.onclick = () => {
      dismissPopover();
      const inp = q<HTMLTextAreaElement>(".ai-input");
      if (!inp) return;
      inp.value = item.prompt;
      ctl.autosize();
      inp.focus();
    };
    pop.append(row);
  }
  openPopover(anchor, pop, "above");
}
