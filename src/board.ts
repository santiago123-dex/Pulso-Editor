import { lang, t } from "./i18n";
import { applyMove, COLUMNS, columnOf, groupIssues, labelsForNew, labelsText, parseLabels, planMove, refreshDue, REVIEW_LABEL, sameIssues, upsertIssue, type Column } from "./boardModel";
import { ensureBoardLabel } from "./boardLabels";
import { isChatRoom } from "./chatModel";
import { addLabel, createIssue, deleteIssue, fetchAllIssues, hasToken, isAuthProblem, removeLabel, setIssueState, updateIssue, type Issue } from "./github";
import { bus } from "./core/events";
import { currentRepo } from "./core/repo";
import { readStorage, writeStorage } from "./core/storage";
import { openExternal } from "./external";
import { connectButton } from "./githubConnect";
import { state } from "./settings";
import { setStatus, showDialog, showForm } from "./ui";
import { $, h } from "./util";
import { startWorkOnIssue } from "./workflow/issueWorkflow";
import "./board.css";

interface Repo { owner: string; repo: string }

let repo: Repo | null = null;
let issues: Issue[] = [];
let truncated = false;
let busy = false;
let token = 0;
let lastLoad = 0;
let timer = 0;
let boardSession = 0;
/** Última lectura de cada repositorio en esta sesión: al reabrir el tablero se pinta al instante y se actualiza detrás. */
const cache = new Map<string, { issues: Issue[]; truncated: boolean; at: number }>();
const cacheKey = (r: Repo) => `${r.owner}/${r.repo}`.toLowerCase();

/** Recarga automática: al volver a la ventana (si pasaron 5 s) y, con token, cada 15 s (las consultas sin cambios usan ETag y no gastan cuota). Ver `refreshDue`. */
const MIN_GAP_MS = 5_000;
const INTERVAL_MS = 15_000;
const intervalMs = () => Number(readStorage("pulso.boardInterval")) || INTERVAL_MS;
const minGap = () => Number(readStorage("pulso.boardMinGap")) || MIN_GAP_MS;

const progressLabel = () => state.settings.boardProgressLabel;
const confirmKey = (r: Repo) => `pulso.boardWriteOk:${r.owner}/${r.repo}`;

export const isBoardOpen = () => !$("board-view").hidden;

export function closeBoard() {
  if (repo && issues.length) cache.set(cacheKey(repo), { issues, truncated, at: lastLoad });
  boardSession++;
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
  // La issue que guarda el chat no es trabajo: no sale en el tablero.
  issues = [...open.issues, ...closed.issues].filter((i) => !isChatRoom(i));
  truncated = open.truncated || closed.truncated;
  lastLoad = Date.now();
}

/** Hay un diálogo abierto o una tarjeta arrastrándose: repintar ahora rompería lo que la persona está haciendo. */
const interacting = () => !!document.querySelector(".modal, .board-card.dragging");

async function autoRefresh(trigger: "focus" | "timer") {
  if (!isBoardOpen() || !repo) return;
  if (!refreshDue({ now: Date.now(), last: lastLoad, minGap: minGap(), interval: intervalMs(), trigger, hasToken: hasToken(), visible: document.visibilityState === "visible", busy, blocked: interacting() })) return;
  const before = issues;
  try { await load(); } catch { return; }
  if (!isBoardOpen()) return;
  if (sameIssues(before, issues)) { issues = before; return; }
  if (interacting()) return;
  paint();
  setStatus(t("El tablero se actualizó con cambios de GitHub"), 4000);
}

const onFocus = () => void autoRefresh("focus");
// Abrir otra superficie grande (el chat) cierra el tablero.
bus.on("overlay", (kind) => { if (kind !== "board" && isBoardOpen()) closeBoard(); });

