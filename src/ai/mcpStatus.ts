/**
 * «IA: Servidores MCP…»: qué servidores MCP hay configurados para el agente, si arrancan y qué herramientas ofrece cada uno.
 * Al abrirla, Rust arranca un momento cada servidor (los del proyecto solo si se confía en él) y lo cierra.
 */
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { openFile } from "../groups";
import { quickPick, setStatus, type PickItem } from "../ui";
import { ws } from "../workspace";
import { trustProject } from "./agentConfig";

export interface McpToolInfo {
  name: string;
  description: string;
}
export interface McpServer {
  name: string;
  /** El programa y sus argumentos, sin variables de entorno. */
  command: string;
  /** Del proyecto (`.pulso/mcp.json`), no de la carpeta personal. */
  project: boolean;
  state: "ok" | "error" | "blocked";
  error: string;
  tools: McpToolInfo[];
}
export interface McpStatus {
  servers: McpServer[];
  personal_file: string;
  project_file: string;
}

/** Una línea con el estado: «Conectado · 3 herramientas», «No arrancó», «Bloqueado…». */
export function stateText(s: McpServer): string {
  if (s.state === "blocked") return tr("Bloqueado: es del proyecto y no se arranca hasta que confíes en él");
  if (s.state === "error") return tr("No arrancó");
  return s.tools.length === 1 ? tr("Conectado · 1 herramienta") : tr("Conectado · {n} herramientas", { n: s.tools.length });
}

/** Cómo se pinta un servidor en la lista. El error (si lo hay) va en el detalle, recortado a su primera línea. */
export function describeServer(s: McpServer): { label: string; detail: string } {
  const origin = s.project ? tr("proyecto") : tr("personal");
  const firstError = s.error.split("\n")[0].trim();
  const parts = [stateText(s), origin, s.command];
  if (s.state === "error" && firstError) parts.splice(1, 0, firstError.length > 140 ? `${firstError.slice(0, 140)}…` : firstError);
  return { label: s.name, detail: parts.join(" · ") };
}

/** Servidores primero los que funcionan, luego los que fallan y al final los bloqueados; por nombre dentro de cada grupo. */
export function sortServers(list: readonly McpServer[]): McpServer[] {
  const rank = { ok: 0, error: 1, blocked: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

function showTools(s: McpServer): void {
  quickPick({
    placeholder: tr("Herramientas de {name}", { name: s.name }),
    empty: tr("Este servidor no ofrece herramientas."),
    load: () =>
      s.tools.map<PickItem>((t) => ({ label: t.name, detail: t.description, keywords: `${t.name} ${t.description}`, run: () => {} })),
  });
}

export async function showMcpServers(): Promise<void> {
  if (!ws.root) {
    // Sin carpeta no hay nada que arrancar (los servidores se arrancan en la carpeta del proyecto). Se dice en la propia lista, no en la
    // barra de estado, que es fácil de no ver.
    quickPick({
      placeholder: tr("Servidores MCP del agente (los configurados en mcp.json)"),
      empty: tr("Abre una carpeta de proyecto para ver sus servidores MCP (se arrancan en esa carpeta)."),
      load: () => [],
    });
    return;
  }
  const root = ws.root;
  quickPick({
    placeholder: tr("Servidores MCP del agente (los configurados en mcp.json)"),
    empty: tr(
      "No hay servidores MCP configurados. Escríbelos en ~/.pulso/mcp.json (los tuyos) o en .pulso/mcp.json (del proyecto): ver docs/AGENTE.md.",
    ),
    load: async () => {
      let status: McpStatus;
      try {
        status = await invoke<McpStatus>("agent_mcp_status", { cwd: root });
      } catch (e) {
        setStatus(tr("No se pudo leer la configuración MCP: {error}", { error: String(e) }), 8000);
        return [];
      }
      const items = sortServers(status.servers).map<PickItem>((s) => {
        const d = describeServer(s);
        return {
          label: d.label,
          detail: d.detail,
          keywords: `${s.name} ${s.command} ${s.state}`,
          run: () => {
            if (s.state === "blocked") {
              void trustProject();
              return;
            }
            if (s.state === "ok") {
              showTools(s);
              return;
            }
            // Con un error: se muestra completo y, si el servidor es del proyecto, se abre su archivo para corregirlo.
            setStatus(s.error || tr("No arrancó"), 12000);
            if (s.project) void openFile(status.project_file).catch(() => {});
            else setStatus(`${s.error || tr("No arrancó")} (${status.personal_file})`, 12000);
          },
        };
      });
      if (status.servers.some((s) => s.state === "blocked")) {
        items.unshift({
          label: tr("Confiar en este proyecto…"),
          detail: tr("Sin confianza no se arrancan los servidores MCP del proyecto"),
          keywords: "confiar confianza trust",
          run: () => void trustProject(),
        });
      }
      return items;
    },
  });
}
