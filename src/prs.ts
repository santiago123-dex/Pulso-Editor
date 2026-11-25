import { t as tr } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { openDiffRequest } from "./diffView";
import { openExternal } from "./external";
import { hasToken, isAuthProblem } from "./github";
import { connectButton } from "./githubConnect";
import { agoIso } from "./historyModel";
import { currentRepo } from "./core/repo";
import {
  branchLabel,
  checkSummary,
  fileLetter,
  formatHeadForFork,
  newPullProblem,
  PR_STATE_LABEL,
  prState,
  suggestTitle,
  totals,
  type CheckRun,
  type MergeMethod,
  type PullComment,
  type PullFile,
  type PullSummary,
  type ReviewEvent,
} from "./prModel";
import {
  addPullComment,
  createPull,
  defaultBranch,
  getPull,
  getRepoForkParent,
  listCheckRuns,
  listPullComments,
  listPulls,
  mergeBase,
  mergePull,
  pullFiles,
  pullSources,
  reviewPull,
} from "./pulls";
import { setStatus, showDialog, showForm } from "./ui";
import { $, baseName, h } from "./util";
import { ws } from "./workspace";

/** Pull requests del repositorio de GitHub de la carpeta abierta: lista, detalle con archivos y diferencias, y crear una nueva. */
interface Repo {
  owner: string;
  repo: string;
}
interface Detail {
  pr: PullSummary;
  files: PullFile[];
  base: string;
  checks: CheckRun[];
  comments: PullComment[];
}

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
  if (!ws.root) {
    body().replaceChildren(message(tr("Abre una carpeta para ver las pull requests de su repositorio.")));
    return;
  }
  if (!(await resolveRepo())) {
    body().replaceChildren(message(tr("Esta carpeta no tiene un remoto de GitHub.")));
    return;
  }
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

function dot(state: ReturnType<typeof prState>) {
  return h("span", `pr-dot ${state}`);
}

function paintList() {
  detail = null;
  const nodes: HTMLElement[] = [];
  if (!list.length)
    nodes.push(message(filter === "open" ? tr("No hay pull requests abiertas.") : tr("No hay pull requests con este filtro.")));
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
    const [pr, files, comments] = await Promise.all([
      getPull(repo.owner, repo.repo, summary.number),
      pullFiles(repo.owner, repo.repo, summary.number),
      listPullComments(repo.owner, repo.repo, summary.number).catch(() => [] as PullComment[]),
    ]);
    if (mine !== seq) return;
    const [base, checks] = await Promise.all([
      mergeBase(repo.owner, repo.repo, pr),
      listCheckRuns(repo.owner, repo.repo, pr.head.sha).catch(() => [] as CheckRun[]),
    ]);
    if (mine !== seq) return;
    detail = { pr, files, base, checks, comments };
    paintDetail();
  } catch (e) {
    if (mine === seq) fail(e);
  }
}

