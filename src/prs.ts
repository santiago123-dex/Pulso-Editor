import { t as tr } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { openDiffRequest } from "./diffView";
import { openExternal } from "./external";
import { hasToken, isAuthProblem } from "./github";
import { connectButton } from "./githubConnect";
import { agoIso } from "./historyModel";
import { currentRepo } from "./core/repo";
import { branchLabel, fileLetter, newPullProblem, PR_STATE_LABEL, prState, suggestTitle, totals, type PullFile, type PullSummary } from "./prModel";
import { createPull, defaultBranch, getPull, listPulls, mergeBase, pullFiles, pullSources } from "./pulls";
import { setStatus, showDialog, showForm } from "./ui";
import { $, baseName, h } from "./util";
import { ws } from "./workspace";

/** Pull requests del repositorio de GitHub de la carpeta abierta: lista, detalle con archivos y diferencias, y crear una nueva. */
interface Repo { owner: string; repo: string }
interface Detail { pr: PullSummary; files: PullFile[]; base: string }

let repo: Repo | null = null;
let list: PullSummary[] = [];
let filter: "open" | "closed" | "all" = "open";
let detail: Detail | null = null;
let seq = 0;
let lastLoad = 0;
let visible = false;
let loaded = false;

const body = () => $("prs-body");

function message(text: string, ...extra: HTMLElement[]): HTMLElement {
  const box = h("div", "scm-empty");
  box.append(text, ...(extra.length ? [h("br"), ...extra] : []));
  return box;
}

async function resolveRepo(): Promise<Repo | null> {
  repo = await currentRepo();
  $("prs-repo").textContent = repo ? `${repo.owner}/${repo.repo}` : "";
  return repo;
}

function fail(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  body().replaceChildren(message(text, ...(isAuthProblem(e) ? [connectButton(() => void loadPulls())] : [])));
}

/** `silent`: actualizar sin vaciar la lista (al volver a la ventana o con el temporizador). */
export async function loadPulls(silent = false) {
  if (detail && silent) return;
  const mine = ++seq;
  if (!ws.root) { body().replaceChildren(message(tr("Abre una carpeta para ver las pull requests de su repositorio."))); return; }
  if (!(await resolveRepo())) { body().replaceChildren(message(tr("Esta carpeta no tiene un remoto de GitHub."))); return; }
  if (mine !== seq) return;
  if (!silent) body().replaceChildren(message(tr("Cargando…")));
  try {
    const found = await listPulls(repo!.owner, repo!.repo, filter);
    if (mine !== seq) return;
    list = found;
    lastLoad = Date.now();
    loaded = true;
    if (!detail) paintList();
  } catch (e) {
    if (mine === seq && !silent) fail(e);
  }
}

function dot(state: ReturnType<typeof prState>) { return h("span", `pr-dot ${state}`); }

function paintList() {
  detail = null;
  const nodes: HTMLElement[] = [];
  if (!list.length) nodes.push(message(filter === "open" ? tr("No hay pull requests abiertas.") : tr("No hay pull requests con este filtro.")));
  for (const pr of list) {
    const state = prState(pr);
    const row = h("button", "pr-row");
    row.type = "button";
    row.title = tr("{state} · abrir el detalle", { state: PR_STATE_LABEL[state] });
    const top = h("span", "pr-row-title");
    top.append(dot(state), h("span", "pr-row-text", pr.title));
    const meta = h("span", "pr-row-meta");
    meta.append(`#${pr.number} · ${pr.user?.login ?? "?"} · `, h("code", "", branchLabel(pr)), ` · ${agoIso(pr.updated_at)}`);
    row.append(top, meta);
    row.onclick = () => void openDetail(pr);
    nodes.push(row);
  }
  body().replaceChildren(...nodes);
}

