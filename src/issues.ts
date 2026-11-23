import { t } from "./i18n";
import { bus } from "./core/events";
import { currentRepo } from "./core/repo";
import { fetchIssues, isAuthProblem, type Issue } from "./github";
import { openExternal } from "./external";
import { connectButton } from "./githubConnect";
import { createIssueFromSidebar, deleteIssueNumber, editIssueNumber, openBoard } from "./board";
import { isChatRoom } from "./chatModel";
import { $, h, sel } from "./util";
import { ws } from "./workspace";
import { startWorkOnIssue } from "./workflow/issueWorkflow";

export { currentRepo };

function message(text: string) {
  return h("li", "empty", text);
}

let lastLoad = 0;
let seq = 0;

/** `silent`: actualizar sin vaciar la lista ni mostrar «Cargando…» (al volver a la ventana o tras un cambio). */
export async function loadIssues(silent = false) {
  const id = ++seq;
  const list = $("issues");
  const label = $("repo-label");
  if (!silent) list.replaceChildren();
  if (!ws.root) {
    label.textContent = "";
    list.replaceChildren(message(t("Abre una carpeta para ver las issues de su repositorio.")));
    return;
  }
  const repo = await currentRepo();
  if (id !== seq) return;
  if (!repo) {
    label.textContent = "";
    list.replaceChildren(message(t("Esta carpeta no tiene un remoto de GitHub.")));
    return;
  }
  label.textContent = `${repo.owner}/${repo.repo}`;
  if (!silent) list.append(message(t("Cargando…")));
  try {
    const found = await fetchIssues(repo.owner, repo.repo, sel("issue-state").value);
    if (id !== seq) return;
    lastLoad = Date.now();
    render(found.filter((i) => !isChatRoom(i)));
  } catch (err) {
    if (id !== seq || silent) return;
    const text = err instanceof Error ? err.message : String(err);
    list.replaceChildren(message(text));
    if (isAuthProblem(err)) {
      const li = h("li", "issues-connect");
      li.append(connectButton(() => void loadIssues()));
      list.append(li);
    }
  }
}

function render(issues: Issue[]) {
  const list = $("issues");
  list.replaceChildren();
  if (!issues.length) { list.append(message(t("Sin issues."))); return; }
  for (const i of issues) {
    const li = h("li");
    const title = h("div", "issue-title");
    title.append(h("span", "issue-num", `#${i.number}`), i.title);
    const meta = h("div", "issue-meta");
    for (const l of i.labels) {
      const s = h("span", "label", l.name);
      if (/^[0-9a-f]{6}$/i.test(l.color)) s.style.setProperty("--label-color", `#${l.color}`);
      meta.append(s);
    }
    meta.append(`${i.user.login} · ${t("{count} comentarios", { count: i.comments })}`);
    li.append(title, meta);
    li.title = t("Editar en el tablero");
    li.onclick = () => void editIssueNumber(i.number);
    const actions = h("div", "issue-actions");
    if (i.state === "open") {
      const work = h("button", "icon-btn");
      work.title = t("Trabajar en esta issue (rama + contexto IA)");
      work.setAttribute("aria-label", t("Trabajar en la issue #{number}", { number: i.number }));
      work.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      work.onclick = (e) => { e.stopPropagation(); void startWorkOnIssue(i); };
      actions.append(work);
    }
    const gh = h("button", "icon-btn");
    gh.title = t("Abrir en GitHub");
    gh.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>';
    gh.onclick = (e) => { e.stopPropagation(); void openExternal(i.html_url); };
    const del = h("button", "icon-btn");
    del.title = t("Eliminar la issue");
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"/></svg>';
    del.onclick = (e) => { e.stopPropagation(); void deleteIssueNumber(i.number); };
    actions.append(gh, del);
    li.append(actions);
    list.append(li);
  }
}

export function initIssues() {
  $("refresh-issues").onclick = () => void loadIssues();
  sel("issue-state").onchange = () => void loadIssues();
  // El filtro son pestañas; el <select> oculto conserva el valor para el resto del código.
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#issue-filter button"));
  for (const tab of tabs) {
    tab.onclick = () => {
      sel("issue-state").value = tab.dataset.v!;
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      sel("issue-state").dispatchEvent(new Event("change"));
    };
  }
  $("open-board").onclick = () => void openBoard();
  $("new-issue-btn").onclick = () => void createIssueFromSidebar();
  // Lo que cambia el tablero (crear, editar, cerrar, eliminar) y lo que pasa en GitHub mientras no mirabas se refleja aquí.
  bus.on("issues-changed", () => { if (!$("view-issues").hidden) void loadIssues(true); });
  window.setInterval(() => { if (ws.root && !$("view-issues").hidden && document.visibilityState === "visible" && Date.now() - lastLoad > 15_000) void loadIssues(true); }, 5_000);
  window.addEventListener("focus", () => { if (ws.root && !$("view-issues").hidden && Date.now() - lastLoad > 10_000) void loadIssues(true); });
}
