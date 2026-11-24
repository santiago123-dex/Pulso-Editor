import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { bus } from "./core/events";
import { openDiff, closeDiff } from "./diffView";
import { checkExternal } from "./docs";
import { refreshGitDecorations, refreshTree } from "./explorer";
import { onGitChange } from "./git";
import { openFile } from "./groups";
import { fileIcon } from "./icons";
import { promptText, quickPick, setStatus, showDialog, type PickItem } from "./ui";
import { $, baseName, dirName, h } from "./util";
import { canCommit, changeCount, discardMessage, lastLine, pathsOf, syncInfo, type Branch, type Change, type Changes } from "./scmModel";
import { ws } from "./workspace";
import { currentRepo } from "./core/repo";
import { fetchIssues, type Issue } from "./github";
import { clearActiveIssueWork, getActiveIssueWork, setActiveIssueWork } from "./workflow/issueWorkflow";

let changes: Changes | null = null;
let opState: "merge" | "rebase" | null = null;
/** Raíz del repositorio de la carpeta abierta, o null si no es un repositorio. */
export const gitTop = (): string | null => changes?.top ?? null;
let problem = "";
let seq = 0;
let busy = false;

const LABEL: Record<string, string> = {
  M: t("Modificado"),
  A: t("Añadido"),
  D: t("Eliminado"),
  R: t("Renombrado"),
  U: t("Sin seguimiento"),
  "!": t("Conflicto"),
};

const msgBox = () => $("scm-msg") as HTMLTextAreaElement;

/** Al cambiar o cerrar carpeta se limpia el estado y el borrador de commit del proyecto anterior. */
export function resetScm() {
  seq++;
  changes = null;
  problem = "";
  msgBox().value = "";
  paint();
  void refreshScm();
}

export async function refreshScm() {
  const id = ++seq;
  if (!ws.root) {
    changes = null;
    opState = null;
    problem = t("Abre una carpeta para ver sus cambios.");
    paint();
    return;
  }
  try {
    const [c, op] = await Promise.all([
      invoke<Changes>("git_changes", { root: ws.root }),
      invoke<{ kind: "merge" | "rebase" | null }>("git_operation_state", { root: ws.root }).catch(() => ({ kind: null })),
    ]);
    if (id !== seq) return;
    changes = c;
    opState = op.kind;
    problem = "";
    bus.emit("scm-refreshed");
  } catch (e) {
    if (id !== seq) return;
    changes = null;
    opState = null;
    problem = String(e);
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
  btn.title = staged ? t("Quitar de lo preparado") : c.status === "!" ? t("Marcar como resuelto (preparar)") : t("Preparar");
  btn.innerHTML = staged
    ? '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  btn.onclick = (e) => {
    e.stopPropagation();
    void (staged ? unstage([c]) : stage([c]));
  };
  if (!staged && c.status !== "!") {
    const drop = h("button", "icon-btn scm-act scm-drop");
    drop.title = c.status === "U" ? t("Descartar (a la papelera)") : t("Descartar cambios");
    drop.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
    drop.onclick = (e) => {
      e.stopPropagation();
      void discard([c]);
    };
    el.append(drop);
  }
  el.append(btn, badge);
  el.title = `${c.path}${c.orig ? ` (antes ${c.orig})` : ""} — ${LABEL[c.status] ?? ""}`;
  el.onclick = () => {
    if (c.status === "!") {
      void openFile(`${changes!.top}/${c.path}`);
      return;
    }
    void openDiff({ root: ws.root!, top: changes!.top, path: c.path, orig: c.orig, staged, status: c.status }, () => refreshScm());
  };
  return el;
}

function section(
  title: string,
  list: Change[],
  staged: boolean,
  bulk: (() => void) | null,
  bulkTitle: string,
  drop?: () => void,
): HTMLElement | null {
  if (!list.length) return null;
  const wrap = h("div", "scm-section");
  const head = h("div", "scm-head");
  head.append(h("span", "scm-title", title), h("span", "scm-count", String(list.length)));
  if (drop) {
    const d = h("button", "icon-btn scm-bulk-drop");
    d.title = t("Descartar todos los cambios");
    d.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
    d.onclick = drop;
    head.append(d);
  }
  if (bulk) {
    const b = h("button", "icon-btn scm-bulk");
    b.title = bulkTitle;
    b.innerHTML = staged
      ? '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    b.onclick = bulk;
    head.append(b);
  }
  wrap.append(head, ...list.map((c) => row(c, staged)));
  return wrap;
}