async function openDetail(summary: PullSummary) {
  if (!repo) return;
  const mine = ++seq;
  body().replaceChildren(message(tr("Cargando la pull request…")));
  try {
    const [pr, files] = await Promise.all([getPull(repo.owner, repo.repo, summary.number), pullFiles(repo.owner, repo.repo, summary.number)]);
    if (mine !== seq) return;
    const base = await mergeBase(repo.owner, repo.repo, pr);
    if (mine !== seq) return;
    detail = { pr, files, base };
    paintDetail();
  } catch (e) {
    if (mine === seq) fail(e);
  }
}

function paintDetail() {
  if (!detail || !repo) return;
  const { pr, files, base } = detail;
  const state = prState(pr);
  const wrap = h("div", "pr-detail");
  const back = h("button", "pr-back");
  back.type = "button";
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  back.append(tr("Pull requests"));
  back.onclick = () => { seq++; paintList(); void loadPulls(true); };
  const head = h("div", "pr-title");
  head.append(dot(state), h("span", "pr-title-text", pr.title));
  const chip = h("span", `pr-chip ${state}`, PR_STATE_LABEL[state]);
  const t = totals(files);
  const meta = h("div", "pr-meta", `#${pr.number} · ${pr.user?.login ?? "?"} · ${agoIso(pr.created_at)}`);
  const branch = h("div", "pr-branch", branchLabel(pr));
  const stats = h("div", "pr-stats");
  stats.append(`${files.length} archivo${files.length === 1 ? "" : "s"} · `, h("span", "pr-add", `+${t.additions}`), " ", h("span", "pr-del", `−${t.deletions}`));
  const text = h("div", "pr-body", pr.body?.trim() ? pr.body : tr("Sin descripción."));
  const gh = h("button", "foot-btn foot-btn-line");
  gh.type = "button";
  gh.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>';
  gh.append(tr("Ver en GitHub"));
  gh.onclick = () => void openExternal(pr.html_url);
  const fileBox = h("div", "pr-files");
  if (!files.length) fileBox.append(h("div", "hist-note", tr("Sin archivos cambiados.")));
  for (const f of files) {
    const b = h("button", "hist-file");
    b.type = "button";
    b.title = f.previous_filename ? tr("Antes: {path}", { path: f.previous_filename }) : f.filename;
    b.append(h("span", `hist-st st-${fileLetter(f.status)}`, fileLetter(f.status)), h("span", "hist-path", f.filename));
    const counts = h("span", "pr-counts");
    counts.append(h("span", "pr-add", `+${f.additions}`), " ", h("span", "pr-del", `−${f.deletions}`));
    b.append(counts);
    b.onclick = () => void openDiffRequest({
      title: baseName(f.filename),
      sub: `${f.filename} — #${pr.number} ${pr.title}`,
      path: f.filename,
      note: `+${f.additions} −${f.deletions}`,
      load: () => pullSources(repo!.owner, repo!.repo, pr, base, f),
    });
    fileBox.append(b);
  }
  wrap.append(back, head, chip, meta, branch, stats, text, gh, h("div", "pr-files-title", tr("Archivos cambiados")), fileBox);
  body().replaceChildren(wrap);
}

