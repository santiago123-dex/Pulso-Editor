import { invoke } from "@tauri-apps/api/core";
import { ensureBoardLabel } from "../boardLabels";
import { REVIEW_LABEL } from "../boardModel";
import { bus } from "../core/events";
import { currentRepo } from "../core/repo";
import { readJsonStorage, removeStorage, writeJsonStorage } from "../core/storage";
import { closeDiff, openDiffRequest } from "../diffView";
import { checkExternal, findOpenDoc } from "../docs";
import { refreshTree } from "../explorer";
import { addLabel, hasToken, removeLabel, type Issue } from "../github";
import { openFile } from "../groups";
import { newPull } from "../prs";
import { refreshScm } from "../scm";
import { state } from "../settings";
import { promptText, setStatus } from "../ui";
import { baseName } from "../util";
import { ws } from "../workspace";
import {
  branchNameForIssue,
  buildIssuePrompt,
  buildPrDraft,
  isSafeRelativeEditPath,
  type ActiveIssueWork,
  type ProposedFileEdit,
} from "./issueWorkflowModel";

const keyFor = (root: string) => `pulso.activeIssue:${root.replace(/\\/g, "/").toLowerCase()}`;

export function getActiveIssueWork(): ActiveIssueWork | null {
  if (!ws.root) return null;
  return readJsonStorage<ActiveIssueWork | null>(keyFor(ws.root), null);
}

export function setActiveIssueWork(work: ActiveIssueWork | null): void {
  if (!ws.root) return;
  if (!work) removeStorage(keyFor(ws.root));
  else writeJsonStorage(keyFor(ws.root), work);
}

export function clearActiveIssueWork(): void {
  setActiveIssueWork(null);
}

/**
 * Inicia el flujo completo sobre una issue:
 * 1. Confirma o ajusta el nombre de la rama (`feat/42-...` o `fix/42-...`).
 * 2. Crea o cambia a esa rama en Git.
 * 3. Mueve la issue a «En curso» en GitHub (si hay token conectado).
 * 4. Guarda la issue activa y abre el asistente de IA precargado con el contexto.
 */
export async function startWorkOnIssue(issue: Issue): Promise<boolean> {
  if (!ws.root) {
    setStatus("Abre una carpeta de proyecto para trabajar en una issue");
    return false;
  }
  const repo = await currentRepo();
  const suggested = branchNameForIssue(issue);
  const chosen = await promptText({
    title: `Trabajar en #${issue.number}: ${issue.title}`,
    value: suggested,
    placeholder: suggested,
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Escribe un nombre para la rama";
      if (t.startsWith("-") || /\s/.test(t)) return "El nombre de la rama no puede tener espacios ni empezar por «-»";
      return null;
    },
  });
  if (!chosen) return false;
  const branch = chosen.trim();

  // 1. Crear rama (o cambiar a ella si ya existe localmente).
  try {
    await invoke("git_switch", { root: ws.root, name: branch, create: true });
    setStatus(`Rama «${branch}» creada para #${issue.number}`);
  } catch {
    try {
      await invoke("git_switch", { root: ws.root, name: branch, create: false });
      setStatus(`Cambiado a la rama existente «${branch}» para #${issue.number}`);
    } catch (e) {
      setStatus(`No se pudo preparar la rama «${branch}»: ${e}`, 7000);
      return false;
    }
  }
  await checkExternal();
  await refreshTree();
  await refreshScm();

  // 2. Mover issue a «En curso» en GitHub si hay sesión conectada.
  if (repo && hasToken()) {
    const label = state.settings.boardProgressLabel || "in progress";
    try {
      await ensureBoardLabel(repo.owner, repo.repo, label);
      await addLabel(repo.owner, repo.repo, issue.number, label);
      await removeLabel(repo.owner, repo.repo, issue.number, REVIEW_LABEL).catch(() => {});
      bus.emit("issues-changed");
    } catch { /* sin permiso de escritura: continuamos igual con el flujo local */ }
  }

  // 3. Guardar trabajo activo y notificar al chat de IA.
  const work: ActiveIssueWork = {
    owner: repo?.owner ?? "",
    repo: repo?.repo ?? "",
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    branch,
    html_url: issue.html_url,
    startedAt: Date.now(),
  };
  setActiveIssueWork(work);
  const prompt = buildIssuePrompt(issue, branch);
  bus.emit("issue-workflow-start", {
    issueNumber: issue.number,
    title: issue.title,
    body: prompt,
    branch,
  });
  return true;
}

