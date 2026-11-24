import { lang, t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { bus } from "./core/events";
import { openDiffRequest, type Sources } from "./diffView";
import { activePath } from "./groups";
import { agoIso, computeGraphRows, mayHaveMore, mergeCommits, PAGE, refChips, relativeToTop, STATUS_LABEL, type CommitFile, type CommitInfo, type GraphRow } from "./historyModel";
import { gitTop } from "./scm";
import { setStatus } from "./ui";
import { $, baseName, h } from "./util";
import { ws } from "./workspace";

/** Historial de commits dentro de la vista de control de código: todo el repositorio o un solo archivo. */
let commits: CommitInfo[] = [];
let more = false;
let loading = false;
let problem = "";
let fileFilter: string | null = null;
let searchQuery = "";
let allBranches = true;
let searchTimer = 0;
let seq = 0;
const expanded = new Map<string, CommitFile[] | "cargando" | string>();

const GRAPH_COLORS = ["#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#fb7185"];

function renderGraphSvg(row: GraphRow): SVGSVGElement {
  const step = 12;
  const w = Math.max(16, row.lanes * step + 6);
  const cy = 14;
  const hgt = 28;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "hist-graph");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(hgt));
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("aria-hidden", "true");

  const mk = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  for (const p of row.passLanes) {
    const x = 6 + p.lane * step;
    svg.append(mk("line", { x1: String(x), y1: "0", x2: String(x), y2: String(hgt), stroke: GRAPH_COLORS[p.color % GRAPH_COLORS.length], "stroke-width": "1.6", opacity: "0.7" }));
  }
  const cx = 6 + row.lane * step;
  for (const e of row.edges) {
    const tx = 6 + e.to * step;
    const col = GRAPH_COLORS[e.color % GRAPH_COLORS.length];
    if (e.from === e.to) {
      svg.append(mk("line", { x1: String(cx), y1: String(cy), x2: String(tx), y2: String(hgt), stroke: col, "stroke-width": "1.6" }));
    } else {
      svg.append(mk("path", { d: `M ${cx} ${cy} C ${cx} ${cy + 8}, ${tx} ${hgt - 8}, ${tx} ${hgt}`, fill: "none", stroke: col, "stroke-width": "1.6" }));
    }
  }
  // Línea superior que entra al nodo si no es la primera fila o tiene predecesor en el mismo carril
  svg.append(mk("line", { x1: String(cx), y1: "0", x2: String(cx), y2: String(cy), stroke: GRAPH_COLORS[row.color % GRAPH_COLORS.length], "stroke-width": "1.6", opacity: "0.45" }));
  svg.append(mk("circle", { cx: String(cx), cy: String(cy), r: "3.3", fill: GRAPH_COLORS[row.color % GRAPH_COLORS.length] }));
  return svg;
}

const view = () => $("view-git");
const isHistoryTab = () => view().classList.contains("history-mode");

function setTab(history: boolean) {
  view().classList.toggle("history-mode", history);
  document.querySelectorAll<HTMLButtonElement>("#scm-tabs button").forEach((b) => b.setAttribute("aria-selected", String((b.dataset.tab === "history") === history)));
  if (history) void loadHistory(true);
}

/**
 * `reset`: empezar de nuevo. Con `keep` (recarga automática tras un commit, pull…) la lista que ya se ve
 * se queda en pantalla hasta que llegue la nueva, para que no parpadee ni pierda lo desplegado.
 */