function paintDetail() {
  if (!detail || !repo) return;
  const { pr, files, base, checks, comments } = detail;
  const state = prState(pr);
  const wrap = h("div", "pr-detail");
  const back = h("button", "pr-back");
  back.type = "button";
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  back.append(tr("Pull requests"));
  back.onclick = () => {
    seq++;
    paintList();
    void loadPulls(true);
  };
  const head = h("div", "pr-title");
  head.append(dot(state), h("span", "pr-title-text", pr.title));
  const chip = h("span", `pr-chip ${state}`, PR_STATE_LABEL[state]);
  const t = totals(files);
  const meta = h("div", "pr-meta", `#${pr.number} · ${pr.user?.login ?? "?"} · ${agoIso(pr.created_at)}`);
  const branch = h("div", "pr-branch", branchLabel(pr));
  const stats = h("div", "pr-stats");
  stats.append(
    (files.length === 1 ? tr("1 archivo") : tr("{count} archivos", { count: files.length })) + " · ",
    h("span", "pr-add", `+${t.additions}`),
    " ",
    h("span", "pr-del", `−${t.deletions}`),
  );
  const text = h("div", "pr-body", pr.body?.trim() ? pr.body : tr("Sin descripción."));

  // Acciones de PR: Ver en GitHub, Fusionar y Revisar
  const actionBar = h("div", "pr-actions");
  const gh = h("button", "foot-btn foot-btn-line");
  gh.type = "button";
  gh.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>';
  gh.append(tr("Ver en GitHub"));
  gh.onclick = () => void openExternal(pr.html_url);
  actionBar.append(gh);

  if (state === "open" && hasToken()) {
    let method: MergeMethod = "merge";
    const mergeOpts: Array<{ id: MergeMethod; btnLabel: string; title: string; desc: string; confirm: string }> = [
      {
        id: "merge",
        btnLabel: tr("Fusionar pull request"),
        title: tr("Crear merge commit"),
        desc: tr("Añade todos los commits de esta rama a la rama base."),
        confirm: tr("Confirmar fusión"),
      },
      {
        id: "squash",
        btnLabel: tr("Squash y merge"),
        title: tr("Squash y merge"),
        desc: tr("Combina todos los commits en un solo commit."),
        confirm: tr("Confirmar squash"),
      },
      {
        id: "rebase",
        btnLabel: tr("Rebase y merge"),
        title: tr("Rebase y merge"),
        desc: tr("Aplica los commits sobre la rama base sin merge commit."),
        confirm: tr("Confirmar rebase"),
      },
    ];
    const currentOpt = () => mergeOpts.find((o) => o.id === method) ?? mergeOpts[0];

    const splitWrap = h("div", "pr-merge-split");
    const mergeBtn = h("button", "foot-btn primary pr-merge-main", currentOpt().btnLabel);
    mergeBtn.type = "button";
    const caretBtn = h("button", "foot-btn primary pr-merge-caret");
    caretBtn.type = "button";
    caretBtn.title = tr("Elegir método de fusión");
    caretBtn.setAttribute("aria-haspopup", "menu");
    caretBtn.setAttribute("aria-expanded", "false");
    caretBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';

    const menu = h("div", "pr-merge-menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const closeMenu = () => {
      menu.hidden = true;
      caretBtn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onEsc, true);
    };
    const onOutside = (ev: Event) => {
      if (!splitWrap.contains(ev.target as Node)) closeMenu();
    };
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeMenu();
    };

    const renderMenu = () => {
      menu.replaceChildren();
      for (const opt of mergeOpts) {
        const item = h("button", `pr-merge-item${opt.id === method ? " active" : ""}`);
        item.type = "button";
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(opt.id === method));
        item.append(
          h("span", "pr-merge-check", opt.id === method ? "✓" : ""),
          h("span", "pr-merge-item-body", undefined),
        );
        const body = item.lastElementChild as HTMLElement;
        body.append(h("span", "pr-merge-item-title", opt.title), h("span", "pr-merge-item-desc", opt.desc));
        item.onclick = () => {
          method = opt.id;
          mergeBtn.textContent = opt.btnLabel;
          closeMenu();
        };
        menu.append(item);
      }
    };

    caretBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (!menu.hidden) {
        closeMenu();
        return;
      }
      renderMenu();
      menu.hidden = false;
      caretBtn.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onEsc, true);
    };

    mergeBtn.onclick = async () => {
      closeMenu();
      const opt = currentOpt();
      const ok = await showDialog({
        title: tr("Fusionar pull request #{number}", { number: pr.number }),
        message: `${opt.title} — «${pr.title}»`,
        buttons: [
          { label: tr("Cancelar"), value: "cancel" },
          { label: opt.confirm, value: "confirm", primary: true },
        ],
      });
      if (ok !== "confirm") return;
      try {
        setStatus(tr("Fusionando pull request #{number}…", { number: pr.number }), 30000);
        await mergePull(repo!.owner, repo!.repo, pr.number, method);
        setStatus(tr("Pull request #{number} fusionada", { number: pr.number }), 5000);
        await openDetail(pr);
      } catch (e) {
        await showDialog({
          title: tr("No se pudo fusionar"),
          message: e instanceof Error ? e.message : String(e),
          buttons: [{ label: tr("Entendido"), value: "ok" }],
        });
      }
    };

    splitWrap.append(mergeBtn, caretBtn, menu);

    const reviewBtn = h("button", "foot-btn foot-btn-line", tr("Revisar"));
    reviewBtn.type = "button";
    reviewBtn.onclick = async () => {
      const action = await showDialog({
        title: tr("Revisar pull request #{number}", { number: pr.number }),
        message: tr("Elige el tipo de revisión que quieres enviar."),
        buttons: [
          { label: tr("Cancelar"), value: "cancel" },
          { label: tr("Comentar"), value: "COMMENT" },
          { label: tr("Pedir cambios"), value: "REQUEST_CHANGES", danger: true },
          { label: tr("Aprobar"), value: "APPROVE" },
        ],
      });
      if (action !== "APPROVE" && action !== "REQUEST_CHANGES" && action !== "COMMENT") return;
      const form = await showForm({
        title:
          action === "APPROVE"
            ? tr("Aprobar #{number}", { number: pr.number })
            : action === "REQUEST_CHANGES"
              ? tr("Pedir cambios en #{number}", { number: pr.number })
              : tr("Comentar revisión en #{number}", { number: pr.number }),
        submitLabel: tr("Enviar revisión"),
        fields: [{ key: "body", label: tr("Comentario"), value: "", multiline: true, required: action !== "APPROVE" }],
      });
      if (!form) return;
      try {
        await reviewPull(repo!.owner, repo!.repo, pr.number, action as ReviewEvent, form.body);
        setStatus(tr("Revisión enviada"), 4000);
        await openDetail(pr);
      } catch (e) {
        await showDialog({
          title: tr("No se pudo enviar la revisión"),
          message: e instanceof Error ? e.message : String(e),
          buttons: [{ label: tr("Entendido"), value: "ok" }],
        });
      }
    };
    actionBar.append(splitWrap, reviewBtn);
  }

  // Comprobaciones (Checks)
  const checksWrap = h("div", "pr-checks");
  if (checks.length) {
    const sum = checkSummary(checks);
    checksWrap.append(h("div", "pr-files-title", tr("Comprobaciones ({passed}/{total})", { passed: sum.passed, total: sum.total })));
    for (const c of checks) {
      const statusCls =
        c.status !== "completed"
          ? "pending"
          : c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped"
            ? "ok"
            : "fail";
      const icon = statusCls === "ok" ? "✓" : statusCls === "fail" ? "✕" : "●";
      const item = h("button", `pr-check-row ${statusCls}`);
      item.type = "button";
      item.append(h("span", "pr-check-ico", icon), h("span", "pr-check-name", c.name), h("span", "pr-check-st", c.conclusion ?? c.status));
      if (c.html_url) item.onclick = () => void openExternal(c.html_url!);
      checksWrap.append(item);
    }
  }

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
    b.onclick = () =>
      void openDiffRequest({
        title: baseName(f.filename),
        sub: `${f.filename} — #${pr.number} ${pr.title}`,
        path: f.filename,
        note: `+${f.additions} −${f.deletions}`,
        load: () => pullSources(repo!.owner, repo!.repo, pr, base, f),
      });
    fileBox.append(b);
  }

  // Comentarios
  const commentsWrap = h("div", "pr-comments");
  commentsWrap.append(h("div", "pr-files-title", tr("Comentarios ({count})", { count: comments.length })));
  if (!comments.length) commentsWrap.append(h("div", "hist-note", tr("Sin comentarios todavía.")));
  for (const cm of comments) {
    const card = h("div", "pr-comment-card");
    card.append(h("div", "pr-comment-meta", `${cm.user?.login ?? "?"} · ${agoIso(cm.created_at)}`), h("div", "pr-comment-body", cm.body));
    commentsWrap.append(card);
  }
  if (hasToken()) {
    const formBox = h("div", "pr-comment-form");
    const ta = document.createElement("textarea");
    ta.className = "pr-comment-input";
    ta.rows = 2;
    ta.placeholder = tr("Escribe un comentario…");
    const sendBtn = h("button", "foot-btn foot-btn-line", tr("Comentar"));
    sendBtn.type = "button";
    sendBtn.onclick = async () => {
      const txt = ta.value.trim();
      if (!txt) return;
      sendBtn.disabled = true;
      try {
        await addPullComment(repo!.owner, repo!.repo, pr.number, txt);
        ta.value = "";
        setStatus(tr("Comentario publicado"), 3000);
        await openDetail(pr);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e), 5000);
        sendBtn.disabled = false;
      }
    };
    formBox.append(ta, sendBtn);
    commentsWrap.append(formBox);
  }

  wrap.append(
    back,
    head,
    chip,
    meta,
    branch,
    stats,
    text,
    actionBar,
    checksWrap,
    h("div", "pr-files-title", tr("Archivos cambiados")),
    fileBox,
    commentsWrap,
  );
  body().replaceChildren(wrap);
}

