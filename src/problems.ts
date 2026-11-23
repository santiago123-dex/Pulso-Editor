import { t } from "./i18n";
import * as monaco from "monaco-editor";
import { docs, onDocsChange } from "./docs";
import { openFile } from "./groups";
import { fileIcon } from "./icons";
import { countProblems, groupProblems, selectionLength, severityOf, statusText, summaryText, type Problem } from "./problemsModel";
import { $, baseName, dirName, h } from "./util";
import { rel } from "./workspace";

/** Problemas de los archivos abiertos: los diagnósticos que publica el servidor de lenguaje (u otro validador) como marcadores de Monaco. */
let onlyErrors = false;
let timer = 0;
let visible = false;
const collapsed = new Set<string>();

export function collectProblems(): Problem[] {
  const out: Problem[] = [];
  for (const d of docs.values()) {
    for (const m of monaco.editor.getModelMarkers({ resource: d.model.uri })) {
      const severity = severityOf(m.severity);
      if (!severity) continue;
      const code = typeof m.code === "object" && m.code ? m.code.value : m.code;
      out.push({
        path: d.path, line: m.startLineNumber, col: m.startColumn, endLine: m.endLineNumber, endCol: m.endColumn,
        severity, message: m.message, source: m.source, code: code === undefined ? undefined : String(code),
      });
    }
  }
  return out;
}

function refresh() {
  const all = collectProblems();
  const counts = countProblems(all);
  const status = $("status-problems");
  const text = statusText(counts);
  status.textContent = text;
  status.hidden = !text;
  status.title = t("{summary} en los archivos abiertos. Pulsa para ver el panel.", { summary: summaryText(counts) });
  status.classList.toggle("has-errors", counts.error > 0);
  const badge = $("problems-badge");
  const n = counts.error + counts.warning;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
  if (visible) paint(all);
}

function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(refresh, 250);
}

function paint(all: Problem[]) {
  const counts = countProblems(all);
  $("problems-summary").textContent = all.length ? t("{summary} en los archivos abiertos", { summary: summaryText(counts) }) : t("Sin problemas en los archivos abiertos");
  const box = $("problems-list");
  box.replaceChildren();
  const groups = groupProblems(all, onlyErrors);
  if (!groups.length) {
    box.append(h("div", "problems-empty", all.length && onlyErrors ? t("No hay errores. Quita el filtro para ver avisos.") : t("Los problemas aparecen aquí cuando el servidor de lenguaje analiza los archivos abiertos.")));
    return;
  }
  for (const g of groups) {
    const closed = collapsed.has(g.path);
    const head = h("div", "sfile" + (closed ? " closed" : ""));
    head.append(h("span", "chev"), fileIcon(baseName(g.path)), h("span", "name", baseName(g.path)));
    const dir = rel(dirName(g.path));
    if (dir) head.append(h("span", "sdir", dir));
    head.append(h("span", "scount", String(g.items.length)));
    head.onclick = () => { if (collapsed.has(g.path)) collapsed.delete(g.path); else collapsed.add(g.path); paint(all); };
    box.append(head);
    if (closed) continue;
    for (const p of g.items) {
      const row = h("div", "problem");
      const dot = h("span", `pdot ${p.severity}`);
      dot.textContent = p.severity === "error" ? "✖" : p.severity === "warning" ? "⚠" : "ⓘ";
      const msg = h("span", "pmsg", p.message.split("\n")[0]);
      const where = h("span", "pwhere", `${p.source ? p.source + (p.code ? `(${p.code}) ` : " ") : ""}[${p.line}, ${p.col}]`);
      row.append(dot, msg, where);
      row.title = p.message;
      row.onclick = () => void openFile(p.path, { line: p.line, col: p.col, len: selectionLength(p) });
      box.append(row);
    }
  }
}

/** Se llama al mostrar u ocultar la vista, para pintar solo cuando se ve. */
export function setProblemsVisible(v: boolean) {
  visible = v;
  if (v) refresh();
}

export function initProblems(openView: () => void) {
  monaco.editor.onDidChangeMarkers(schedule);
  onDocsChange(schedule);
  $("status-problems").onclick = openView;
  const only = $("problems-only-errors");
  only.onclick = () => { onlyErrors = !onlyErrors; only.classList.toggle("on", onlyErrors); refresh(); };
  refresh();
}
