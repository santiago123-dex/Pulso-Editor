/** Lógica pura de la vista de Extensiones (permisos, filtrado y resumen de aportes). */
import { t } from "./i18n";

export interface ExtensionContributes {
  themes: { id: string; label: string; path: string }[];
  snippets: { language: string; path: string }[];
  commands: { id: string; title: string; script: string }[];
  languageServers: { language: string; command: string; args: string[] }[];
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  contributes: ExtensionContributes;
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  enabled: boolean;
  dir: string;
}

export function permissionLabel(perm: string): string {
  switch (perm) {
    case "files":
      return t("Archivos del proyecto");
    case "network":
      return t("Acceso a la red");
    case "terminal":
      return t("Terminal y comandos externos");
    default:
      return perm;
  }
}

export function formatInstallConsent(m: ExtensionManifest): string {
  const perms = m.permissions.length
    ? m.permissions.map((p) => `• ${permissionLabel(p)} (${p})`).join("\n")
    : t("• Sin permisos especiales");
  const summary = contributesSummary(m.contributes);
  return [
    `${m.name} v${m.version} (${m.id})`,
    m.description ? `\n${m.description}` : "",
    summary ? `\n${t("Aporta:")} ${summary}` : "",
    `\n${t("Permisos solicitados:")}\n${perms}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function contributesSummary(c: ExtensionContributes): string {
  const parts: string[] = [];
  if (c.themes.length) parts.push(t("{count} tema(s)", { count: c.themes.length }));
  if (c.snippets.length) parts.push(t("{count} fragmento(s)", { count: c.snippets.length }));
  if (c.commands.length) parts.push(t("{count} comando(s)", { count: c.commands.length }));
  if (c.languageServers.length) parts.push(t("{count} servidor(es) LSP", { count: c.languageServers.length }));
  return parts.join(" · ");
}

export function filterExtensions(list: readonly InstalledExtension[], query: string): InstalledExtension[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((item) => {
    const m = item.manifest;
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.description.toLowerCase().includes(q);
  });
}
