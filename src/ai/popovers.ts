/** Popovers de cuentas y de modelo: pestañas de proveedor, lista de cuentas e instalar y conectar. */

import { type AiProvider, planLabel } from "../aiModel";
import { writeStorage } from "../core/storage";
import { openExternal } from "../external";
import { t as tr } from "../i18n";
import { state } from "../settings";
import { listShells, runInTerminal } from "../terminal";
import { promptText, showDialog } from "../ui";
import { h } from "../util";
import { startLoginFlow, watchLogin } from "./accountView";
import { type AiTool, EFFORTS, type ModelOption, PROVIDERS } from "./catalog";
import { S, ctl, tools } from "./chatState";
import { ICON_GAUGE } from "./icons";
import { providerCatalog, syncModelButton } from "./modelOptions";
import { dismissPopover, openPopover } from "./popoverBase";
import { populateUsageContainer, syncAccountAndUsage } from "./quota";

export function buildProviderTabs(onPick?: (p: AiProvider) => void): HTMLElement {
  const bar = h("div", "ai-prov-tabs");
  for (const id of ["claude", "codex", "antigravity", "local", "cloud"] as const) {
    const t = tools[id];
    const dotCls = t?.logged_in ? "on" : t?.installed ? "wait" : "off";
    const btn = h("button", `ai-prov-tab${S.activeProvider === id ? " active" : ""}`);
    btn.type = "button";
    btn.title = t?.logged_in ? tr("{provider} conectado", { provider: PROVIDERS[id].title }) : t?.installed ? tr("{provider}: falta iniciar sesión", { provider: PROVIDERS[id].title }) : tr("{provider}: sin instalar", { provider: PROVIDERS[id].title });
    btn.append(h("span", `ai-prov-dot ${dotCls}`, ""), h("span", "", PROVIDERS[id].short));
    btn.onclick = () => {
      ctl.switchProvider(id);
      onPick?.(id);
    };
    bar.append(btn);
  }
  return bar;
}

export function accountStatusText(id: AiProvider, t: AiTool | null): string {
  if (!t) return tr("Comprobando sesión…");
  const meta = PROVIDERS[id];
  const installable = !!(meta.npmPkg || meta.installCmdPs);
  if (!t.installed) return installable ? tr("CLI sin instalar · instalable aquí") : tr("CLI sin instalar");
  if (!t.logged_in) return t.error ? tr("Instalado · no se pudo comprobar la sesión") : tr("Instalado · falta iniciar sesión");
  if (id === "claude") return t.plan ? tr("Conectado · Plan {plan}", { plan: planLabel(t.plan) }) : tr("Conectado · Suscripción Claude");
  if (id === "codex") {
    if (t.auth_method === "chatgpt") return t.plan && t.plan !== "ChatGPT" ? tr("Conectado · Plan {plan}", { plan: planLabel(t.plan) }) : tr("Conectado · Suscripción ChatGPT");
    if (t.auth_method === "api_key") return tr("Conectado · Clave API");
    return tr("Conectado · ChatGPT");
  }
  return tr("Conectado · Cuenta Antigravity");
}

export async function installAndConnect(prov: AiProvider, onDone?: () => void) {
  const meta = PROVIDERS[prov];
  const shells = await listShells().catch(() => []);
  const sh = shells.find((s) => s.id === state.settings.terminalShell) ?? shells[0];
  const ps = sh ? /powershell|pwsh/i.test(`${sh.id} ${sh.path}`) : true;
  let cmd = "";
  if (meta.installCmdPs || meta.installCmdSh) {
    cmd = ps ? (meta.installCmdPs ?? meta.installCmdSh ?? "") : (meta.installCmdSh ?? meta.installCmdPs ?? "");
    if (cmd && meta.loginCmd) {
      cmd = ps
        ? prov === "local"
          // Tras instalar, la terminal abierta aún no tiene Ollama en el PATH: se usa su ruta.
          ? `${cmd}; if ($?) { & "$env:LOCALAPPDATA\\Programs\\Ollama\\ollama.exe" pull qwen2.5-coder:7b }`
          : `${cmd}; if ($?) { $agy = "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"; if (Test-Path $agy) { & $agy acp --login } }`
        : `${cmd} && ${meta.loginCmd}`;
    }
  } else if (meta.npmPkg) {
    cmd = ps
      ? `npm install -g ${meta.npmPkg}; if ($?) { ${meta.loginCmd} }`
      : `npm install -g ${meta.npmPkg} && ${meta.loginCmd}`;
  }
  if (!cmd) { void openExternal(meta.docsUrl); return; }
  const r = await showDialog({
    title: tr("Instalar y conectar {account}", { account: meta.accountTitle }),
    message: tr("Se ejecutará en la terminal integrada:") + "\n" + cmd + "\n\n" + tr("Pulso no pide ni guarda claves: iniciarás sesión directamente en la herramienta oficial."),
    buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Instalar y conectar"), value: "ok", primary: true }],
  });
  if (r !== "ok") return;
  onDone?.();
  ctl.switchProvider(prov);
  watchLogin(prov, 1000);
  void runInTerminal(cmd);
}