export async function openBoard(): Promise<boolean> {
  bus.emit("overlay", "board");
  const root = $("board-view");
  closeBoard();
  const session = boardSession;
  repo = null;
  root.hidden = false;
  window.addEventListener("keydown", onKey, true);
  root.replaceChildren(shell(t("Cargando issues…")));
  const found = await currentRepo();
  if (session !== boardSession) return false;
  if (!found) { root.replaceChildren(shell(t("Esta carpeta no tiene un remoto de GitHub, así que no hay issues que mostrar."))); return false; }
  repo = found;
  const cached = cache.get(cacheKey(found));
  if (cached) { issues = cached.issues; truncated = cached.truncated; lastLoad = cached.at; paint(); }
  else { issues = []; truncated = false; paint(true); }
  const before = issues;
  try { await load(); }
  catch (e) {
    if (session !== boardSession) return false;
    // Con una copia ya pintada se conserva y solo se avisa; sin ella se explica el fallo.
    if (cached) { setStatus(t("No se pudo actualizar el tablero: {error}", { error: e instanceof Error ? e.message : String(e) }), 8000); }
    else { root.replaceChildren(shell(String(e instanceof Error ? e.message : e), isAuthProblem(e) ? () => void openBoard() : undefined)); return false; }
  }
  if (session !== boardSession) return false;
  if (!cached || !sameIssues(before, issues)) paint();
  window.addEventListener("focus", onFocus);
  timer = window.setInterval(() => void autoRefresh("timer"), intervalMs() / 4);
  return true;
}

export async function createIssueFromSidebar() {
  if (await openBoard()) await newIssue("todo");
}

function shell(message: string, reconnect?: () => void): HTMLElement {
  const wrap = h("div", "board-shell");
  const head = h("div", "board-head");
  head.append(h("span", "board-title", t("Tablero de issues")), h("span", "grow"));
  const close = h("button", "icon-btn board-close");
  close.title = t("Cerrar (Esc)");
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeBoard;
  head.append(close);
  const msg = h("div", "board-msg", message);
  if (reconnect) { msg.append(h("br"), connectButton(reconnect)); }
  wrap.append(head, msg);
  return wrap;
}

let justDragged = false;

/**
 * Arrastre con el puntero (no con el arrastrar y soltar de HTML5, que dentro de la ventana de la aplicación no es fiable).
 * Hasta moverse 6 px es un clic normal; al soltar sobre una columna, la tarjeta se mueve.
 */
function startDrag(down: PointerEvent, el: HTMLElement, number: number) {
  if (down.button !== 0 || (down.target as HTMLElement).closest(".board-open")) return;
  const sx = down.clientX, sy = down.clientY;
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  const colAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".board-col") ?? null;
  const setOver = (c: HTMLElement | null) => { if (c !== over) { over?.classList.remove("over"); c?.classList.add("over"); over = c; } };
  const onMove = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      const r = el.getBoundingClientRect();
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("board-ghost");
      ghost.style.width = `${r.width}px`;
      // Dentro del tablero para heredar sus estilos (avatares, etiquetas…); fuera, la foto saldría a tamaño real.
      $("board-view").append(ghost);
      el.classList.add("dragging");
      document.body.classList.add("board-dragging");
    }
    ghost.style.transform = `translate(${e.clientX - 20}px, ${e.clientY - 16}px)`;
    setOver(colAt(e.clientX, e.clientY));
  };
  const finish = (e: PointerEvent | null, commit: boolean) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onEsc, true);
    const dragged = !!ghost;
    ghost?.remove();
    el.classList.remove("dragging");
    document.body.classList.remove("board-dragging");
    const target = commit && e ? colAt(e.clientX, e.clientY) : null;
    setOver(null);
    if (dragged) {
      justDragged = true;
      window.setTimeout(() => { justDragged = false; }, 0);
      if (target) void move(number, target.dataset.col as Column);
    }
  };
  const onUp = (e: PointerEvent) => finish(e, true);
  const onCancel = () => finish(null, false);
  const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); finish(null, false); } };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onEsc, true);
}