async function loadHistory(reset: boolean, keep = false) {
  const mine = ++seq;
  if (!ws.root) { commits = []; problem = t("Abre una carpeta para ver su historial."); paint(); return; }
  if (reset && !keep) { commits = []; more = false; expanded.clear(); }
  loading = true;
  problem = "";
  paint();
  try {
    const batch = await invoke<CommitInfo[]>("git_log", {
      root: ws.root,
      path: fileFilter,
      skip: reset ? 0 : commits.length,
      limit: PAGE,
      query: searchQuery.trim() || null,
      all: allBranches && !fileFilter,
    });
    if (mine !== seq) return;
    commits = reset ? batch : mergeCommits(commits, batch);
    if (keep) for (const k of [...expanded.keys()]) if (!commits.some((c) => c.hash === k)) expanded.delete(k);
    more = mayHaveMore(batch);
  } catch (e) {
    if (mine !== seq) return;
    problem = String(e);
  } finally {
    if (mine === seq) { loading = false; paint(); }
  }
}

async function toggleCommit(c: CommitInfo) {
  if (expanded.has(c.hash)) { expanded.delete(c.hash); paint(); return; }
  expanded.set(c.hash, "cargando");
  paint();
  try {
    expanded.set(c.hash, await invoke<CommitFile[]>("git_commit_files", { root: ws.root, hash: c.hash }));
  } catch (e) {
    expanded.set(c.hash, t("No se pudieron leer los archivos: {error}", { error: String(e) }));
  }
  paint();
}

function openFileDiff(c: CommitInfo, f: CommitFile) {
  void openDiffRequest({
    title: baseName(f.path),
    sub: `${f.path} — ${c.short} ${c.subject}`,
    path: f.path,
    load: () => invoke<Sources>("git_commit_sources", { root: ws.root, hash: c.hash, path: f.path, orig: f.orig }),
  });
}