/** Aplica un cambio propuesto por la IA: si está abierto en el editor usa `pushEditOperations` (con Ctrl+Z); si no, escritura atómica. */
export async function applyProposedEdit(edit: ProposedFileEdit): Promise<string> {
  if (!ws.root) throw new Error("No hay ninguna carpeta abierta.");
  if (!isSafeRelativeEditPath(edit.path)) throw new Error(`Ruta no permitida: ${edit.path}`);
  const fullPath = `${ws.root.replace(/\/+$/, "")}/${edit.path}`;
  const openDoc = findOpenDoc(fullPath);
  if (openDoc) {
    const range = openDoc.model.getFullModelRange();
    openDoc.model.pushEditOperations([], [{ range, text: edit.content }], () => null);
    await openFile(fullPath);
  } else {
    await invoke<number>("write_file", { path: fullPath, contents: edit.content, expectedMtime: null });
    await refreshTree();
  }
  await refreshScm();
  setStatus(`Cambio aplicado en ${edit.path}`, 4000);
  return fullPath;
}

/**
 * Abre un Diff Review interactivo en Monaco comparando el contenido actual vs la propuesta de la IA,
 * con botones «Aplicar cambio» y «Descartar» antes de pisar el disco.
 */
export async function reviewProposedEdit(
  edit: ProposedFileEdit,
  onApplied?: () => void,
  onRejected?: () => void,
): Promise<void> {
  if (!ws.root) {
    setStatus("Abre una carpeta para revisar cambios propuestos");
    return;
  }
  if (!isSafeRelativeEditPath(edit.path)) {
    setStatus(`Ruta rechazada por seguridad: ${edit.path}`);
    return;
  }
  const fullPath = `${ws.root.replace(/\/+$/, "")}/${edit.path}`;

  await openDiffRequest({
    title: baseName(edit.path),
    sub: `${edit.path} — Revisión de propuesta de IA (Actual ↔ Propuesto)`,
    path: edit.path,
    load: async () => {
      const openDoc = findOpenDoc(fullPath);
      if (openDoc) {
        return { original: openDoc.model.getValue(), modified: edit.content, binary: false };
      }
      let current = "";
      try {
        current = await invoke<string>("read_file", { path: fullPath });
      } catch {
        current = ""; // archivo nuevo
      }
      return { original: current, modified: edit.content, binary: false };
    },
    actions: [
      {
        label: "Descartar",
        danger: true,
        run: () => {
          closeDiff();
          onRejected?.();
          setStatus(`Propuesta descartada para ${edit.path}`, 3000);
        },
      },
      {
        label: "Aplicar cambio",
        primary: true,
        run: async () => {
          try {
            await applyProposedEdit(edit);
            closeDiff();
            onApplied?.();
          } catch (e) {
            setStatus(`No se pudo aplicar el cambio: ${e instanceof Error ? e.message : e}`, 6000);
          }
        },
      },
    ],
  });
}

/**
 * Cierra el ciclo de la issue activa: abre «Nueva pull request» pre-llenada con `Closes #N` y los
 * archivos tocados, y al crearse mueve la issue a «En revisión» en el tablero.
 */
export async function createPrForActiveIssue(touchedFiles: string[] = []): Promise<void> {
  const work = getActiveIssueWork();
  if (!work) {
    await newPull();
    return;
  }
  const draft = buildPrDraft(
    { number: work.number, title: work.title },
    work.branch,
    "main",
    touchedFiles,
  );
  const created = await newPull({
    title: draft.title,
    body: draft.body,
    issueNumber: work.number,
  });
  if (created && work.owner && work.repo && hasToken()) {
    try {
      await ensureBoardLabel(work.owner, work.repo, REVIEW_LABEL);
      await addLabel(work.owner, work.repo, work.number, REVIEW_LABEL);
      const progress = state.settings.boardProgressLabel || "in progress";
      await removeLabel(work.owner, work.repo, work.number, progress).catch(() => {});
      bus.emit("issues-changed");
      setStatus(`PR #${created.number} creada · Issue #${work.number} movida a «En revisión»`, 6000);
    } catch { /* la PR ya fue creada */ }
  }
}
