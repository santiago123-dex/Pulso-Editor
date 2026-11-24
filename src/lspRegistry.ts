/** Registro puro de servidores de lenguaje (LSP) soportados por Pulso. Sin DOM ni IPC. */
export type LspServerId = "typescript" | "python" | "rust" | "go" | "cpp";

export interface LspTarget {
  server: LspServerId;
  /** Identificador LSP `textDocument.languageId`. */
  languageId: string;
}

export const LSP_MONACO_LANGUAGES: readonly string[] = ["typescript", "javascript", "python", "rust", "go", "c", "cpp"];

export const LSP_SERVER_SHORT: Record<LspServerId, string> = {
  typescript: "TS",
  python: "Python",
  rust: "Rust",
  go: "Go",
  cpp: "C/C++",
};

export const LSP_SERVER_LABEL: Record<LspServerId, string> = {
  typescript: "TypeScript / JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  cpp: "C / C++",
};

/** Resuelve qué servidor LSP y `languageId` corresponden a una ruta de archivo, o `null` si no tiene LSP. */
export function lspTargetForPath(rawPath: string): LspTarget | null {
  const p = rawPath.toLowerCase();
  if (/\.tsx$/.test(p)) return { server: "typescript", languageId: "typescriptreact" };
  if (/\.(ts|mts|cts)$/.test(p)) return { server: "typescript", languageId: "typescript" };
  if (/\.jsx$/.test(p)) return { server: "typescript", languageId: "javascriptreact" };
  if (/\.(js|mjs|cjs)$/.test(p)) return { server: "typescript", languageId: "javascript" };
  if (/\.pyi?$/.test(p)) return { server: "python", languageId: "python" };
  if (/\.rs$/.test(p)) return { server: "rust", languageId: "rust" };
  if (/\.go$/.test(p)) return { server: "go", languageId: "go" };
  if (/\.(c|h)$/.test(p)) return { server: "cpp", languageId: "c" };
  if (/\.(cpp|cc|cxx|hpp|hh|hxx)$/.test(p)) return { server: "cpp", languageId: "cpp" };
  return null;
}

/** Propietario de marcadores de Monaco para un servidor (conserva `pulso-lsp` para TypeScript). */
export const lspMarkerOwner = (server: LspServerId) => (server === "typescript" ? "pulso-lsp" : `pulso-lsp-${server}`);