function syncCommitButton() {
  const commitBtn = $("scm-commit") as HTMLButtonElement;
  commitBtn.disabled = busy || !canCommit(changes, msgBox().value);
  commitBtn.title = !changes
    ? ""
    : !changes.staged.length
      ? t("Prepara al menos un archivo")
      : !msgBox().value.trim()
        ? t("Escribe un mensaje")
        : t("Confirmar los cambios preparados (Ctrl+Enter)");
}

function paint() {
  const box = $("scm-list");
  box.replaceChildren();
  const count = changeCount(changes);
  const badge = $("scm-badge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
  $("scm-bar").hidden = !changes;
  $("scm-branch-btn").textContent = changes ? `⎇ ${changes.branch}` : "";
  const sync = syncInfo(changes);
  $("scm-pull-n").textContent = sync.pull;
  $("scm-push-n").textContent = sync.push;
  $("scm-pull").title = sync.pullTip;
  $("scm-push").title = sync.pushTip;
  ($("scm-pull") as HTMLButtonElement).disabled = busy;
  ($("scm-push") as HTMLButtonElement).disabled = busy;
  syncCommitButton();
  $("scm-compose").hidden = !changes;
  if (!changes) {
    box.append(h("div", "scm-empty", problem));
    return;
  }
  if (opState) {
    const banner = h("div", "scm-op-banner");
    banner.append(h("span", "scm-op-label", opState === "merge" ? t("Fusión en curso") : t("Rebase en curso")));
    const cont = h("button", "scm-op-btn primary", t("Continuar"));
    cont.type = "button";
    cont.disabled = busy;
    cont.onclick = () => void continueGitOperation();
    const ab = h("button", "scm-op-btn danger", t("Abortar"));
    ab.type = "button";
    ab.disabled = busy;
    ab.onclick = () => void abortGitOperation();
    banner.append(cont, ab);
    box.append(banner);
  }
  const activeIssue = getActiveIssueWork();
  const issueBar = h("div", "scm-issue-bar");
  if (activeIssue) {
    issueBar.append(h("span", "scm-issue-tag", `#${activeIssue.number} ${activeIssue.title}`));
    const ins = h("button", "scm-op-btn", t("Referenciar"));
    ins.type = "button";
    ins.title = t("Añadir «Fixes #{number}» al mensaje del commit", { number: activeIssue.number });
    ins.onclick = () => {
      const boxEl = msgBox();
      const ref = `Fixes #${activeIssue.number}`;
      if (!boxEl.value.includes(`#${activeIssue.number}`)) {
        boxEl.value = boxEl.value.trim() ? `${boxEl.value.trimEnd()}\n\n${ref}` : `${activeIssue.title}\n\n${ref}`;
        syncCommitButton();
      }
      boxEl.focus();
    };
    const unlink = h("button", "icon-btn");
    unlink.type = "button";
    unlink.title = t("Desvincular issue");
    unlink.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    unlink.onclick = () => {
      clearActiveIssueWork();
      paint();
    };
    issueBar.append(ins, unlink);
  } else {
    const linkBtn = h("button", "scm-op-btn", t("Vincular issue…"));
    linkBtn.type = "button";
    linkBtn.onclick = () => void linkIssueToLocalChanges();
    issueBar.append(linkBtn);
  }
  box.append(issueBar);
  const parts = [
    section(t("Conflictos"), changes.conflicted, false, null, ""),
    section(t("Cambios preparados"), changes.staged, true, () => void unstage([]), t("Quitar todo de lo preparado")),
    section(
      t("Cambios"),
      changes.unstaged,
      false,
      () => void stage([]),
      t("Preparar todos los cambios"),
      () => void discard(changes!.unstaged.filter((c) => c.status !== "!")),
    ),
  ].filter(Boolean) as HTMLElement[];
  if (!parts.length) box.append(h("div", "scm-empty", t("No hay cambios.")));
  else box.append(...parts);
}

async function run(what: string, op: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  paint();
  try {
    await op();
  } catch (e) {
    await showDialog({ title: what, message: String(e), buttons: [{ label: t("Entendido"), value: "ok" }] });
  } finally {
    busy = false;
  }
  closeDiff();
  await refreshScm();
  void refreshGitDecorations();
}

export const stage = (list: Change[]) => run(t("No se pudo preparar"), () => invoke("git_stage", { root: ws.root, paths: pathsOf(list) }));
export const unstage = (list: Change[]) =>
  run(t("No se pudo quitar de lo preparado"), () => invoke("git_unstage", { root: ws.root, paths: pathsOf(list) }));

/** Descarta cambios sin preparar tras confirmar: lo modificado vuelve a su versión y lo nuevo va a la papelera. */
export async function discard(list: Change[]) {
  if (!list.length) return;
  const r = await showDialog({
    title:
      list.length === 1
        ? t("Descartar cambios de {file}", { file: baseName(list[0].path) })
        : t("Descartar {count} cambios", { count: list.length }),
    message: discardMessage(list),
    buttons: [
      { label: t("Cancelar"), value: "cancel" },
      { label: t("Descartar"), value: "ok", danger: true },
    ],
  });
  if (r !== "ok") return;
  await run(t("No se pudo descartar"), async () => {
    const n = await invoke<number>("git_discard", { root: ws.root, items: list.map((c) => ({ path: c.path, status: c.status })) });
    setStatus(`${n} cambio(s) descartados`);
  });
  await checkExternal();
}

/** Después de que git cambie archivos en disco (rama nueva, pull): documentos abiertos y árbol al día. */
async function afterDiskChange() {
  closeDiff();
  await checkExternal();
  await refreshTree();
}

async function switchTo(name: string, create: boolean) {
  await run(create ? t("No se pudo crear la rama") : t("No se pudo cambiar de rama"), async () => {
    await invoke("git_switch", { root: ws.root, name, create });
    setStatus(create ? t("Rama «{name}» creada y activa", { name }) : t("Ahora estás en «{name}»", { name }));
  });
  await afterDiskChange();
}

export async function pickBranch() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para ver sus ramas"));
    return;
  }
  quickPick({
    placeholder: t("Cambiar de rama o crear una nueva"),
    empty: t("No hay ramas"),
    load: async () => {
      let list: Branch[];
      try {
        list = await invoke<Branch[]>("git_branches", { root: ws.root });
      } catch (e) {
        setStatus(String(e));
        return [];
      }
      const items: PickItem[] = [
        {
          label: t("＋ Crear rama nueva…"),
          keywords: "nueva crear new branch",
          run: async () => {
            const name = await promptText({
              title: t("Nombre de la rama nueva"),
              placeholder: "feature/mi-cambio",
              validate: (v) => (v.trim() ? null : t("Escribe un nombre")),
            });
            if (name) await switchTo(name.trim(), true);
          },
        },
      ];
      for (const b of list) {
        items.push({
          label: b.name,
          detail: b.current ? t("rama actual") : b.remote ? t("solo en el remoto") : (b.upstream ?? ""),
          current: b.current,
          run: () => (b.current ? undefined : switchTo(b.name, false)),
        });
      }
      return items;
    },
  });
}

