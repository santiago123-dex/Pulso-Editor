import { invoke } from "@tauri-apps/api/core";
import { openDiffRequest, type Sources } from "./diffView";
import { activePath } from "./groups";
import { agoIso, mayHaveMore, mergeCommits, PAGE, refChips, relativeToTop, STATUS_LABEL, type CommitFile, type CommitInfo } from "./historyModel";
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
let seq = 0;
const expanded = new Map<string, CommitFile[] | "cargando" | string>();

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
  if (!ws.root) { commits = []; problem = "Abre una carpeta para ver su historial."; paint(); return; }
  if (reset && !keep) { commits = []; more = false; expanded.clear(); }
  loading = true;
  problem = "";
  paint();
  try {
    const batch = await invoke<CommitInfo[]>("git_log", { root: ws.root, path: fileFilter, skip: reset ? 0 : commits.length, limit: PAGE });
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
    expanded.set(c.hash, `No se pudieron leer los archivos: ${e}`);
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
  if (fileFilter) {
    const chip = h("div", "hist-filter");
    chip.append(h("span", "", `Historial de ${fileFilter}`));
    const x = h("button", "icon-btn");
    x.title = "Ver el historial de todo el repositorio";
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.onclick = () => { fileFilter = null; void loadHistory(true); };
    chip.append(x);
    nodes.push(chip);
  }
  if (problem) nodes.push(h("div", "scm-empty", problem));
  else if (!commits.length && !loading) nodes.push(h("div", "scm-empty", fileFilter ? "Este archivo aún no tiene commits." : "Aún no hay commits."));
  for (const c of commits) {
    const row = h("div", "hist-row");
    const head = h("button", "hist-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(expanded.has(c.hash)));
    head.title = `${c.hash}\n${c.author} <${c.email}>\n${new Date(c.date).toLocaleString("es")}`;
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
    copy.title = "Copiar el identificador del commit";
    copy.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
    copy.onclick = (e) => { e.stopPropagation(); void navigator.clipboard.writeText(c.hash).then(() => setStatus(`Copiado ${c.short}`, 2500), () => setStatus("No se pudo copiar")); };
    row.append(head, copy);
    const files = expanded.get(c.hash);
    if (files !== undefined) {
      const list = h("div", "hist-files");
      if (files === "cargando") list.append(h("div", "hist-note", "Cargando archivos…"));
      else if (typeof files === "string") list.append(h("div", "hist-note", files));
      else if (!files.length) list.append(h("div", "hist-note", "Sin archivos cambiados (por ejemplo, un merge)."));
      else for (const f of files) {
        const b = h("button", "hist-file");
        b.type = "button";
        b.title = `${STATUS_LABEL[f.status] ?? f.status}${f.orig ? ` (antes: ${f.orig})` : ""}`;
        b.append(h("span", `hist-st st-${f.status}`, f.status), h("span", "hist-path", f.path));
        b.onclick = () => openFileDiff(c, f);
        list.append(b);
      }
      row.append(list);
    }
    nodes.push(row);
  }
  if (loading && !commits.length) nodes.push(h("div", "scm-empty", "Cargando historial…"));
  else if (loading) nodes.push(h("div", "scm-empty", "Actualizando…"));
  else if (more) {
    const b = h("button", "foot-btn foot-btn-line hist-more", "Cargar más commits");
    b.type = "button";
    b.onclick = () => void loadHistory(false);
    nodes.push(b);
  }
  box.replaceChildren(...nodes);
}

/** «Git: Historial del archivo activo»: abre la pestaña de historial filtrada por ese archivo. */
export function showFileHistory() {
  const top = gitTop();
  const p = activePath();
  if (!top || !p) { setStatus("Abre un archivo de un repositorio de Git para ver su historial"); return false; }
  const rel = relativeToTop(p, top);
  if (!rel) { setStatus("Ese archivo no está dentro del repositorio"); return false; }
  fileFilter = rel;
  setTab(true);
  return true;
}

/** Al cambiar de carpeta el historial anterior ya no sirve. */
export function resetHistory() { commits = []; more = false; fileFilter = null; expanded.clear(); if (isHistoryTab()) void loadHistory(true); }

export function refreshHistory() { if (isHistoryTab()) void loadHistory(true, true); }

export function initHistory() {
  // Tras un commit, un pull o un cambio de rama el panel de cambios se recarga: el historial también.
  window.addEventListener("pulso-scm-refreshed", () => refreshHistory());
  document.querySelectorAll<HTMLButtonElement>("#scm-tabs button").forEach((b) => { b.onclick = () => setTab(b.dataset.tab === "history"); });
}