function card(i: Issue): HTMLElement {
  const el = h("div", "board-card");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", t("Editar issue #{number}: {title}", { number: i.number, title: i.title }));
  // Sin `draggable`: el arrastre nativo del navegador cancelaría los eventos de puntero con los que se mueve la tarjeta.
  el.draggable = false;
  el.ondragstart = (e) => e.preventDefault();
  el.dataset.number = String(i.number);
  el.title = t("Haz clic para editarla; arrástrala a otra columna para cambiar su estado en GitHub");
  const top = h("div", "board-card-top");
  top.append(h("span", "issue-num", `#${i.number}`));
  const assigned = h("div", "board-avatars");
  for (const person of (i.assignees ?? []).slice(0, 3)) {
    const avatarUrl = (person as { avatar_url?: string }).avatar_url;
    if (!avatarUrl) continue;
    try {
      const url = new URL(avatarUrl);
      if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com") continue;
      const img = document.createElement("img"); img.draggable = false; img.src = url.href; img.alt = person.login; img.title = person.login; img.loading = "lazy"; assigned.append(img);
    } catch { /* El avatar es opcional. */ }
  }
  top.append(assigned);
  const open = h("button", "icon-btn board-open");
  open.title = t("Abrir en GitHub");
  open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>';
  open.onclick = (e) => { e.stopPropagation(); void openExternal(i.html_url); };
  const done = columnOf(i, progressLabel()) === "done";
  const toggle = h("button", "icon-btn board-open");
  toggle.title = done ? t("Reabrir la issue") : t("Cerrar la issue");
  toggle.innerHTML = done
    ? '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 1 2.3 5.7M4 18v-5h5"/></svg>'
    : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';
  toggle.onclick = (e) => { e.stopPropagation(); void move(i.number, done ? "todo" : "done"); };
  const del = h("button", "icon-btn board-open board-del");
  del.title = t("Eliminar la issue");
  del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"/></svg>';
  del.onclick = (e) => { e.stopPropagation(); void deleteCard(i.number); };
  const actions = h("div", "board-card-actions");
  if (!done) {
    const work = h("button", "icon-btn board-open board-work");
    work.title = t("Trabajar en esta issue (rama + contexto IA)");
    work.setAttribute("aria-label", t("Trabajar en la issue #{number}", { number: i.number }));
    work.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    work.onclick = (e) => {
      e.stopPropagation();
      void startWorkOnIssue(i).then((ok) => { if (ok) closeBoard(); });
    };
    actions.append(work);
  }
  actions.append(toggle, del, open);
  top.append(actions);
  const meta = h("div", "board-card-meta");
  for (const l of i.labels) {
    const s = h("span", "label", l.name);
    if (/^[0-9a-f]{6}$/i.test(l.color)) s.style.setProperty("--label-color", `#${l.color}`);
    meta.append(s);
  }
  const who = i.assignees?.length ? i.assignees.map((a) => a.login).join(", ") : i.user.login;
  const foot = h("div", "board-card-foot", `${who}${i.comments ? ` · ${i.comments} comentarios` : ""}`);
  el.append(top, h("div", "board-card-title", i.title), meta, foot);
  el.onclick = () => { if (justDragged) { justDragged = false; return; } void editCard(i.number); };
  el.onkeydown = (e) => {
    if (e.target !== el) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void editCard(i.number); return; }
    // Alt+←/→ mueve la tarjeta a la columna vecina (alternativa al arrastre).
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const here = columnOf(i, progressLabel());
      const at = COLUMNS.findIndex((c) => c.id === here) + (e.key === "ArrowRight" ? 1 : -1);
      if (at >= 0 && at < COLUMNS.length) void move(i.number, COLUMNS[at].id);
    }
  };
  el.onpointerdown = (e) => startDrag(e, el, i.number);
  return el;
}

function paint(loading = false) {
  if (!repo) return;
  const root = $("board-view");
  const wrap = h("div", "board-shell");
  const head = h("div", "board-head");
  const title = h("span", "board-title", t("Tablero de issues"));
  // Cómo se decide la columna: útil al configurar, ruido el resto del tiempo.
  title.title = t("Columnas: «En curso» = etiqueta {progress} · «En revisión» = etiqueta {review} · «Hecho» = issue cerrada", { progress: progressLabel(), review: REVIEW_LABEL });
  head.append(title, h("span", "board-repo", `${repo.owner}/${repo.repo}`), h("span", "grow"));
  const fresh = h("button", "diff-btn primary", t("+ Nueva issue"));
  fresh.title = t("Crear una issue en «Por hacer»");
  fresh.disabled = loading;
  fresh.onclick = () => void newIssue("todo");
  const reload = h("button", "diff-btn", t("Recargar"));
  reload.title = lastLoad ? t("Última lectura: {time}", { time: new Date(lastLoad).toLocaleTimeString(lang()) }) : t("Recargar");
  reload.onclick = () => void refresh();
  const close = h("button", "icon-btn board-close");
  close.title = t("Cerrar (Esc)");
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeBoard;
  head.append(fresh, reload, close);

  const groups = groupIssues(issues, progressLabel());
  const cols = h("div", "board-cols");
  for (const c of COLUMNS) {
    const col = h("div", "board-col");
    col.dataset.col = c.id;
    const ch = h("div", "board-col-head");
    ch.append(h("span", `board-dot board-dot-${c.id}`));
    ch.append(h("span", "board-col-title", c.title), h("span", "board-col-count", String(groups[c.id].length)));
    const body = h("div", "board-col-body");
    if (loading) {
      body.append(h("div", "board-skeleton"), h("div", "board-skeleton board-skeleton-short"));
    } else if (!groups[c.id].length) {
      body.append(h("div", "board-empty", c.id === "done" ? t("Sin issues cerradas") : t("Arrastra una tarjeta aquí")));
    }
    for (const i of groups[c.id]) body.append(card(i));
    col.append(ch, body);
    // El botón de añadir va fijo al pie de cada columna: siempre a la vista y en el mismo sitio, aunque haya muchas tarjetas.
    if (c.id !== "done" && !loading) {
      const add = h("button", "board-add", t("+ Nueva issue"));
      add.title = t("Crear una issue en «{column}»", { column: c.title });
      add.onclick = () => void newIssue(c.id);
      col.append(add);
    }
    cols.append(col);
  }
  wrap.append(head, cols);
  if (truncated) wrap.append(h("div", "board-note", t("Se muestran las issues más recientes de cada estado (hasta 300 abiertas y 100 cerradas); hay más en GitHub.")));
  root.replaceChildren(wrap);
}