function paint() {
  const box = $("scm-history");
  const nodes: HTMLElement[] = [];

  // Barra de búsqueda y selector de grafo (todas las ramas vs rama actual)
  const toolbar = h("div", "hist-toolbar");
  const input = document.createElement("input");
  input.type = "search";
  input.className = "hist-search";
  input.placeholder = t("Buscar commits…");
  input.setAttribute("aria-label", t("Buscar en el historial de commits"));
  input.value = searchQuery;
  input.oninput = () => {
    searchQuery = input.value;
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadHistory(true), 220);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { clearTimeout(searchTimer); void loadHistory(true); }
    if (e.key === "Escape" && searchQuery) { searchQuery = ""; void loadHistory(true); }
  };
  toolbar.append(input);
  if (!fileFilter) {
    const allBtn = h("button", `hist-all-btn${allBranches ? " active" : ""}`, allBranches ? t("Todas") : t("Actual"));
    allBtn.type = "button";
    allBtn.title = allBranches ? t("Mostrando todas las ramas (clic para ver solo HEAD)") : t("Mostrando solo la rama actual (clic para ver el grafo de todas las ramas)");
    allBtn.onclick = () => { allBranches = !allBranches; void loadHistory(true); };
    toolbar.append(allBtn);
  }
  nodes.push(toolbar);

  if (fileFilter) {
    const chip = h("div", "hist-filter");
    chip.append(h("span", "", t("Historial de {file}", { file: fileFilter })));
    const x = h("button", "icon-btn");
    x.title = t("Ver el historial de todo el repositorio");
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.onclick = () => { fileFilter = null; void loadHistory(true); };
    chip.append(x);
    nodes.push(chip);
  }
  if (problem) nodes.push(h("div", "scm-empty", problem));
  else if (!commits.length && !loading) nodes.push(h("div", "scm-empty", searchQuery.trim() ? t("No hay commits que coincidan con la búsqueda.") : fileFilter ? t("Este archivo aún no tiene commits.") : t("Aún no hay commits.")));
  const graphRows = !searchQuery.trim() && !fileFilter ? computeGraphRows(commits) : null;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const row = h("div", "hist-row");
    const lineWrap = h("div", "hist-line");
    if (graphRows) lineWrap.append(renderGraphSvg(graphRows[i]));
    const head = h("button", "hist-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(expanded.has(c.hash)));
    head.title = `${c.hash}\n${c.author} <${c.email}>\n${new Date(c.date).toLocaleString(lang())}`;
    head.append(h("span", "hist-subject", c.subject));
    const meta = h("span", "hist-meta");
    meta.append(`${c.author} · ${agoIso(c.date)} · `, h("code", "hist-hash", c.short));
    head.append(meta);
    const chips = refChips(c.refs);
    if (chips.length) {
      const wrap = h("span", "hist-refs");
      for (const r of chips) wrap.append(h("span", `hist-ref ${r.kind}`, r.label));
      head.append(wrap);
    }
    head.onclick = () => void toggleCommit(c);
    const copy = h("button", "icon-btn hist-copy");
    copy.title = t("Copiar el identificador del commit");
    copy.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
    copy.onclick = (e) => { e.stopPropagation(); void navigator.clipboard.writeText(c.hash).then(() => setStatus(t("Copiado {hash}", { hash: c.short }), 2500), () => setStatus(t("No se pudo copiar"))); };
    lineWrap.append(head, copy);
    row.append(lineWrap);
    const files = expanded.get(c.hash);
    if (files !== undefined) {
      const list = h("div", "hist-files");
      if (files === "cargando") list.append(h("div", "hist-note", t("Cargando archivos…")));
      else if (typeof files === "string") list.append(h("div", "hist-note", files));
      else if (!files.length) list.append(h("div", "hist-note", t("Sin archivos cambiados (por ejemplo, un merge).")));
      else for (const f of files) {
        const b = h("button", "hist-file");
        b.type = "button";
        b.title = `${STATUS_LABEL[f.status] ?? f.status}${f.orig ? " " + t("(antes: {path})", { path: f.orig }) : ""}`;
        b.append(h("span", `hist-st st-${f.status}`, f.status), h("span", "hist-path", f.path));
        b.onclick = () => openFileDiff(c, f);
        list.append(b);
      }
      row.append(list);
    }
    nodes.push(row);
  }
  if (loading && !commits.length) nodes.push(h("div", "scm-empty", t("Cargando historial…")));
  else if (loading) nodes.push(h("div", "scm-empty", t("Actualizando…")));
  else if (more) {
    const b = h("button", "foot-btn foot-btn-line hist-more", t("Cargar más commits"));
    b.type = "button";
    b.onclick = () => void loadHistory(false);
    nodes.push(b);
  }
  const activeWasSearch = document.activeElement?.classList.contains("hist-search");
  const selStart = activeWasSearch ? (document.activeElement as HTMLInputElement).selectionStart : null;
  box.replaceChildren(...nodes);
  if (activeWasSearch) {
    const inp = box.querySelector<HTMLInputElement>(".hist-search");
    if (inp) { inp.focus(); if (selStart !== null) inp.setSelectionRange(selStart, selStart); }
  }
}

/** «Git: Historial del archivo activo»: abre la pestaña de historial filtrada por ese archivo. */
export function showFileHistory() {
  const top = gitTop();
  const p = activePath();
  if (!top || !p) { setStatus(t("Abre un archivo de un repositorio de Git para ver su historial")); return false; }
  const rel = relativeToTop(p, top);
  if (!rel) { setStatus(t("Ese archivo no está dentro del repositorio")); return false; }
  fileFilter = rel;
  setTab(true);
  return true;
}

/** Abre la pestaña de historial del panel Git sin depender de clicks sintéticos en el DOM. */
export function openHistoryTab() { setTab(true); }

/** Al cambiar de carpeta el historial anterior ya no sirve. */
export function resetHistory() { commits = []; more = false; fileFilter = null; expanded.clear(); if (isHistoryTab()) void loadHistory(true); }

export function refreshHistory() { if (isHistoryTab()) void loadHistory(true, true); }

export function initHistory() {
  // Tras un commit, un pull o un cambio de rama el panel de cambios se recarga: el historial también.
  bus.on("scm-refreshed", () => refreshHistory());
  document.querySelectorAll<HTMLButtonElement>("#scm-tabs button").forEach((b) => { b.onclick = () => setTab(b.dataset.tab === "history"); });
}
