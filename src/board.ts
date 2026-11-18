import { applyMove, COLUMNS, columnOf, groupIssues, labelsForNew, labelsText, parseLabels, planMove, refreshDue, sameIssues, upsertIssue, type Column } from "./boardModel";
import { addLabel, createIssue, fetchAllIssues, getToken, removeLabel, setIssueState, updateIssue, type Issue } from "./github";
import { currentRepo } from "./issues";
import { state } from "./settings";
import { setStatus, showDialog, showForm } from "./ui";
import { $, h } from "./util";

interface Repo { owner: string; repo: string }

let repo: Repo | null = null;
let issues: Issue[] = [];
let truncated = false;
let busy = false;
let token = 0;
let lastLoad = 0;
let timer = 0;

/** Recarga automática: al volver a la ventana (si pasaron 5 s) y, con token, cada minuto. Ver `refreshDue`. */
const MIN_GAP_MS = 5_000;
const INTERVAL_MS = 60_000;
const minGap = () => Number(localStorage.getItem("pulso.boardMinGap")) || MIN_GAP_MS;

const progressLabel = () => state.settings.boardProgressLabel;
const confirmKey = (r: Repo) => `pulso.boardWriteOk:${r.owner}/${r.repo}`;

export const isBoardOpen = () => !$("board-view").hidden;

export function closeBoard() {
  token++;
  clearInterval(timer);
  window.removeEventListener("focus", onFocus);
  $("board-view").hidden = true;
  $("board-view").replaceChildren();
  window.removeEventListener("keydown", onKey, true);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !document.querySelector(".modal")) { e.preventDefault(); e.stopPropagation(); closeBoard(); }
}

async function load() {
  if (!repo) return;
  const mine = ++token;
  const [open, closed] = await Promise.all([
    fetchAllIssues(repo.owner, repo.repo, "open"),
    fetchAllIssues(repo.owner, repo.repo, "closed", 100),
  ]);
  if (mine !== token) return;
  issues = [...open.issues, ...closed.issues];
  truncated = open.truncated || closed.truncated;
  lastLoad = Date.now();
}

/** Hay un diálogo abierto o una tarjeta arrastrándose: repintar ahora rompería lo que la persona está haciendo. */
const interacting = () => !!document.querySelector(".modal, .board-card.dragging");

async function autoRefresh(trigger: "focus" | "timer") {
  if (!isBoardOpen() || !repo) return;
  if (!refreshDue({ now: Date.now(), last: lastLoad, minGap: minGap(), interval: INTERVAL_MS, trigger, hasToken: !!getToken(), visible: document.visibilityState === "visible", busy, blocked: interacting() })) return;
  const before = issues;
  try { await load(); } catch { return; }
  if (!isBoardOpen()) return;
  if (sameIssues(before, issues)) { issues = before; return; }
  if (interacting()) return;
  paint();
  setStatus("El tablero se actualizó con cambios de GitHub", 4000);
}

const onFocus = () => void autoRefresh("focus");

export async function openBoard() {
  const root = $("board-view");
  closeBoard();
  root.hidden = false;
  window.addEventListener("keydown", onKey, true);
  root.replaceChildren(shell("Cargando issues…"));
  const found = await currentRepo();
  if (!found) { root.replaceChildren(shell("Esta carpeta no tiene un remoto de GitHub, así que no hay issues que mostrar.")); return; }
  repo = found;
  try { await load(); }
  catch (e) { root.replaceChildren(shell(String(e instanceof Error ? e.message : e))); return; }
  paint();
  window.addEventListener("focus", onFocus);
  timer = window.setInterval(() => void autoRefresh("timer"), INTERVAL_MS / 4);
}

function shell(message: string): HTMLElement {
  const wrap = h("div", "board-shell");
  const head = h("div", "board-head");
  head.append(h("span", "board-title", "Tablero de issues"), h("span", "grow"));
  const close = h("button", "icon-btn board-close");
  close.title = "Cerrar (Esc)";
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeBoard;
  head.append(close);
  wrap.append(head, h("div", "board-msg", message));
  return wrap;
}

