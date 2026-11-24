import { describe, expect, it } from "vitest";
import { contributesSummary, filterExtensions, formatInstallConsent, permissionLabel, type InstalledExtension } from "./extModel";

const sample: InstalledExtension = {
  enabled: true,
  dir: "/ext/pulso.aurora",
  manifest: {
    id: "pulso.aurora",
    name: "Tema Aurora",
    version: "1.0.0",
    description: "Paleta oscura",
    author: "Pulso",
    permissions: ["files", "terminal"],
    contributes: {
      themes: [{ id: "a", label: "Aurora", path: "themes/a.json" }],
      snippets: [],
      commands: [{ id: "c", title: "Run", script: "echo hi" }],
      languageServers: [],
    },
  },
};

describe("extModel", () => {
  it("traduce permisos y resume aportes de la extensión", () => {
    expect(permissionLabel("files")).toBe("Archivos del proyecto");
    expect(permissionLabel("terminal")).toBe("Terminal y comandos externos");
    expect(contributesSummary(sample.manifest.contributes)).toContain("1 tema(s)");
    expect(contributesSummary(sample.manifest.contributes)).toContain("1 comando(s)");
  });

  it("construye el mensaje de consentimiento con permisos explícitos", () => {
    const msg = formatInstallConsent(sample.manifest);
    expect(msg).toContain("Tema Aurora v1.0.0");
    expect(msg).toContain("Archivos del proyecto (files)");
    expect(msg).toContain("Terminal y comandos externos (terminal)");
  });

  it("filtra extensiones por nombre, id o descripción", () => {
    expect(filterExtensions([sample], "")).toHaveLength(1);
    expect(filterExtensions([sample], "aurora")).toHaveLength(1);
    expect(filterExtensions([sample], "inexistente")).toHaveLength(0);
  });
});
