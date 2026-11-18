import { invoke } from "@tauri-apps/api/core";
import { fetchIssues, parseRemote, type Issue } from "./github";
import { openBoard } from "./board";
import { $, h, sel } from "./util";
import { ws } from "./workspace";

function message(text: string) {
  return h("li", "empty", text);
}

/** Propietario y nombre del repositorio de GitHub de la carpeta abierta, o null si no hay carpeta o remoto. */
export async function currentRepo(): Promise<{ owner: string; repo: string } | null> {
  if (!ws.root) return null;
  try { return parseRemote(await invoke<string>("git_remote", { path: ws.root })); }
  catch { return null; }
}

export async function loadIssues() {
  const list = $("issues");
  const label = $("repo-label");
  list.replaceChildren();
  if (!ws.root) {
    label.textContent = "";
    list.append(message("Abre una carpeta para ver las issues de su repositorio."));
    return;
  }
  let repo = null;
  try {
    repo = parseRemote(await invoke<string>("git_remote", { path: ws.root }));
  } catch { /* sin remoto */ }
  if (!repo) {
    label.textContent = "";
    list.append(message("Esta carpeta no tiene un remoto de GitHub."));
    return;
  }
  label.textContent = `${repo.owner}/${repo.repo}`;
  list.append(message("Cargando…"));
  try {
    render(await fetchIssues(repo.owner, repo.repo, sel("issue-state").value));
  } catch (err) {
    list.replaceChildren(message(`${err}. Si el repo es privado, configura un token en Configuración.`));
  }
}

function render(issues: Issue[]) {
  const list = $("issues");
  list.replaceChildren();
  if (!issues.length) { list.append(message("Sin issues.")); return; }
  for (const i of issues) {
    const li = h("li");
    const title = h("div", "issue-title");
    title.append(h("span", "issue-num", `#${i.number}`), i.title);
    const meta = h("div", "issue-meta");
    for (const l of i.labels) {
      const s = h("span", "label", l.name);
      s.style.background = `#${l.color}`;
      meta.append(s);
    }
    meta.append(`${i.user.login} · ${i.comments} comentarios`);
    li.append(title, meta);
    li.onclick = () => window.open(i.html_url, "_blank");
    list.append(li);
  }
}

export function initIssues() {
  $("refresh-issues").onclick = () => void loadIssues();
  sel("issue-state").onchange = () => void loadIssues();
  $("open-board").onclick = () => void openBoard();
}