export function buildAccountsList(onClose?: () => void): HTMLElement {
  const list = h("div", "ai-acct-list");
  for (const id of ["claude", "codex", "antigravity", "local", "cloud"] as const) {
    const meta = PROVIDERS[id];
    const t = tools[id];
    const isCurrent = S.activeProvider === id;
    const dotCls = t?.logged_in ? "on" : t?.installed ? "wait" : "off";
    const row = h("div", `ai-acct-row${isCurrent ? " active" : ""}`);
    const info = h("div", "ai-acct-info");
    const top = h("div", "ai-acct-top");
    top.append(h("span", `ai-prov-dot ${dotCls}`, ""), h("span", "ai-acct-name", meta.accountTitle));
    info.append(top, h("div", "ai-acct-sub", accountStatusText(id, t)));
    row.append(info);

    const canInstall = !!(meta.npmPkg || meta.installCmdPs);
    if (!t?.installed) {
      const btn = h("button", "ai-acct-btn", canInstall ? tr("Instalar y conectar") : tr("Cómo instalar"));
      btn.type = "button";
      btn.onclick = () => {
        if (canInstall) void installAndConnect(id, onClose);
        else void openExternal(meta.docsUrl);
      };
      row.append(btn);
    } else if (!t.logged_in) {
      const btn = h("button", "ai-acct-btn primary", tr("Conectar"));
      btn.type = "button";
      btn.onclick = () => {
        onClose?.();
        ctl.switchProvider(id);
        startLoginFlow(id);
      };
      row.append(btn);
    } else if (isCurrent) {
      row.append(h("span", "ai-acct-badge", tr("En uso")));
    } else {
      const btn = h("button", "ai-acct-btn", tr("Usar"));
      btn.type = "button";
      btn.onclick = () => {
        ctl.switchProvider(id);
        onClose?.();
      };
      row.append(btn);
    }
    list.append(row);
  }
  return list;
}

export function openAccountsPopover(anchor: HTMLElement) {
  const pop = h("div", "ai-popover ai-acct-pop");
  const render = () => {
    pop.replaceChildren();
    const head = h("div", "ai-usage-pop-head");
    head.append(h("span", "ai-usage-group", tr("Cuentas y suscripciones")));
    const checkBtn = h("button", "ai-usage-sync", tr("Comprobar"));
    checkBtn.type = "button";
    checkBtn.onclick = () => {
      checkBtn.disabled = true;
      checkBtn.textContent = tr("Comprobando…");
      S.toolAt = 0;
      void ctl.detect(true).finally(() => { if (pop.isConnected) render(); });
    };
    head.append(checkBtn);
    pop.append(
      head,
      h("div", "ai-usage-note", tr("Cada proveedor administra su sesión en su CLI oficial. Pulso detecta cuáles tienes activas para habilitar sus modelos.")),
      buildAccountsList(() => dismissPopover()),
    );
  };
  render();
  openPopover(anchor, pop, "below");
}


