/**
 * Modelo puro del flujo unificado de trabajo:
 *   Issue (Kanban / Issues) → Rama Git → Contexto IA → Diff Review interactivo → Pull Request.
 * Sin DOM ni IPC: 100% determinista y testeable.
 */

export interface WorkflowIssueRef {
  number: number;
  title: string;
  body?: string | null;
  labels?: { name: string }[];
  html_url?: string;
}

export interface ActiveIssueWork {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  branch: string;
  html_url: string;
  startedAt: number;
}

export interface ProposedFileEdit {
  /** Ruta relativa normalizada con `/` (sin `..` ni prefijos absolutos). */
  path: string;
  /** Lenguaje sugerido por el bloque Markdown (si se indicó). */
  lang: string;
  /** Contenido completo propuesto para el archivo. */
  content: string;
}

export interface PrDraft {
  title: string;
  body: string;
  head: string;
  base: string;
}

/** Valida que una ruta propuesta por la IA sea estrictamente relativa al workspace. */
export function isSafeRelativeEditPath(raw: string): boolean {
  const clean = raw.trim().replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean)) return false;
  const parts = clean.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

function branchPrefix(labels: { name: string }[] = []): string {
  const low = labels.map((l) => l.name.toLowerCase());
  if (low.some((l) => l.includes("bug") || l.includes("fix") || l.includes("error"))) return "fix";
  if (low.some((l) => l.includes("doc"))) return "docs";
  if (low.some((l) => l.includes("refactor"))) return "refactor";
  return "feat";
}

/**
 * Genera un nombre de rama limpio, válido en Git y legible a partir de una issue.
 * Ejemplo: #42 "Arreglar login en Windows" (label: bug) → `fix/42-arreglar-login-en-windows`.
 */
export function branchNameForIssue(issue: WorkflowIssueRef): string {
  const prefix = branchPrefix(issue.labels);
  const slug = issue.title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/, "");
  return `${prefix}/${issue.number}${slug ? `-${slug}` : ""}`;
}

/** Construye el prompt inicial enriquecido con el contexto de la issue y el formato revisable de diffs. */
export function buildIssuePrompt(issue: WorkflowIssueRef, branch: string): string {
  const labels = (issue.labels ?? []).map((l) => l.name).filter(Boolean);
  const lines: string[] = [
    `Estamos trabajando en la issue #${issue.number} en la rama \`${branch}\`:`,
    "",
    `Título: ${issue.title}`,
  ];
  if (labels.length) lines.push(`Etiquetas: ${labels.join(", ")}`);
  if (issue.body?.trim()) {
    lines.push("", "Descripción:", issue.body.trim().slice(0, 4000));
  }
  lines.push(
    "",
    "Instrucciones:",
    "1. Analiza el código relevante del proyecto y propón un plan breve antes de cambiar archivos.",
    "2. Si propones cambios para revisar en el visor de diferencias de Pulso antes de aplicarlos, devuelve cada archivo completo en un bloque cercado con `path=ruta/relativa` (por ejemplo: ```ts path=src/ejemplo.ts).",
  );
  return lines.join("\n");
}

function normalizeCandidatePath(raw: string): string | null {
  const cleaned = raw.trim().replace(/^["'`]|["'`]$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");
  return isSafeRelativeEditPath(cleaned) ? cleaned : null;
}

/**
 * Extrae propuestas de archivo desde texto Markdown de la IA para revisión en Diff View.
 * Formatos soportados:
 *  - Fenced info string: ```ts path=src/foo.ts  o  ```ts file=src/foo.ts  o  ```ts:src/foo.ts
 *  - Encabezado inmediatamente anterior: `### Archivo: src/foo.ts` o `**src/foo.ts**`
 * Si el mismo archivo aparece varias veces, gana la última propuesta.
 */
export function extractProposedEdits(markdown: string): ProposedFileEdit[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const byPath = new Map<string, ProposedFileEdit>();

  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^```([^\n]*)$/);
    if (!fence) continue;
    const info = fence[1].trim();
    let lang = "";
    let rawPath: string | null = null;

    // 1. ```lang path=src/a.ts  o  ```lang file=src/a.ts
    const kv = info.match(/^(?:([a-z0-9_+-]+)\s+)?(?:path|file)=([^\s]+)/i);
    if (kv) {
      lang = kv[1] ?? "";
      rawPath = kv[2];
    } else {
      // 2. ```ts:src/a.ts
      const colon = info.match(/^([a-z0-9_+-]+):([^\s]+)$/i);
      if (colon && colon[2].includes(".")) {
        lang = colon[1];
        rawPath = colon[2];
      } else {
        lang = info.split(/\s+/)[0] ?? "";
        // 3. Línea anterior con «Archivo: `src/a.ts`» o «**`src/a.ts`**»
        const prev = i > 0 ? lines[i - 1].trim() : "";
        const hint =
          prev.match(/^(?:#{1,6}\s*)?(?:archivo|file)\s*:\s*`?([^`\s]+)`?$/i) ??
          prev.match(/^\*\*`?([^*`\s]+\.[a-z0-9]+)`?\*\*$/i);
        if (hint) rawPath = hint[1];
      }
    }

    // Recoger cuerpo hasta el cierre ```
    const body: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^```\s*$/.test(lines[j])) {
        i = j;
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    if (!closed || !rawPath) continue;

    const safePath = normalizeCandidatePath(rawPath);
    if (!safePath) continue;
    byPath.set(safePath, { path: safePath, lang, content: body.join("\n") });
  }

  return Array.from(byPath.values());
}

/** Construye borrador de Pull Request pre-llenado a partir de la issue activa y los archivos tocados. */
export function buildPrDraft(
  issue: Pick<WorkflowIssueRef, "number" | "title" | "labels">,
  head: string,
  base: string,
  touchedFiles: string[] = [],
): PrDraft {
  const prefix = branchPrefix(issue.labels);
  const title = `${prefix}(#${issue.number}): ${issue.title.trim()}`;
  const parts: string[] = [
    `## Resumen`,
    `Resuelve la issue #${issue.number} (${issue.title.trim()}).`,
  ];
  if (touchedFiles.length) {
    parts.push("", "## Archivos modificados", ...touchedFiles.map((f) => `- \`${f}\``));
  }
  parts.push("", `Closes #${issue.number}`);
  return { title, body: parts.join("\n"), head, base };
}