function card(i: Issue): HTMLElement {
  const el = h("div", "board-card");
  el.draggable = true;
  el.dataset.number = String(i.number);
  el.title = "Haz clic para editarla; arrástrala a otra columna para cambiar su estado en GitHub";
  const top = h("div", "board-card-top");
  top.append(h("span", "issue-num", `#${i.number}`));
  const open = h("button", "icon-btn board-open");
  open.title = "Abrir en GitHub";
  open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>';
  open.onclick = (e) => { e.stopPropagation(); window.open(i.html_url, "_blank"); };
  top.append(open);
  const meta = h("div", "board-card-meta");
  for (const l of i.labels) {
    const s = h("span", "label", l.name);
    s.style.background = `#${l.color}`;
    meta.append(s);
  }
  const who = i.assignees?.length ? i.assignees.map((a) => a.login).join(", ") : i.user.login;
  const foot = h("div", "board-card-foot", `${who}${i.comments ? ` · ${i.comments} 💬` : ""}`);
  el.append(top, h("div", "board-card-title", i.title), meta, foot);
  el.onclick = () => void editCard(i.number);
  el.ondragstart = (e) => { e.dataTransfer?.setData("text/plain", String(i.number)); el.classList.add("dragging"); };
  el.ondragend = () => el.classList.remove("dragging");
  return el;
}

function paint() {
  if (!repo) return;
  const root = $("board-view");
  const wrap = h("div", "board-shell");
  const head = h("div", "board-head");
  head.append(h("span", "board-title", "Tablero de issues"), h("span", "board-repo", `${repo.owner}/${repo.repo}`), h("span", "grow"));
  head.append(h("span", "board-hint", `«En curso» = etiqueta «${progressLabel()}»`));
  const fresh = h("button", "diff-btn primary", "Nueva issue");
  fresh.onclick = () => void newIssue("todo");
  const reload = h("button", "diff-btn", "Recargar");
  reload.title = `Última lectura: ${new Date(lastLoad).toLocaleTimeString()}`;
  reload.onclick = () => void refresh();
  const close = h("button", "icon-btn board-close");
  close.title = "Cerrar (Esc)";
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeBoard;
  head.append(fresh, reload, close);

  const groups = groupIssues(issues, progressLabel());
  const cols = h("div", "board-cols");
  for (const c of COLUMNS) {
    const col = h("div", "board-col");
    col.dataset.col = c.id;
    const ch = h("div", "board-col-head");
    ch.append(h("span", "board-col-title", c.title), h("span", "board-col-count", String(groups[c.id].length)));
    if (c.id !== "done") {
      const add = h("button", "icon-btn board-col-add");
      add.title = `Nueva issue en «${c.title}»`;
      add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
      add.onclick = () => void newIssue(c.id);
      ch.append(add);
    }
    const body = h("div", "board-col-body");
    if (!groups[c.id].length) body.append(h("div", "board-empty", c.id === "done" ? "Sin issues cerradas." : "Nada por aquí."));
    for (const i of groups[c.id]) body.append(card(i));
    col.ondragover = (e) => { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget as Node | null)) col.classList.remove("over"); };
    col.ondrop = (e) => {
      e.preventDefault();
      col.classList.remove("over");
      const n = Number(e.dataTransfer?.getData("text/plain"));
      if (n) void move(n, c.id);
    };
    col.append(ch, body);
    cols.append(col);
  }
  wrap.append(head, cols);
  if (truncated) wrap.append(h("div", "board-note", "Se muestran las issues más recientes de cada estado (hasta 300 abiertas y 100 cerradas); hay más en GitHub."));
  root.replaceChildren(wrap);
}

async function refresh() {
  try { await load(); paint(); }
  catch (e) { setStatus(String(e instanceof Error ? e.message : e)); }
}

async function ensureCanWrite(): Promise<boolean> {
  if (!repo) return false;
  if (!getToken()) {
    await showDialog({
      title: "Falta el token de GitHub",
      message: "Para mover tarjetas hace falta un token con permiso de escritura en las issues. Configúralo en Configuración → GitHub.",
      buttons: [{ label: "Entendido", value: "ok" }],
    });
    return false;
  }
  if (localStorage.getItem(confirmKey(repo))) return true;
  const r = await showDialog({
    title: "Mover tarjetas modifica GitHub",
    message: `Arrastrar una tarjeta cambia las etiquetas o cierra y reabre la issue en ${repo.owner}/${repo.repo}, usando tu token. Los cambios se ven de inmediato en GitHub.`,
    buttons: [{ label: "Cancelar", value: "cancel" }, { label: "Entendido, continuar", value: "ok", primary: true }],
  });
  if (r !== "ok") return false;
  localStorage.setItem(confirmKey(repo), "1");
  return true;
}

