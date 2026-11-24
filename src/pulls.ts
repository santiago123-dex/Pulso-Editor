import { t } from "./i18n";
import { getJson, githubFetch, GithubError } from "./github";
import { explainCreateError, type CheckRun, type MergeMethod, type PullComment, type PullFile, type PullSummary, type ReviewEvent } from "./prModel";
import type { Sources } from "./diffView";

const MAX_TEXT = 2_000_000;

const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export const listPulls = (owner: string, repo: string, state: "open" | "closed" | "all") =>
  getJson<PullSummary[]>(`${repoPath(owner, repo)}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`);

export const getPull = (owner: string, repo: string, number: number) =>
  getJson<PullSummary>(`${repoPath(owner, repo)}/pulls/${number}`);

/** Archivos de la pull request, hasta 300 (3 páginas de 100). */
export async function pullFiles(owner: string, repo: string, number: number): Promise<PullFile[]> {
  const out: PullFile[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await getJson<PullFile[]>(`${repoPath(owner, repo)}/pulls/${number}/files?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function defaultBranch(owner: string, repo: string): Promise<string> {
  return (await getJson<{ default_branch: string }>(repoPath(owner, repo))).default_branch;
}

/**
 * Commit desde el que se compara: GitHub muestra los cambios de la rama desde el ancestro común con la de destino,
 * no desde la punta actual de esta (que puede haber avanzado con otros cambios).
 */
export async function mergeBase(owner: string, repo: string, pr: PullSummary): Promise<string> {
  try {
    const c = await getJson<{ merge_base_commit?: { sha?: string } }>(`${repoPath(owner, repo)}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`);
    return c.merge_base_commit?.sha ?? pr.base.sha;
  } catch {
    return pr.base.sha;
  }
}

/** Contenido de un archivo en un commit. Cadena vacía si no existe allí (archivo añadido o eliminado). */
export async function fileAt(owner: string, repo: string, ref: string, path: string): Promise<string> {
  const apiPath = `${repoPath(owner, repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  const res = await githubFetch(apiPath, { accept: "application/vnd.github.raw+json" });
  if (res.status === 404) return "";
  if (!res.ok) throw new GithubError(res.status);
  const text = await res.text();
  if (text.length > MAX_TEXT) throw new Error(t("El archivo es demasiado grande para mostrar diferencias aquí. Ábrelo en GitHub."));
  return text;
}

/** Las dos versiones de un archivo de la pull request, para el visor de diferencias. */
export async function pullSources(owner: string, repo: string, pr: PullSummary, base: string, f: PullFile): Promise<Sources> {
  const [original, modified] = await Promise.all([
    f.status === "added" ? Promise.resolve("") : fileAt(owner, repo, base, f.previous_filename ?? f.filename),
    f.status === "removed" ? Promise.resolve("") : fileAt(owner, repo, pr.head.sha, f.filename),
  ]);
  const binary = original.slice(0, 8000).includes("\u0000") || modified.slice(0, 8000).includes("\u0000");
  return binary ? { original: "", modified: "", binary: true } : { original, modified, binary: false };
}

export interface NewPull { title: string; head: string; base: string; body: string }

/** Crea la pull request (una rama del mismo repositorio contra otra). El error se explica en español. */
export async function createPull(owner: string, repo: string, p: NewPull): Promise<PullSummary> {
  const res = await githubFetch(`${repoPath(owner, repo)}/pulls`, {
    method: "POST",
    body: { title: p.title, head: p.head, base: p.base, body: p.body },
  });
  if (!res.ok) {
    let body: Parameters<typeof explainCreateError>[1] = null;
    try { body = await res.json<Parameters<typeof explainCreateError>[1]>(); } catch { /* sin cuerpo */ }
    throw new Error(explainCreateError(res.status, body));
  }
  return res.json<PullSummary>();
}

/** Fusiona una pull request con el método indicado (`merge`, `squash` o `rebase`). */
export async function mergePull(owner: string, repo: string, number: number, method: MergeMethod, commitTitle?: string): Promise<{ merged: boolean; message: string }> {
  const body: Record<string, string> = { merge_method: method };
  if (commitTitle?.trim()) body.commit_title = commitTitle.trim();
  const res = await githubFetch(`${repoPath(owner, repo)}/pulls/${number}/merge`, { method: "PUT", body });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json<{ message?: string }>()).message ?? ""; } catch { /* sin cuerpo */ }
    throw new Error(msg || t("No se pudo fusionar la pull request (HTTP {status})", { status: res.status }));
  }
  return res.json<{ merged: boolean; message: string }>();
}

/** Envía una revisión (aprobar, pedir cambios o comentar) a una pull request. */
export async function reviewPull(owner: string, repo: string, number: number, event: ReviewEvent, body: string): Promise<void> {
  const res = await githubFetch(`${repoPath(owner, repo)}/pulls/${number}/reviews`, {
    method: "POST",
    body: { event, body },
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json<{ message?: string }>()).message ?? ""; } catch { /* sin cuerpo */ }
    throw new Error(msg || t("No se pudo enviar la revisión (HTTP {status})", { status: res.status }));
  }
}

export const listPullComments = (owner: string, repo: string, number: number) =>
  getJson<PullComment[]>(`${repoPath(owner, repo)}/issues/${number}/comments?per_page=50`);

export async function addPullComment(owner: string, repo: string, number: number, body: string): Promise<PullComment> {
  const res = await githubFetch(`${repoPath(owner, repo)}/issues/${number}/comments`, {
    method: "POST",
    body: { body },
  });
  if (!res.ok) throw new GithubError(res.status);
  return res.json<PullComment>();
}

export async function listCheckRuns(owner: string, repo: string, sha: string): Promise<CheckRun[]> {
  const data = await getJson<{ check_runs?: CheckRun[] }>(`${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=50`);
  return data.check_runs ?? [];
}

/** Si el repositorio es un fork, devuelve su repositorio padre para abrir PRs hacia upstream. */
export async function getRepoForkParent(owner: string, repo: string): Promise<{ owner: string; repo: string; defaultBranch: string } | null> {
  try {
    const info = await getJson<{ fork?: boolean; parent?: { owner?: { login: string }; name?: string; default_branch?: string } }>(repoPath(owner, repo));
    if (info.fork && info.parent?.owner?.login && info.parent.name) {
      return { owner: info.parent.owner.login, repo: info.parent.name, defaultBranch: info.parent.default_branch ?? "main" };
    }
    return null;
  } catch {
    return null;
  }
}