export function openModelPopover(anchor: HTMLElement) {
  const dockWrap = h("div", "ai-popover-pair");
  const pop = h("div", "ai-popover ai-model-pop");
  pop.setAttribute("role", "listbox");
  pop.setAttribute("aria-label", tr("Seleccionar proveedor y modelo"));
  const sideUsage = h("div", "ai-popover ai-usage-pop ai-usage-docked");
  sideUsage.hidden = true;
  dockWrap.append(pop, sideUsage);

  let specificOpen = providerCatalog(S.activeProvider).specific.some((m) => m.value === S.model);
  let usageSideOpen = false;

  const syncSidePosition = () => {
    const ar = anchor.getBoundingClientRect();
    const dr = dockWrap.getBoundingClientRect();
    const left = Math.max(8, Math.min(ar.left, window.innerWidth - dr.width - 8));
    const top = Math.max(8, ar.top - dr.height - 6);
    dockWrap.style.left = `${left}px`;
    dockWrap.style.top = `${top}px`;
  };

  const renderSideUsage = () => {
    if (!usageSideOpen) { sideUsage.hidden = true; return; }
    sideUsage.hidden = false;
    populateUsageContainer(sideUsage, () => { if (dockWrap.isConnected && usageSideOpen) renderSideUsage(); });
    requestAnimationFrame(() => { if (dockWrap.isConnected) syncSidePosition(); });
  };

  const openSideUsage = () => {
    if (usageSideOpen) return;
    usageSideOpen = true;
    renderSideUsage();
    void syncAccountAndUsage().finally(() => { if (dockWrap.isConnected && usageSideOpen) renderSideUsage(); });
  };

  const render = () => {
    const meta = PROVIDERS[S.activeProvider];
    const cat = providerCatalog(S.activeProvider);
    pop.replaceChildren();
    pop.append(h("div", "ai-pop-head", tr("Herramienta")), buildProviderTabs(() => {
      const target = tools[S.activeProvider];
      if (target && !target.logged_in) { dismissPopover(); return; }
      specificOpen = providerCatalog(S.activeProvider).specific.some((m) => m.value === S.model);
      syncModelButton();
      render();
      if (usageSideOpen) renderSideUsage();
    }));
    pop.append(h("div", "ai-pop-sep"), h("div", "ai-pop-head", tr("Modelo · {provider}", { provider: meta.short })));

    const listBox = h("div", "ai-model-list");
    const addOption = (m: ModelOption) => {
      const active = m.value === S.model;
      const row = h("button", `ai-pop-item${active ? " active" : ""}`);
      row.type = "button";
      row.title = m.hint;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(active));
      const left = h("span", "ai-pop-main");
      left.append(h("span", "ai-pop-name", m.label));
      if (m.tier) left.append(h("span", "ai-pop-tier", m.tier));
      if (m.badge) left.append(h("span", "ai-pop-badge", m.badge));
      row.append(left, h("span", "ai-pop-check", active ? "✓" : ""));
      row.onclick = () => {
        S.model = m.value;
        writeStorage(meta.modelKey, S.model);
        dismissPopover();
        syncModelButton();
      };
      listBox.append(row);
    };

    for (const m of cat.models) addOption(m);

    if (cat.specific.length > 0) {
      const toggleSpec = h("button", "ai-pop-item ai-pop-subtoggle");
      toggleSpec.type = "button";
      const toggleMain = h("span", "ai-pop-main");
      toggleMain.append(h("span", "ai-pop-name", tr("Más modelos ({count})", { count: cat.specific.length })));
      toggleSpec.append(toggleMain, h("span", "ai-pop-chev", specificOpen ? "▾" : "›"));
      toggleSpec.onclick = () => { specificOpen = !specificOpen; render(); };
      listBox.append(h("div", "ai-pop-sep"), toggleSpec);
      if (specificOpen) for (const m of cat.specific) addOption(m);
    }

    const custom = h("button", "ai-pop-item ai-pop-custom");
    custom.type = "button";
    const customMain = h("span", "ai-pop-main");
    customMain.append(h("span", "ai-pop-name", tr("Otro ID de modelo…")), h("span", "ai-pop-tier", tr("Manual")));
    custom.append(customMain);
    custom.onclick = async () => {
      dismissPopover();
      const entered = await promptText({ title: tr("Identificador exacto del modelo"), value: S.model, placeholder: cat.models[1]?.value ?? "modelo" });
      if (!entered) return;
      S.model = entered.trim();
      writeStorage(meta.modelKey, S.model);
      syncModelButton();
    };
    listBox.append(custom);
    pop.append(listBox);

    if (meta.supportsEffort && (S.activeProvider !== "antigravity" || !S.model)) {
      const effBox = h("div", "ai-pop-effort");
      effBox.append(h("span", "ai-pop-effort-lbl", tr("Esfuerzo")));
      const pills = h("div", "ai-effort-pills");
      for (const e of EFFORTS) {
        const b = h("button", `ai-effort-pill${S.effort === e.value ? " active" : ""}`, e.label);
        b.type = "button";
        b.onclick = () => {
          S.effort = e.value;
          writeStorage("pulso.ai.effort", S.effort);
          syncModelButton();
          render();
        };
        pills.append(b);
      }
      effBox.append(pills);
      pop.append(h("div", "ai-pop-sep"), effBox);
    }

    const viewUsage = h("button", `ai-pop-item ai-pop-usage-link${usageSideOpen ? " active" : ""}`);
    viewUsage.type = "button";
    const usageMain = h("span", "ai-pop-main");
    const gIcon = h("span", "ai-pop-gauge");
    gIcon.innerHTML = ICON_GAUGE;
    usageMain.append(gIcon, h("span", "ai-pop-name", tr("Ver uso y límites")));
    viewUsage.setAttribute("aria-expanded", String(usageSideOpen));
    viewUsage.append(usageMain, h("span", "ai-pop-chev", "›"));
    viewUsage.onclick = () => {
      if (usageSideOpen) { usageSideOpen = false; renderSideUsage(); render(); }
      else { openSideUsage(); render(); }
    };

    const manage = h("button", "ai-pop-item ai-pop-subtoggle");
    manage.type = "button";
    const manageMain = h("span", "ai-pop-main");
    manageMain.append(h("span", "ai-pop-name", tr("Cuentas y suscripciones…")));
    manage.append(manageMain, h("span", "ai-pop-chev", "›"));
    manage.onclick = () => openAccountsPopover(anchor);
    pop.append(h("div", "ai-pop-sep"), viewUsage, manage);
    requestAnimationFrame(() => { if (dockWrap.isConnected) syncSidePosition(); });
  };

  render();
  openPopover(anchor, dockWrap, "above");
}
