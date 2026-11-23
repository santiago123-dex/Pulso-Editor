/** Markdown mínimo para respuestas de IA, sin HTML: bloques de código, párrafos, listas, encabezados, `código` y **negrita**. */
export type MdBlock =
  | { type: "code"; lang: string; text: string; closed: boolean }
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "li"; ordered: boolean; text: string; marker: string };

export function parseMarkdown(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ type: "p", text: para.join("\n") }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (/^\s*```\s*$/.test(lines[i])) { closed = true; break; }
        code.push(lines[i]);
      }
      // Una cerca sin cerrar (la respuesta aún se está escribiendo) se muestra ya como código.
      out.push({ type: "code", lang: fence[1], text: code.join("\n"), closed });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ type: "h", level: h[1].length, text: h[2] }); continue; }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { flush(); out.push({ type: "li", ordered: /\d/.test(li[1]), text: li[2], marker: /\d/.test(li[1]) ? li[1] : "•" }); continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return out;
}

export interface Inline { text: string; kind: "text" | "code" | "bold" | "link"; href?: string }

/** Parte una línea en texto, `código`, **negrita** y [enlaces](url). Un marcador sin cerrar se deja tal cual. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), kind: "text" });
    if (m[1] !== undefined) out.push({ text: m[1], kind: "code" });
    else if (m[2] !== undefined) out.push({ text: m[2], kind: "bold" });
    else out.push({ text: m[3]!, kind: "link", href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), kind: "text" });
  return out;
}

/** Destino de un enlace de la respuesta: un archivo del equipo (con su línea, si la trae) o una página web. */
export function linkTarget(href: string): { kind: "file"; path: string; line: number } | { kind: "web"; url: string } | null {
  if (/^https?:\/\//i.test(href)) return { kind: "web", url: href };
  if (!/^file:\/\//i.test(href)) return null;
  const [rawPath, frag = ""] = href.replace(/^file:\/\/\/?/i, "").split("#");
  let path: string;
  try { path = decodeURIComponent(rawPath ?? ""); } catch { return null; }
  if (!path) return null;
  if (!/^[a-z]:/i.test(path) && !path.startsWith("/")) path = `/${path}`;
  const line = Number(/^L(\d+)/i.exec(frag)?.[1] ?? 1);
  return { kind: "file", path, line: Math.max(1, line) };
}
