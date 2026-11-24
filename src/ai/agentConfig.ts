/**
 * «Qué carga el agente de este proyecto»: instrucciones (AGENTS.md, CLAUDE.md), skills, subagentes y comandos propios, con el
 * archivo de donde sale cada uno. Se pueden abrir para editarlos; los de la carpeta personal solo se muestran.
 */
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { openFile } from "../groups";
import { quickPick, setStatus, type PickItem } from "../ui";
import { ws } from "../workspace";

export interface ConfigEntry {
  kind: "instruction" | "skill" | "agent" | "command";
  name: string;
  description: string;
  path: string;
  user: boolean;
  /** Del proyecto y sin cargar: la persona todavía no confió en él. */
  blocked?: boolean;
}

const ORDER: ConfigEntry["kind"][] = ["instruction", "skill", "agent", "command"];

export function kindLabel(kind: ConfigEntry["kind"]): string {
  switch (kind) {
    case "instruction": return tr("Instrucciones");
    case "skill": return tr("Skill");
    case "agent": return tr("Subagente");
    default: return tr("Comando");
  }
}

/** De dónde sale: el proyecto, la carpeta personal o el propio Pulso (subagentes integrados). */
export function originLabel(e: ConfigEntry): string {
  if (!e.path) return tr("integrado");
  return e.user ? tr("personal") : tr("proyecto");
}

/** Ordena por tipo (instrucciones, skills, subagentes, comandos) y por nombre; lo del proyecto antes que lo personal. */
export function sortConfig(list: readonly ConfigEntry[]): ConfigEntry[] {
  return [...list].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || Number(a.user) - Number(b.user) || a.name.localeCompare(b.name));
}

export function configSummary(list: readonly ConfigEntry[]): string {
  const n = (k: ConfigEntry["kind"]) => list.filter((e) => e.kind === k).length;
  return tr("{i} instrucciones · {s} skills · {a} subagentes · {c} comandos", { i: n("instruction"), s: n("skill"), a: n("agent"), c: n("command") });
}

export async function showAgentConfig(): Promise<void> {
  if (!ws.root) { setStatus(tr("Abre una carpeta de proyecto primero."), 5000); return; }
  const root = ws.root;
  quickPick({
    placeholder: tr("Lo que carga el agente en este proyecto (instrucciones, skills, subagentes y comandos)"),
    empty: tr("No hay nada configurado. Crea un AGENTS.md o una carpeta .pulso/skills."),
    load: async () => {
      let list: ConfigEntry[];
      try {
        list = await invoke<ConfigEntry[]>("agent_config", { cwd: root });
      } catch (e) {
        setStatus(tr("No se pudo leer la configuración del agente: {error}", { error: String(e) }), 8000);
        return [];
      }
      const items = sortConfig(list).map<PickItem>((e) => ({
        label: `${kindLabel(e.kind)} · ${e.name}`,
        detail: e.blocked ? tr("Del proyecto: no se carga hasta que confíes en él") : `${originLabel(e)}${e.description ? ` · ${e.description}` : ""}`,
        keywords: `${e.kind} ${e.name} ${e.description}`,
        run: () => {
          if (e.path && !e.user) void openFile(e.path);
          else if (e.path) setStatus(e.path, 8000);
        },
      }));
      if (list.some((e) => e.blocked)) {
        items.unshift({ label: tr("Confiar en este proyecto…"), detail: tr("Sin confianza no se carga nada del proyecto"), keywords: "confiar confianza trust", run: () => void trustProject() });
      }
      return items;
    },
  });
}

/** Pregunta (con un diálogo nativo que abre Rust) si se confía en los autores del proyecto abierto. */
export async function trustProject(): Promise<void> {
  if (!ws.root) { setStatus(tr("Abre una carpeta de proyecto primero."), 5000); return; }
  try {
    const ok = await invoke<boolean>("project_trust_request", { cwd: ws.root });
    if (ok) setStatus(tr("Confías en este proyecto"), 5000);
  } catch (e) {
    setStatus(tr("No se pudo guardar la confianza en la carpeta.") + " " + String(e), 8000);
  }
}

/**
 * Al abrir un proyecto, avisa si trae instrucciones para la IA (AGENTS.md, skills, subagentes o comandos) que no se cargan porque
 * todavía no se confió en él. Es solo un aviso en la barra de estado: no abre ningún diálogo ni cambia nada.
 */
export async function noticeUntrustedProject(root: string): Promise<void> {
  try {
    const list = await invoke<ConfigEntry[]>("agent_config", { cwd: root });
    if (ws.root !== root || !list.some((e) => e.blocked)) return;
    setStatus(tr("Este proyecto trae instrucciones para la IA que no se cargan hasta que confíes en él (IA: Confiar en este proyecto…)"), 12000);
  } catch {
    /* sin aviso: la configuración no se pudo leer */
  }
}