export async function pullChanges() {
  if (!ws.root || busy) return;
  setStatus(t("Trayendo cambios del remoto…"), 120000);
  await run(t("No se pudo traer los cambios"), async () => {
    const out = await invoke<string>("git_pull", { root: ws.root });
    setStatus(lastLine(out) || t("Pull completado"));
  });
  await afterDiskChange();
}

export async function pushChanges() {
  if (!ws.root || busy) return;
  setStatus(t("Subiendo commits al remoto…"), 120000);
  await run(t("No se pudo subir los commits"), async () => {
    const out = await invoke<string>("git_push", { root: ws.root });
    setStatus(lastLine(out) || t("Push completado"));
  });
}

export async function commitStaged() {
  const message = msgBox().value;
  if (!canCommit(changes, message)) {
    setStatus(changes?.staged.length ? t("Escribe un mensaje para el commit") : t("No hay cambios preparados"));
    return;
  }
  await run(t("No se pudo confirmar"), async () => {
    const r = await invoke<{ hash: string; summary: string }>("git_commit", { root: ws.root, message });
    msgBox().value = "";
    setStatus(`Commit ${r.hash}: ${r.summary}`);
  });
}

/** Corrige el último commit (mensaje y/o cambios preparados actualmente). */
export async function amendLastCommit() {
  if (!ws.root || busy) {
    setStatus(t("Abre una carpeta para usar Git"));
    return;
  }
  let prev = "";
  try {
    prev = await invoke<string>("git_last_commit_message", { root: ws.root });
  } catch (e) {
    setStatus(String(e));
    return;
  }
  const currentDraft = msgBox().value.trim();
  const next = await promptText({
    title: t("Corregir el último commit (amend)"),
    value: currentDraft || prev,
    placeholder: prev,
    validate: (v) => (v.trim() ? null : t("Escribe un mensaje")),
  });
  if (!next) return;
  await run(t("No se pudo corregir el último commit"), async () => {
    const r = await invoke<{ hash: string; summary: string }>("git_commit_amend", { root: ws.root, message: next.trim() });
    msgBox().value = "";
    setStatus(t("Commit corregido {hash}: {summary}", { hash: r.hash, summary: r.summary }));
  });
}