async function refresh() {
  try { await load(); paint(); }
  catch (e) { setStatus(String(e instanceof Error ? e.message : e)); }
}

async function ensureCanWrite(): Promise<boolean> {
  if (!repo) return false;
  if (!hasToken()) {
    await showDialog({
      title: t("Falta el token de GitHub"),
      message: t("Para crear o modificar issues hace falta un token con permiso de escritura en las issues. Configúralo en Configuración → GitHub."),
      buttons: [{ label: t("Entendido"), value: "ok" }],
    });
    return false;
  }
  if (readStorage(confirmKey(repo))) return true;
  const r = await showDialog({
    title: t("El tablero modifica GitHub"),
    message: t("Crear o editar una issue, y mover tarjetas entre columnas, modifica {repo} con tu token. El tablero puede crear etiquetas para los estados si no existen.", { repo: `${repo.owner}/${repo.repo}` }),
    buttons: [{ label: t("Cancelar"), value: "cancel" }, { label: t("Entendido, continuar"), value: "ok", primary: true }],
  });
  if (r !== "ok") return false;
  writeStorage(confirmKey(repo), "1");
  return true;
}

/** Avisa al resto de la interfaz (la lista lateral de issues) de que algo cambió en GitHub. */
function announceChange() { bus.emit("issues-changed"); }

async function deleteCard(number: number) {
  const current = issues.find((i) => i.number === number);
  if (!current || !repo || busy) return;
  const choice = await showDialog({
    title: t("Eliminar #{number}", { number }),
    message: t("«{title}» se borrará para siempre de GitHub, con sus comentarios. No se puede deshacer.", { title: current.title }) + "\n\n" + t("Si solo quieres sacarla del tablero, ciérrala: se conserva en «Hecho»."),
    buttons: [
      { label: t("Cancelar"), value: "cancel" },
      { label: t("Cerrar en su lugar"), value: "close" },
      { label: t("Eliminar para siempre"), value: "delete", danger: true },
    ],
  });
  if (choice === "close") { void move(number, "done"); return; }
  if (choice !== "delete") return;
  if (!(await ensureCanWrite())) return;
  if (!current.node_id) {
    await showDialog({ title: t("No se pudo eliminar #{number}", { number }), message: t("Falta el identificador de la issue. Pulsa «Recargar» e inténtalo de nuevo."), buttons: [{ label: t("Entendido"), value: "ok" }] });
    return;
  }
  busy = true;
  setStatus(t("Eliminando #{number} en GitHub…", { number }), 30000);
  try {
    await deleteIssue(current.node_id);
    issues = issues.filter((i) => i.number !== number);
    paint();
    setStatus(t("#{number} eliminada de GitHub", { number }));
    announceChange();
  } catch (e) {
    await showDialog({ title: t("No se pudo eliminar #{number}", { number }), message: e instanceof Error ? e.message : String(e), buttons: [{ label: t("Entendido"), value: "ok" }] });
  } finally {
    busy = false;
  }
}

/** Editar o eliminar una issue desde la lista lateral: se abre el tablero y se continúa allí. */
export async function editIssueNumber(number: number) { if (await openBoard()) await editCard(number); }
export async function deleteIssueNumber(number: number) { if (await openBoard()) await deleteCard(number); }