async function newIssue(col: Column) {
  if (!repo || busy) return;
  const values = await showForm({
    title: `Nueva issue en «${COLUMNS.find((c) => c.id === col)!.title}»`,
    submitLabel: "Crear",
    fields: [
      { key: "title", label: "Título", required: true, placeholder: "Qué hay que hacer" },
      { key: "body", label: "Descripción (opcional)", multiline: true },
      { key: "labels", label: "Etiquetas (separadas por comas)", placeholder: "bug, ui" },
    ],
    hint: col === "doing" ? `Se creará con la etiqueta «${progressLabel()}» para que quede en curso.` : undefined,
  });
  if (!values) return;
  if (!(await ensureCanWrite())) return;
  busy = true;
  setStatus("Creando la issue en GitHub…", 30000);
  try {
    const labels = parseLabels([values.labels, ...labelsForNew(col, progressLabel())].filter(Boolean).join(","));
    const created = await createIssue(repo.owner, repo.repo, { title: values.title, body: values.body, labels });
    issues = upsertIssue(issues, created);
    paint();
    setStatus(`Issue #${created.number} creada en GitHub`);
  } catch (e) {
    await showDialog({ title: "No se pudo crear la issue", message: e instanceof Error ? e.message : String(e), buttons: [{ label: "Entendido", value: "ok" }] });
  } finally {
    busy = false;
  }
}

async function editCard(number: number) {
  const current = issues.find((i) => i.number === number);
  if (!current || !repo || busy) return;
  const values = await showForm({
    title: `Editar #${number}`,
    submitLabel: "Guardar",
    fields: [
      { key: "title", label: "Título", value: current.title, required: true },
      { key: "body", label: "Descripción", value: current.body ?? "", multiline: true },
      { key: "labels", label: "Etiquetas (separadas por comas)", value: labelsText(current) },
    ],
    hint: `Las etiquetas reemplazan a las actuales. Quitar o poner «${progressLabel()}» cambia la columna de la tarjeta.`,
  });
  if (!values) return;
  const patch: { title?: string; body?: string; labels?: string[] } = {};
  if (values.title !== current.title) patch.title = values.title;
  if (values.body !== (current.body ?? "")) patch.body = values.body;
  const labels = parseLabels(values.labels);
  if (labels.join("\u0001").toLowerCase() !== current.labels.map((l) => l.name).join("\u0001").toLowerCase()) patch.labels = labels;
  if (!Object.keys(patch).length) return;
  if (!(await ensureCanWrite())) return;
  busy = true;
  setStatus(`Guardando #${number} en GitHub…`, 30000);
  try {
    const updated = await updateIssue(repo.owner, repo.repo, number, patch);
    issues = upsertIssue(issues, { ...current, ...updated, labels: updated.labels ?? current.labels });
    paint();
    setStatus(`#${number} actualizada en GitHub`);
  } catch (e) {
    await showDialog({ title: `No se pudo guardar #${number}`, message: e instanceof Error ? e.message : String(e), buttons: [{ label: "Entendido", value: "ok" }] });
  } finally {
    busy = false;
  }
}

async function move(number: number, to: Column) {
  const current = issues.find((i) => i.number === number);
  if (!current || !repo || busy) return;
  const steps = planMove(current, to, progressLabel());
  if (!steps.length) return;
  if (!(await ensureCanWrite())) return;
  busy = true;
  // Se muestra el resultado esperado de inmediato; si GitHub falla se vuelve a leer el estado real.
  issues = issues.map((i) => (i.number === number ? applyMove(i, to, progressLabel()) : i));
  paint();
  setStatus(`Moviendo #${number} a «${COLUMNS.find((c) => c.id === to)!.title}»…`, 30000);
  try {
    for (const s of steps) {
      if (s.op === "addLabel") await addLabel(repo.owner, repo.repo, number, s.label!);
      else if (s.op === "removeLabel") await removeLabel(repo.owner, repo.repo, number, s.label!);
      else await setIssueState(repo.owner, repo.repo, number, s.op === "close" ? "closed" : "open");
    }
    setStatus(`#${number} ahora está en «${COLUMNS.find((c) => columnOf(issues.find((i) => i.number === number)!, progressLabel()) === c.id)!.title}»`);
  } catch (e) {
    await showDialog({
      title: `No se pudo mover #${number}`,
      message: `${e instanceof Error ? e.message : e}\n\nSe vuelve a leer el estado real desde GitHub.`,
      buttons: [{ label: "Entendido", value: "ok" }],
    });
    await refresh();
  } finally {
    busy = false;
  }
}
