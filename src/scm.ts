import { invoke } from "@tauri-apps/api/core";
import { openDiff, closeDiff } from "./diffView";
import { refreshGitDecorations } from "./explorer";
import { onGitChange } from "./git";
import { openFile } from "./groups";
import { fileIcon } from "./icons";
import { setStatus, showDialog } from "./ui";
import { $, baseName, dirName, h } from "./util";
import { canCommit, changeCount, pathsOf, type Change, type Changes } from "./scmModel";
import { ws } from "./workspace";

let changes: Changes | null = null;
let problem = "";
let seq = 0;
let busy = false;

const LABEL: Record<string, string> = { M: "Modificado", A: "Añadido", D: "Eliminado", R: "Renombrado", U: "Sin seguimiento", "!": "Conflicto" };

const msgBox = () => $("scm-msg") as HTMLTextAreaElement;

export async function refreshScm() {
  const id = ++seq;
  if (!ws.root) { changes = null; problem = "Abre una carpeta para ver sus cambios."; paint(); return; }
  try {
    const c = await invoke<Changes>("git_changes", { root: ws.root });
    if (id !== seq) return;
    changes = c; problem = "";
  } catch (e) {
    if (id !== seq) return;
    changes = null; problem = String(e);
  }
  paint();
}

function row(c: Change, staged: boolean): HTMLElement {
  const el = h("div", "scm-row");
  const name = baseName(c.path);
  const dir = dirName(c.path);
  el.append(fileIcon(name), h("span", "scm-name", name));
  if (dir) el.append(h("span", "scm-dir", dir));
  const badge = h("span", `scm-badge-s git-${c.status === "!" ? "C" : c.status}`, c.status);
  badge.title = LABEL[c.status] ?? c.status;
  const btn = h("button", "icon-btn scm-act");
  btn.title = staged ? "Quitar de lo preparado" : c.status === "!" ? "Marcar como resuelto (preparar)" : "Preparar";
  btn.innerHTML = staged ? '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  btn.onclick = (e) => { e.stopPropagation(); void (staged ? unstage([c]) : stage([c])); };
  el.append(btn, badge);
  el.title = `${c.path}${c.orig ? ` (antes ${c.orig})` : ""} — ${LABEL[c.status] ?? ""}`;
  el.onclick = () => {
    if (c.status === "!") { void openFile(`${changes!.top}/${c.path}`); return; }
    void openDiff({ root: ws.root!, top: changes!.top, path: c.path, orig: c.orig, staged, status: c.status });
  };
  return el;
}

function section(title: string, list: Change[], staged: boolean, bulk: (() => void) | null, bulkTitle: string): HTMLElement | null {
  if (!list.length) return null;
  const wrap = h("div", "scm-section");
  const head = h("div", "scm-head");
  head.append(h("span", "scm-title", title), h("span", "scm-count", String(list.length)));
  if (bulk) {
    const b = h("button", "icon-btn scm-bulk");
    b.title = bulkTitle;
    b.innerHTML = staged ? '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    b.onclick = bulk;
    head.append(b);
  }
  wrap.append(head, ...list.map((c) => row(c, staged)));
  return wrap;
}

function paint() {
  const box = $("scm-list");
  box.replaceChildren();
  const count = changeCount(changes);
  const badge = $("scm-badge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
  $("scm-branch").textContent = changes ? `${changes.branch}${changes.ahead ? ` ↑${changes.ahead}` : ""}${changes.behind ? ` ↓${changes.behind}` : ""}` : "";
  const commitBtn = $("scm-commit") as HTMLButtonElement;
  commitBtn.disabled = busy || !canCommit(changes, msgBox().value);
  commitBtn.title = !changes ? "" : !changes.staged.length ? "Prepara al menos un archivo" : !msgBox().value.trim() ? "Escribe un mensaje" : "Confirmar los cambios preparados (Ctrl+Enter)";
  $("scm-compose").hidden = !changes;
  if (!changes) { box.append(h("div", "scm-empty", problem)); return; }
  const parts = [
    section("Conflictos", changes.conflicted, false, null, ""),
    section("Cambios preparados", changes.staged, true, () => void unstage([]), "Quitar todo de lo preparado"),
    section("Cambios", changes.unstaged, false, () => void stage([]), "Preparar todos los cambios"),
  ].filter(Boolean) as HTMLElement[];
  if (!parts.length) box.append(h("div", "scm-empty", "No hay cambios."));
  else box.append(...parts);
}

async function run(what: string, op: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  paint();
  try { await op(); }
  catch (e) { await showDialog({ title: what, message: String(e), buttons: [{ label: "Entendido", value: "ok" }] }); }
  finally { busy = false; }
  closeDiff();
  await refreshScm();
  void refreshGitDecorations();
}

export const stage = (list: Change[]) => run("No se pudo preparar", () => invoke("git_stage", { root: ws.root, paths: pathsOf(list) }));
export const unstage = (list: Change[]) => run("No se pudo quitar de lo preparado", () => invoke("git_unstage", { root: ws.root, paths: pathsOf(list) }));

export async function commitStaged() {
  const message = msgBox().value;
  if (!canCommit(changes, message)) { setStatus(changes?.staged.length ? "Escribe un mensaje para el commit" : "No hay cambios preparados"); return; }
  await run("No se pudo confirmar", async () => {
    const r = await invoke<{ hash: string; summary: string }>("git_commit", { root: ws.root, message });
    msgBox().value = "";
    setStatus(`Commit ${r.hash}: ${r.summary}`);
  });
}

export function initScm() {
  $("scm-commit").onclick = () => void commitStaged();
  $("scm-refresh").onclick = () => void refreshScm();
  msgBox().oninput = () => paint();
  msgBox().onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commitStaged(); } };
  onGitChange(() => void refreshScm());
  window.addEventListener("focus", () => void refreshScm());
  void refreshScm();
}
