// Ajustes que Pulso da al servidor de lenguaje cuando los pide con `workspace/configuration`.
// El servidor nativo de TypeScript 7 lee las secciones `js/ts`, `typescript` y `javascript` con el
// mismo formato que VS Code; sin ellas no devuelve indicaciones en línea (inlay hints).

const tsSettings = {
  inlayHints: {
    parameterNames: { enabled: "literals", suppressWhenArgumentMatchesName: true },
    enumMemberValues: { enabled: true },
  },
};

export function lspConfiguration(section: unknown): object {
  return section === "js/ts" || section === "typescript" || section === "javascript" ? tsSettings : {};
}

/** Versión de un documento al pedir sus diagnósticos: si cambió mientras tanto, la respuesta ya no vale. */
export function diagnosticsStillValid(requestedVersion: number, currentVersion: number, disposed: boolean): boolean {
  return !disposed && requestedVersion === currentVersion;
}
