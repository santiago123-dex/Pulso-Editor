import { t } from "./i18n";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { docs, onDocsChange } from "./docs";
import { openFile } from "./groups";
import { fileIcon } from "./icons";
import { countProblems, groupProblems, selectionLength, severityOf, statusText, summaryText, type Problem } from "./problemsModel";
import { fromProjectDiagnostics, mergeProblems, type ProblemScope, type ProjectCheckResult } from "./projectProblemsModel";
import { setStatus } from "./ui";
import { $, baseName, dirName, h } from "./util";
import { rel, ws } from "./workspace";

/** Problemas de los archivos abiertos y análisis bajo demanda de todo el proyecto. */
let onlyErrors = false;
let scope: ProblemScope = "open";
let projectItems: Problem[] = [];
let projectTools: string[] = [];
let projectNote: string | null = null;
let projectDuration = 0;
let scanning = false;
let scanToken = 0;
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
        path: d.path,
        line: m.startLineNumber,
        col: m.startColumn,
        endLine: m.endLineNumber,
        endCol: m.endColumn,
        severity,
        message: m.message,
        source: m.source,
        code: code === undefined ? undefined : String(code),
      });
    }
  }
  return out;
}

function activeProblems(): Problem[] {
  const open = collectProblems();
  return scope === "project" ? mergeProblems(open, projectItems) : open;
}

export function resetProjectProblems() {
  scanToken++;
  projectItems = [];
  projectTools = [];
  projectNote = null;
  projectDuration = 0;
  scanning = false;
  refresh();
}

export async function runProjectProblemsCheck() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para analizar todo el proyecto"), 3000);
    return;
  }
  const mine = ++scanToken;
  scope = "project";
  syncScopeButtons();
  scanning = true;
  projectNote = null;
  refresh();
  setStatus(t("Analizando todo el proyecto…"));
  try {
    const res = await invoke<ProjectCheckResult>("project_check", { root: ws.root });
    if (mine !== scanToken) return;
    projectItems = fromProjectDiagnostics(res.items);
    projectTools = res.tools;
    projectNote = res.note ?? null;
    projectDuration = res.duration_ms;
    const counts = countProblems(activeProblems());
    setStatus(t("Análisis del proyecto listo: {summary}", { summary: summaryText(counts) }), 3500);
  } catch (e) {
    if (mine !== scanToken) return;
    projectNote = e instanceof Error ? e.message : String(e);
    setStatus(t("No se pudo analizar el proyecto"), 3500);
  } finally {
    if (mine === scanToken) {
      scanning = false;
      refresh();
    }
  }
}

function syncScopeButtons() {
  const seg = document.getElementById("problems-scope");
  if (!seg) return;
  seg.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.v === scope));
  });
}

function refresh() {
  const all = activeProblems();
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
  const summaryEl = $("problems-summary");
  if (scanning) {
    summaryEl.textContent = t("Analizando todo el proyecto…");
  } else if (scope === "project") {
    const toolsText = projectTools.length ? ` (${projectTools.join(", ")} · ${(projectDuration / 1000).toFixed(1)} s)` : "";
    summaryEl.textContent = all.length
      ? `${t("{summary} en todo el proyecto", { summary: summaryText(counts) })}${toolsText}`
      : `${t("Sin problemas en todo el proyecto")}${toolsText}`;
  } else {
    summaryEl.textContent = all.length
      ? t("{summary} en los archivos abiertos", { summary: summaryText(counts) })
      : t("Sin problemas en los archivos abiertos");
  }

  const box = $("problems-list");
  box.replaceChildren();
  if (scanning) {
    box.append(h("div", "problems-empty", t("Ejecutando compiladores y linters del proyecto…")));
    return;
  }
  const groups = groupProblems(all, onlyErrors);
  if (!groups.length) {
    let msg: string;
    if (all.length && onlyErrors) {
      msg = t("No hay errores. Quita el filtro para ver avisos.");
    } else if (scope === "project") {
      msg =
        projectNote ||
        (projectTools.length
          ? t("Sin problemas detectados en el proyecto.")
          : t("Pulsa el botón de analizar para revisar todo el proyecto."));
    } else {
      msg = t("Los problemas aparecen aquí cuando el servidor de lenguaje analiza los archivos abiertos.");
    }
    box.append(h("div", "problems-empty", msg));
    return;
  }
  for (const g of groups) {
    const closed = collapsed.has(g.path);
    const head = h("div", "sfile" + (closed ? " closed" : ""));
    head.append(h("span", "chev"), fileIcon(baseName(g.path)), h("span", "name", baseName(g.path)));
    const dir = rel(dirName(g.path));
    if (dir) head.append(h("span", "sdir", dir));
    head.append(h("span", "scount", String(g.items.length)));
    head.onclick = () => {
      if (collapsed.has(g.path)) collapsed.delete(g.path);
      else collapsed.add(g.path);
      paint(all);
    };
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
  only.onclick = () => {
    onlyErrors = !onlyErrors;
    only.classList.toggle("on", onlyErrors);
    refresh();
  };
  const scan = document.getElementById("problems-scan");
  if (scan) scan.onclick = () => void runProjectProblemsCheck();
  const seg = document.getElementById("problems-scope");
  if (seg) {
    seg.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((b) => {
      b.onclick = () => {
        const next = (b.dataset.v === "project" ? "project" : "open") as ProblemScope;
        scope = next;
        syncScopeButtons();
        if (scope === "project" && !projectTools.length && !scanning && ws.root) {
          void runProjectProblemsCheck();
        } else {
          refresh();
        }
      };
    });
  }
  refresh();
}
