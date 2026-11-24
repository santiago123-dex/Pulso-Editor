import { t } from "./i18n";
/** Estado visible del servidor de lenguaje: iniciando, activo, detenido o sin carpeta. */
export type LspState = { kind: "off" } | { kind: "starting" } | { kind: "ready"; servers?: string[] } | { kind: "stopped"; reason: string };

let state: LspState = { kind: "off" };
const subs = new Set<(s: LspState) => void>();

export const getLspState = (): LspState => state;
export const onLspState = (f: (s: LspState) => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

export function setLspState(next: LspState) {
  const same =
    next.kind === state.kind &&
    (next.kind !== "stopped" || (state.kind === "stopped" && state.reason === next.reason)) &&
    (next.kind !== "ready" || (state.kind === "ready" && (state.servers ?? []).join(",") === (next.servers ?? []).join(",")));
  state = next;
  if (!same) subs.forEach((f) => f(state));
}

/** Texto corto para la barra de estado. */
export function lspLabel(s: LspState): string {
  switch (s.kind) {
    case "off":
      return "";
    case "starting":
      return t("LSP: iniciando…");
    case "ready":
      return s.servers && s.servers.length > 1 ? `LSP: ${s.servers.join(", ")}` : t("LSP: activo");
    case "stopped":
      return t("LSP: detenido");
  }
}

/** Explicación completa para el diálogo que se abre al pulsar el indicador. */
export function lspDetail(s: LspState): string {
  switch (s.kind) {
    case "off":
      return t("No hay una carpeta abierta, así que el servidor de lenguaje no se inicia.");
    case "starting":
      return t("El servidor de TypeScript y JavaScript se está iniciando. Mientras tanto se usan los servicios integrados.");
    case "ready":
      return s.servers && s.servers.length > 1
        ? t("Servidores de lenguaje activos: {servers}. Diagnósticos, hover, definiciones y referencias vienen de ellos.", {
            servers: s.servers.join(", "),
          })
        : t("El servidor de TypeScript y JavaScript está activo: diagnósticos, hover, definiciones y referencias vienen de él.");
    case "stopped":
      return (
        t("El servidor se detuvo y se usan los servicios integrados, con menos precisión.") +
        "\n\n" +
        t("Motivo: {reason}", { reason: s.reason })
      );
  }
}