/** «Nueva pull request»: la rama actual contra la rama principal (o la que se indique). */
export async function newPull(prefill?: { title?: string; body?: string; issueNumber?: number }): Promise<PullSummary | null> {
  if (!ws.root) { setStatus(tr("Abre una carpeta para crear una pull request")); return null; }
  const found = await resolveRepo();
  if (!found) { await showDialog({ title: tr("Sin repositorio de GitHub"), message: tr("Esta carpeta no tiene un remoto de GitHub."), buttons: [{ label: tr("Entendido"), value: "ok" }] }); return null; }
  if (!hasToken()) { body().replaceChildren(message(tr("Conecta tu cuenta de GitHub para crear pull requests."), connectButton(() => void loadPulls()))); return null; }
  try {
    const [branches, base, log] = await Promise.all([
      invoke<{ name: string; current: boolean; upstream: string | null }[]>("git_branches", { root: ws.root }),
      defaultBranch(found.owner, found.repo),
      invoke<{ subject: string }[]>("git_log", { root: ws.root, path: null, skip: 0, limit: 1 }).catch(() => []),
    ]);
    const current = branches.find((b) => b.current);
    const problem = newPullProblem({ title: "x", head: current?.name ?? "", base, hasUpstream: !!current?.upstream });
    if (problem) { await showDialog({ title: tr("Aún no se puede crear"), message: problem, buttons: [{ label: tr("Entendido"), value: "ok" }] }); return null; }
    const values = await showForm({
      title: prefill?.issueNumber ? tr("Nueva pull request para #{number}", { number: prefill.issueNumber }) : tr("Nueva pull request"),
      submitLabel: tr("Crear"),
      fields: [
        { key: "title", label: tr("Título"), value: prefill?.title ?? suggestTitle(log[0]?.subject ?? null, current!.name), required: true },
        { key: "body", label: tr("Descripción (opcional)"), value: prefill?.body ?? "", multiline: true },
        { key: "base", label: tr("Rama de destino"), value: base, required: true },
      ],
      hint: tr("Se propondrán los cambios de «{branch}» hacia la rama de destino. Se crea en GitHub, en {repo}.", { branch: current!.name, repo: `${found.owner}/${found.repo}` }),
    });
    if (!values) return null;
    const finalProblem = newPullProblem({ title: values.title, head: current!.name, base: values.base, hasUpstream: true });
    if (finalProblem) { await showDialog({ title: tr("Aún no se puede crear"), message: finalProblem, buttons: [{ label: tr("Entendido"), value: "ok" }] }); return null; }
    setStatus(tr("Creando la pull request en GitHub…"), 30000);
    const made = await createPull(found.owner, found.repo, { title: values.title, head: current!.name, base: values.base, body: values.body });
    setStatus(tr("Pull request #{number} creada", { number: made.number }));
    filter = "open";
    syncFilter();
    await loadPulls();
    await openDetail(made);
    return made;
  } catch (e) {
    setStatus(tr("No se pudo crear la pull request"), 4000);
    await showDialog({ title: tr("No se pudo crear la pull request"), message: e instanceof Error ? e.message : String(e), buttons: [{ label: tr("Entendido"), value: "ok" }] });
    return null;
  }
}

function syncFilter() {
  document.querySelectorAll<HTMLButtonElement>("#prs-filter button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === filter)));
}

/** Al cambiar o cerrar carpeta se descartan los PRs y el detalle del repositorio anterior. */
export function resetPrs() {
  seq++;
  repo = null;
  list = [];
  detail = null;
  loaded = false;
  lastLoad = 0;
  const repoEl = document.getElementById("prs-repo");
  if (repoEl) repoEl.textContent = "";
  if (visible) void loadPulls();
  else if (document.getElementById("prs-body")) body().replaceChildren();
}

/** Lo llama el selector de vistas: se carga al mostrarse y se mantiene al día mientras se ve. */
export function setPrsVisible(v: boolean) {
  visible = v;
  if (v && (!loaded || Date.now() - lastLoad > 10_000)) void loadPulls(loaded);
}

export function initPrs() {
  $("prs-refresh").onclick = () => { if (detail) void openDetail(detail.pr); else void loadPulls(); };
  $("prs-new").onclick = () => void newPull();
  document.querySelectorAll<HTMLButtonElement>("#prs-filter button").forEach((b) => {
    b.onclick = () => { filter = b.dataset.v as typeof filter; syncFilter(); detail = null; void loadPulls(); };
  });
  window.setInterval(() => { if (ws.root && visible && !detail && document.visibilityState === "visible" && Date.now() - lastLoad > 20_000) void loadPulls(true); }, 5_000);
  window.addEventListener("focus", () => { if (ws.root && visible && !detail && Date.now() - lastLoad > 10_000) void loadPulls(true); });
}