/** Renombra una rama local. */
export async function renameBranch() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para ver sus ramas"));
    return;
  }
  quickPick({
    placeholder: t("Elige la rama local a renombrar"),
    empty: t("No hay ramas locales"),
    load: async () => {
      let list: Branch[];
      try {
        list = (await invoke<Branch[]>("git_branches", { root: ws.root })).filter((b) => !b.remote);
      } catch (e) {
        setStatus(String(e));
        return [];
      }
      return list.map<PickItem>((b) => ({
        label: b.name,
        detail: b.current ? t("rama actual") : (b.upstream ?? ""),
        current: b.current,
        run: async () => {
          const next = await promptText({
            title: t("Renombrar rama «{name}»", { name: b.name }),
            value: b.name,
            validate: (v) => (v.trim() && v.trim() !== b.name ? null : t("Escribe un nombre distinto")),
          });
          if (!next) return;
          await run(t("No se pudo renombrar la rama"), async () => {
            await invoke("git_rename_branch", { root: ws.root, oldName: b.name, newName: next.trim() });
            setStatus(t("Rama renombrada a «{name}»", { name: next.trim() }));
          });
        },
      }));
    },
  });
}

/** Elimina una rama local (ofrece forzar si aún no está fusionada). */
export async function deleteBranch() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para ver sus ramas"));
    return;
  }
  quickPick({
    placeholder: t("Elige la rama local a eliminar"),
    empty: t("No hay otras ramas locales que eliminar"),
    load: async () => {
      let list: Branch[];
      try {
        list = (await invoke<Branch[]>("git_branches", { root: ws.root })).filter((b) => !b.remote && !b.current);
      } catch (e) {
        setStatus(String(e));
        return [];
      }
      return list.map<PickItem>((b) => ({
        label: b.name,
        detail: b.upstream ?? "",
        run: async () => {
          const r = await showDialog({
            title: t("Eliminar rama «{name}»", { name: b.name }),
            message: t(
              "Se eliminará la rama local «{name}». Si tiene commits sin fusionar, Git pedirá confirmación para forzar el borrado.",
              { name: b.name },
            ),
            buttons: [
              { label: t("Cancelar"), value: "cancel" },
              { label: t("Eliminar"), value: "ok", danger: true },
            ],
          });
          if (r !== "ok") return;
          try {
            await invoke("git_delete_branch", { root: ws.root, name: b.name, force: false });
            setStatus(t("Rama «{name}» eliminada", { name: b.name }));
            await refreshScm();
            void refreshGitDecorations();
          } catch (e) {
            const msg = String(e);
            const forceRes = await showDialog({
              title: t("La rama «{name}» no está fusionada", { name: b.name }),
              message: `${msg}\n\n${t("¿Quieres forzar su eliminación igualmente?")}`,
              buttons: [
                { label: t("Cancelar"), value: "cancel" },
                { label: t("Forzar eliminación"), value: "force", danger: true },
              ],
            });
            if (forceRes !== "force") return;
            await run(t("No se pudo eliminar la rama"), async () => {
              await invoke("git_delete_branch", { root: ws.root, name: b.name, force: true });
              setStatus(t("Rama «{name}» eliminada", { name: b.name }));
            });
          }
        },
      }));
    },
  });
}