async function newIssue(col: Column) {
  if (!repo || busy) return;
  const values = await showForm({
    title: t("Nueva issue en «{column}»", { column: COLUMNS.find((c) => c.id === col)!.title }),
    submitLabel: t("Crear"),
    fields: [
      { key: "title", label: t("Título"), required: true, placeholder: t("Qué hay que hacer") },
      { key: "body", label: t("Descripción (opcional)"), multiline: true },
      { key: "labels", label: t("Etiquetas (separadas por comas)"), placeholder: "bug, ui" },
    ],
    hint: col === "doing" || col === "review" ? t("Se usará la etiqueta «{label}»; si no existe se creará en GitHub.", { label: col === "review" ? REVIEW_LABEL : progressLabel() }) : undefined,
  });
  if (!values) return;
  if (!(await ensureCanWrite())) return;
  busy = true;
  setStatus(t("Creando la issue en GitHub…"), 30000);
  try {
    if (progressLabel().trim().toLowerCase() === REVIEW_LABEL && (col === "doing" || col === "review")) throw new Error(t("La etiqueta de progreso coincide con «{label}». Cambia la etiqueta de progreso en Configuración.", { label: REVIEW_LABEL }));
    if (col === "doing" || col === "review") await ensureBoardLabel(repo.owner, repo.repo, col === "review" ? REVIEW_LABEL : progressLabel());
    const labels = parseLabels([values.labels, ...labelsForNew(col, progressLabel())].filter(Boolean).join(","));
    const created = await createIssue(repo.owner, repo.repo, { title: values.title, body: values.body, labels });
    issues = upsertIssue(issues, created);
    paint();
    setStatus(t("Issue #{number} creada en GitHub", { number: created.number }));
    announceChange();
  } catch (e) {
    await showDialog({ title: t("No se pudo crear la issue"), message: e instanceof Error ? e.message : String(e), buttons: [{ label: t("Entendido"), value: "ok" }] });
  } finally {
    busy = false;
  }
}

async function editCard(number: number) {
  const current = issues.find((i) => i.number === number);
  if (!current || !repo || busy) return;
  const values = await showForm({
    title: t("Editar #{number}", { number }),
    submitLabel: t("Guardar"),
    fields: [
      { key: "title", label: t("Título"), value: current.title, required: true },
      { key: "body", label: t("Descripción"), value: current.body ?? "", multiline: true },
      { key: "labels", label: t("Etiquetas (separadas por comas)"), value: labelsText(current) },
    ],
    hint: t("Las etiquetas reemplazan a las actuales. Quitar o poner «{label}» cambia la columna de la tarjeta.", { label: progressLabel() }),
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
  setStatus(t("Guardando #{number} en GitHub…", { number }), 30000);
  try {
    const updated = await updateIssue(repo.owner, repo.repo, number, patch);
    issues = upsertIssue(issues, { ...current, ...updated, labels: updated.labels ?? current.labels });
    paint();
    setStatus(t("#{number} actualizada en GitHub", { number }));
    announceChange();
  } catch (e) {
    await showDialog({ title: t("No se pudo guardar #{number}", { number }), message: e instanceof Error ? e.message : String(e), buttons: [{ label: t("Entendido"), value: "ok" }] });
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
  setStatus(t("Moviendo #{number} a «{column}»…", { number, column: COLUMNS.find((c) => c.id === to)!.title }), 30000);
  try {
    if (progressLabel().trim().toLowerCase() === REVIEW_LABEL) throw new Error(t("La etiqueta de progreso coincide con «{label}». Cambia la etiqueta de progreso en Configuración.", { label: REVIEW_LABEL }));
    for (const step of steps) if (step.op === "addLabel") await ensureBoardLabel(repo.owner, repo.repo, step.label!);
    for (const s of steps) {
      if (s.op === "addLabel") await addLabel(repo.owner, repo.repo, number, s.label!);
      else if (s.op === "removeLabel") await removeLabel(repo.owner, repo.repo, number, s.label!);
      else await setIssueState(repo.owner, repo.repo, number, s.op === "close" ? "closed" : "open");
    }
    setStatus(t("#{number} ahora está en «{column}»", { number, column: COLUMNS.find((c) => columnOf(issues.find((i) => i.number === number)!, progressLabel()) === c.id)!.title }));
    announceChange();
  } catch (e) {
    await showDialog({
      title: t("No se pudo mover #{number}", { number }),
      message: (e instanceof Error ? e.message : String(e)) + "\n\n" + t("Se vuelve a leer el estado real desde GitHub."),
      buttons: [{ label: t("Entendido"), value: "ok" }],
    });
    await refresh();
  } finally {
    busy = false;
  }
}
