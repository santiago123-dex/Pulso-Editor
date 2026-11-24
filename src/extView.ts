import "./ext.css";
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { setStatus, showDialog } from "./ui";
import { h } from "./util";
import {
  contributesSummary,
  filterExtensions,
  formatInstallConsent,
  permissionLabel,
  type ExtensionManifest,
  type InstalledExtension,
} from "./extModel";

const inTauri = "__TAURI_INTERNALS__" in window;

interface InstallPreview {
  token: string;
  manifest: ExtensionManifest;
}

let extensions: InstalledExtension[] = [];
let query = "";

function renderExtensions() {
  const list = document.getElementById("ext-list");
  if (!list) return;
  list.innerHTML = "";
  const shown = filterExtensions(extensions, query);
  if (!shown.length) {
    list.append(
      h(
        "div",
        "ext-empty",
        extensions.length
          ? t("Ninguna extensión coincide con el filtro.")
          : t("No hay extensiones instaladas. Pulsa + para instalar una extensión declarativa desde una carpeta con manifest.json."),
      ),
    );
    return;
  }

  for (const item of shown) {
    const m = item.manifest;
    const card = h("div", `ext-card${item.enabled ? "" : " disabled"}`);
    const head = h("div", "ext-head");
    head.append(
      h("span", "ext-name", m.name),
      h("span", "ext-ver", `v${m.version}`),
      h("span", "ext-pill", item.enabled ? t("Activa") : t("Desactivada")),
    );
    card.append(head);
    if (m.description) card.append(h("div", "ext-desc", m.description));
    const summary = contributesSummary(m.contributes);
    if (summary) card.append(h("div", "ext-meta", summary));

    if (m.permissions.length) {
      const perms = h("div", "ext-perms");
      for (const p of m.permissions) {
        const badge = h("span", "ext-perm", p);
        badge.title = permissionLabel(p);
        perms.append(badge);
      }
      card.append(perms);
    }

    const actions = h("div", "ext-actions");
    const toggleBtn = h("button", "", item.enabled ? t("Desactivar") : t("Activar"));
    toggleBtn.type = "button";
    toggleBtn.onclick = async () => {
      if (!inTauri) return;
      try {
        await invoke("ext_set_enabled", { id: m.id, enabled: !item.enabled });
        await refreshExtensions();
      } catch (e) {
        setStatus(String(e), 5000);
      }
    };
    const removeBtn = h("button", "danger", t("Desinstalar"));
    removeBtn.type = "button";
    removeBtn.onclick = async () => {
      if (!inTauri) return;
      const r = await showDialog({
        title: t("Desinstalar extensión"),
        message: t("¿Quieres desinstalar «{name}» ({id})?", { name: m.name, id: m.id }),
        buttons: [
          { label: t("Cancelar"), value: "cancel" },
          { label: t("Desinstalar"), value: "remove", danger: true },
        ],
      });
      if (r !== "remove") return;
      try {
        await invoke("ext_uninstall", { id: m.id });
        setStatus(t("Extensión «{name}» desinstalada.", { name: m.name }), 4000);
        await refreshExtensions();
      } catch (e) {
        setStatus(String(e), 5000);
      }
    };
    actions.append(toggleBtn, removeBtn);
    card.append(actions);
    list.append(card);
  }
}

export async function refreshExtensions() {
  if (!inTauri) {
    renderExtensions();
    return;
  }
  try {
    extensions = await invoke<InstalledExtension[]>("ext_list");
  } catch (e) {
    setStatus(String(e), 5000);
  }
  renderExtensions();
}

export async function installExtensionFromFolder() {
  if (!inTauri) return;
  try {
    const preview = await invoke<InstallPreview | null>("ext_pick_for_install");
    if (!preview) return;
    const r = await showDialog({
      title: t("Instalar extensión"),
      message: formatInstallConsent(preview.manifest),
      buttons: [
        { label: t("Cancelar"), value: "cancel" },
        { label: t("Conceder permisos e instalar"), value: "install", primary: true },
      ],
    });
    if (r !== "install") return;
    const installed = await invoke<InstalledExtension>("ext_confirm_install", { token: preview.token });
    setStatus(t("Extensión «{name}» instalada.", { name: installed.manifest.name }), 4000);
    await refreshExtensions();
  } catch (e) {
    setStatus(String(e), 6000);
  }
}

export function setExtensionsVisible(on: boolean) {
  if (on) void refreshExtensions();
}

export function initExtensions() {
  const search = document.getElementById("ext-search") as HTMLInputElement | null;
  if (search) {
    search.oninput = () => {
      query = search.value;
      renderExtensions();
    };
  }
  const installBtn = document.getElementById("ext-install");
  if (installBtn) installBtn.onclick = () => void installExtensionFromFolder();
  const refreshBtn = document.getElementById("ext-refresh");
  if (refreshBtn) refreshBtn.onclick = () => void refreshExtensions();
  renderExtensions();
}
