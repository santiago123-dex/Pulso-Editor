/** Pie del panel, mensajes de configuración y el inicio de sesión de cada herramienta. */

import { type AiProvider, planLabel, remainingPercent, remainingRatio, resetIn } from "../aiModel";
import { t as tr } from "../i18n";
import { runInTerminal } from "../terminal";
import { setStatus } from "../ui";
import { h } from "../util";
import { type AiTool, PROVIDERS } from "./catalog";
import { S, ctl, q, tools } from "./chatState";
import { usageRing } from "./popoverBase";
import { buildAccountsList } from "./popovers";
import { connectProvider } from "./providers";
import { openUsagePopover } from "./quota";
import { providerUsage, refreshUsage } from "./usageSync";
import { invoke } from "@tauri-apps/api/core";

export function usageText(): string {
  const prov = S.current?.convo.messages.length ? S.current.provider : S.activeProvider;
  const curTool = tools[prov] ?? S.tool;
  const curUsage = providerUsage(prov);
  const parts: string[] = [];
  if (curTool?.plan) parts.push(prov === "claude" ? tr("Plan {plan}", { plan: planLabel(curTool.plan) }) : `${PROVIDERS[prov].short} · ${planLabel(curTool.plan)}`);
  if (curUsage.fiveHour) parts.push(tr("5 h: {pct} disp.", { pct: remainingPercent(curUsage.fiveHour) }) + (resetIn(curUsage.fiveHour) ? ` (${resetIn(curUsage.fiveHour)})` : ""));
  if (curUsage.sevenDay) parts.push(tr("sem.: {pct} disp.", { pct: remainingPercent(curUsage.sevenDay) }));
  return parts.join(" · ");
}

export function renderFoot() {
  const foot = q(".ai-foot");
  if (!foot) return;
  const prov = S.current?.convo.messages.length ? S.current.provider : S.activeProvider;
  const curUsage = providerUsage(prov);
  const text = usageText();
  foot.replaceChildren();
  const hasWindows = !!(curUsage.fiveHour || curUsage.sevenDay);
  const ratioLeft = curUsage.fiveHour ? remainingRatio(curUsage.fiveHour) : curUsage.sevenDay ? remainingRatio(curUsage.sevenDay) : 1;
  const trigger = h("button", "ai-usage-btn");
  trigger.type = "button";
  trigger.title = tr("Ver límites disponibles del plan");
  const pctText = curUsage.fiveHour ? tr("{pct} disp.", { pct: remainingPercent(curUsage.fiveHour) }) : curUsage.sevenDay ? tr("{pct} sem.", { pct: remainingPercent(curUsage.sevenDay) }) : tr("Ver uso");
  trigger.append(usageRing(hasWindows ? ratioLeft : 0, 14), h("span", "", pctText));
  trigger.onclick = () => openUsagePopover(trigger);

  if (!text || !hasWindows) {
    foot.append(h("span", "ai-foot-text", `${text ? `${text} · ` : ""}${tr("Usa tu sesión de {provider}", { provider: PROVIDERS[prov].title })}`), trigger);
    return;
  }
  const bars = h("span", "ai-meters");
  for (const w of [curUsage.fiveHour, curUsage.sevenDay]) {
    if (!w) continue;
    const rem = remainingRatio(w);
    const m = h("span", "ai-meter");
    const f = h("span", `ai-meter-fill${rem <= 0.1 ? " high" : ""}`);
    f.style.width = `${Math.round(rem * 100)}%`;
    m.append(f);
    bars.append(m);
  }
  foot.append(bars, h("span", "ai-foot-text", text), trigger);
}

export function setupMessage(title: string, text: string, ...extra: HTMLElement[]): HTMLElement {
  const box = h("div", "ai-setup");
  const card = h("div", "ai-setup-card");
  const mark = h("div", "ai-hero-icon");
  mark.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 10l3 2-3 2M13 15h3"/></svg>';
  card.append(mark, h("div", "ai-setup-title", title), h("p", "", text));
  if (extra.length) {
    const actions = h("div", "ai-setup-actions");
    actions.append(...extra);
    card.append(actions);
  }
  const accts = h("div", "ai-setup-accts");
  accts.append(h("div", "ai-inst-kicker", tr("Tus cuentas y suscripciones")), buildAccountsList());
  card.append(accts);
  box.append(card);
  return box;
}

export async function detectProviderNow(prov: AiProvider) {
  try {
    const next = await invoke<AiTool>("ai_detect_provider", { provider: prov }).catch(() => null);
    if (!next) { await ctl.detect(true); return; }
    const wasInstalled = !!tools[prov]?.installed;
    const wasLogged = !!tools[prov]?.logged_in;
    tools[prov] = next;
    if (prov === S.activeProvider) S.tool = next;
    if (next.logged_in) {
      S.awaitingLogin = false;
      window.clearInterval(S.loginWatchTimer);
      if (!wasLogged) setStatus(tr("{provider} conectado", { provider: PROVIDERS[prov].title }), 4000);
      if (prov === "claude") void refreshUsage();
      void ctl.detect(true);
    }
    if (S.shown && (next.logged_in || next.installed !== wasInstalled)) ctl.renderBody();
  } catch { /* reintento en el siguiente tick */ }
}

export function watchLogin(prov: AiProvider, intervalMs = 1000) {
  S.awaitingLogin = true;
  S.loginProvider = prov;
  const started = Date.now();
  window.clearInterval(S.loginWatchTimer);
  S.loginWatchTimer = window.setInterval(() => {
    if (!S.awaitingLogin || tools[prov]?.logged_in || Date.now() - started > 600_000) {
      S.awaitingLogin = false;
      window.clearInterval(S.loginWatchTimer);
      return;
    }
    void detectProviderNow(prov);
  }, intervalMs);
}

export function startLoginFlow(prov: AiProvider = S.activeProvider) {
  // Los modelos en la nube no tienen inicio de sesión: se conecta un proveedor pegando su clave.
  if (prov === "cloud") { connectProvider(() => { S.toolAt = 0; void ctl.detect(true); }); return; }
  watchLogin(prov, 1000);
  void runInTerminal(PROVIDERS[prov].loginCmd);
}