/** Fusiona otra rama dentro de la rama actual (`git merge`). */
export async function mergeBranch() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para ver sus ramas"));
    return;
  }
  quickPick({
    placeholder: t("Elige la rama a fusionar en la rama actual"),
    empty: t("No hay otras ramas disponibles"),
    load: async () => {
      let list: Branch[];
      try {
        list = (await invoke<Branch[]>("git_branches", { root: ws.root })).filter((b) => !b.current);
      } catch (e) {
        setStatus(String(e));
        return [];
      }
      return list.map<PickItem>((b) => ({
        label: b.name,
        detail: b.remote ? t("remota") : (b.upstream ?? ""),
        run: async () => {
          await run(t("No se pudo fusionar la rama"), async () => {
            const res = await invoke<{ status: string; message: string }>("git_merge", { root: ws.root, branch: b.name });
            setStatus(res.status === "conflicts" ? res.message : t("Rama «{name}» fusionada", { name: b.name }), 6000);
          });
          await afterDiskChange();
        },
      }));
    },
  });
}

/** Rebasa la rama actual sobre otra rama (`git rebase`). */
export async function rebaseBranch() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para ver sus ramas"));
    return;
  }
  quickPick({
    placeholder: t("Elige la rama base para rebasar la rama actual"),
    empty: t("No hay otras ramas disponibles"),
    load: async () => {
      let list: Branch[];
      try {
        list = (await invoke<Branch[]>("git_branches", { root: ws.root })).filter((b) => !b.current);
      } catch (e) {
        setStatus(String(e));
        return [];
      }
      return list.map<PickItem>((b) => ({
        label: b.name,
        detail: b.remote ? t("remota") : (b.upstream ?? ""),
        run: async () => {
          await run(t("No se pudo rebasar la rama"), async () => {
            const res = await invoke<{ status: string; message: string }>("git_rebase", { root: ws.root, branch: b.name });
            setStatus(res.status === "conflicts" ? res.message : t("Rebase sobre «{name}» completado", { name: b.name }), 6000);
          });
          await afterDiskChange();
        },
      }));
    },
  });
}

/** Continúa una fusión o rebase detenido por conflictos. */
export async function continueGitOperation() {
  if (!ws.root || busy) return;
  await run(t("No se pudo continuar la operación de Git"), async () => {
    const res = await invoke<{ status: string; message: string }>("git_operation_action", { root: ws.root, action: "continue" });
    setStatus(res.status === "conflicts" ? res.message : t("Operación de Git completada"), 5000);
  });
  await afterDiskChange();
}

/** Aborta una fusión o rebase en curso. */
export async function abortGitOperation() {
  if (!ws.root || busy) return;
  await run(t("No se pudo abortar la operación de Git"), async () => {
    await invoke("git_operation_action", { root: ws.root, action: "abort" });
    setStatus(t("Operación de Git abortada"), 4000);
  });
  await afterDiskChange();
}

/** Vincula una issue abierta de GitHub con los cambios locales actuales. */
export async function linkIssueToLocalChanges() {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para vincular una issue"));
    return;
  }
  const repo = await currentRepo();
  if (!repo) {
    setStatus(t("Esta carpeta no tiene un remoto de GitHub."));
    return;
  }
  quickPick({
    placeholder: t("Elige una issue para vincular a los cambios locales"),
    empty: t("No hay issues abiertas."),
    load: async () => {
      let list: Issue[];
      try {
        list = await fetchIssues(repo.owner, repo.repo, "open");
      } catch (e) {
        setStatus(String(e));
        return [];
      }
      return list.map<PickItem>((i) => ({
        label: `#${i.number} ${i.title}`,
        detail: i.labels.map((l) => l.name).join(", "),
        run: () => {
          setActiveIssueWork({
            owner: repo.owner,
            repo: repo.repo,
            number: i.number,
            title: i.title,
            body: i.body ?? "",
            branch: changes?.branch ?? "",
            html_url: i.html_url,
            startedAt: Date.now(),
          });
          setStatus(t("Issue #{number} vinculada a los cambios locales", { number: i.number }), 4000);
          paint();
        },
      }));
    },
  });
}

export function initScm() {
  $("scm-commit").onclick = () => void commitStaged();
  $("scm-refresh").onclick = () => void refreshScm();
  $("scm-branch-btn").onclick = () => void pickBranch();
  $("scm-pull").onclick = () => void pullChanges();
  $("scm-push").onclick = () => void pushChanges();
  msgBox().oninput = () => syncCommitButton();
  msgBox().onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void commitStaged();
    }
  };
  onGitChange(() => void refreshScm());
  window.addEventListener("focus", () => void refreshScm());
  void refreshScm();
}