/** «Nueva pull request»: la rama actual contra la rama principal (o la que se indique). */
export async function newPull(prefill?: { title?: string; body?: string; issueNumber?: number }): Promise<PullSummary | null> {
  if (!ws.root) {
    setStatus(tr("Abre una carpeta para crear una pull request"));
    return null;
  }
  const found = await resolveRepo();
  if (!found) {
    await showDialog({
      title: tr("Sin repositorio de GitHub"),
      message: tr("Esta carpeta no tiene un remoto de GitHub."),
      buttons: [{ label: tr("Entendido"), value: "ok" }],
    });
    return null;
  }
  if (!hasToken()) {
    body().replaceChildren(
      message(
        tr("Conecta tu cuenta de GitHub para crear pull requests."),
        connectButton(() => void loadPulls()),
      ),
    );
    return null;
  }
  try {
    const [branches, base, log, forkParent] = await Promise.all([
      invoke<{ name: string; current: boolean; upstream: string | null }[]>("git_branches", { root: ws.root }),
      defaultBranch(found.owner, found.repo),
      invoke<{ subject: string }[]>("git_log", { root: ws.root, path: null, skip: 0, limit: 1 }).catch(() => []),
      getRepoForkParent(found.owner, found.repo),
    ]);
    const current = branches.find((b) => b.current);
    const targetOwner = forkParent ? forkParent.owner : found.owner;
    const targetRepo = forkParent ? forkParent.repo : found.repo;
    const targetBase = forkParent ? forkParent.defaultBranch : base;
    const headValue = forkParent ? formatHeadForFork(current?.name ?? "", found.owner) : (current?.name ?? "");
    const problem = newPullProblem({ title: "x", head: current?.name ?? "", base: targetBase, hasUpstream: !!current?.upstream });
    if (problem && !forkParent) {
      await showDialog({ title: tr("Aún no se puede crear"), message: problem, buttons: [{ label: tr("Entendido"), value: "ok" }] });
      return null;
    }
    const values = await showForm({
      title: prefill?.issueNumber ? tr("Nueva pull request para #{number}", { number: prefill.issueNumber }) : tr("Nueva pull request"),
      submitLabel: tr("Crear"),
      fields: [
        {
          key: "title",
          label: tr("Título"),
          value: prefill?.title ?? suggestTitle(log[0]?.subject ?? null, current!.name),
          required: true,
        },
        { key: "body", label: tr("Descripción (opcional)"), value: prefill?.body ?? "", multiline: true },
        { key: "head", label: tr("Rama de origen (o usuario:rama si es fork)"), value: headValue, required: true },
        { key: "base", label: tr("Rama de destino"), value: targetBase, required: true },
      ],
      hint: tr("Se propondrán los cambios de «{branch}» hacia la rama de destino. Se crea en GitHub, en {repo}.", {
        branch: headValue,
        repo: `${targetOwner}/${targetRepo}`,
      }),
    });
    if (!values) return null;
    const finalProblem = newPullProblem({ title: values.title, head: values.head, base: values.base, hasUpstream: true });
    if (finalProblem) {
      await showDialog({ title: tr("Aún no se puede crear"), message: finalProblem, buttons: [{ label: tr("Entendido"), value: "ok" }] });
      return null;
    }
    setStatus(tr("Creando la pull request en GitHub…"), 30000);
    const made = await createPull(targetOwner, targetRepo, {
      title: values.title,
      head: values.head,
      base: values.base,
      body: values.body,
    });
    setStatus(tr("Pull request #{number} creada", { number: made.number }));
    filter = "open";
    syncFilter();
    await loadPulls();
    await openDetail(made);
    return made;
  } catch (e) {
    setStatus(tr("No se pudo crear la pull request"), 4000);
    await showDialog({
      title: tr("No se pudo crear la pull request"),
      message: e instanceof Error ? e.message : String(e),
      buttons: [{ label: tr("Entendido"), value: "ok" }],
    });
    return null;
  }
}

function syncFilter() {
  document
    .querySelectorAll<HTMLButtonElement>("#prs-filter button")
    .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === filter)));
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
  $("prs-refresh").onclick = () => {
    if (detail) void openDetail(detail.pr);
    else void loadPulls();
  };
  $("prs-new").onclick = () => void newPull();
  document.querySelectorAll<HTMLButtonElement>("#prs-filter button").forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.v as typeof filter;
      syncFilter();
      detail = null;
      void loadPulls();
    };
  });
  window.setInterval(() => {
    if (ws.root && visible && !detail && document.visibilityState === "visible" && Date.now() - lastLoad > 20_000) void loadPulls(true);
  }, 5_000);
  window.addEventListener("focus", () => {
    if (ws.root && visible && !detail && Date.now() - lastLoad > 10_000) void loadPulls(true);
  });
}
