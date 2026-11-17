/** Estado visible del servidor de lenguaje: iniciando, activo, detenido o sin carpeta. */
export type LspState =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "stopped"; reason: string };

let state: LspState = { kind: "off" };
const subs = new Set<(s: LspState) => void>();

export const getLspState = (): LspState => state;
export const onLspState = (f: (s: LspState) => void) => { subs.add(f); return () => { subs.delete(f); }; };

export function setLspState(next: LspState) {
  const same = next.kind === state.kind && (next.kind !== "stopped" || (state.kind === "stopped" && state.reason === next.reason));
  state = next;
  if (!same) subs.forEach((f) => f(state));
}

/** Texto corto para la barra de estado. */
export function lspLabel(s: LspState): string {
  switch (s.kind) {
    case "off": return "";
    case "starting": return "LSP: iniciando…";
    case "ready": return "LSP: activo";
    case "stopped": return "LSP: detenido";
  }
}

/** Explicación completa para el diálogo que se abre al pulsar el indicador. */
export function lspDetail(s: LspState): string {
  switch (s.kind) {
    case "off": return "No hay una carpeta abierta, así que el servidor de lenguaje no se inicia.";
    case "starting": return "El servidor de TypeScript y JavaScript se está iniciando. Mientras tanto se usan los servicios integrados.";
    case "ready": return "El servidor de TypeScript y JavaScript está activo: diagnósticos, hover, definiciones y referencias vienen de él.";
    case "stopped": return `El servidor se detuvo y se usan los servicios integrados, con menos precisión.\n\nMotivo: ${s.reason}`;
  }
}
