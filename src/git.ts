import { invoke } from "@tauri-apps/api/core";
import { dirName } from "./util";

export interface GitFile { path: string; status: string; dir: boolean }
export interface GitInfo { branch: string; ahead: number; behind: number; dirty: boolean; files: GitFile[] }

/** Gravedad para decidir qué color gana en una carpeta con varios cambios. */
const RANK: Record<string, number> = { "!": 5, D: 4, M: 3, R: 3, A: 2, U: 1, I: 0 };

let info: GitInfo | null = null;
let requestId = 0;
let pending: { root: string; promise: Promise<GitInfo | null> } | null = null;
const exact = new Map<string, string>();
/** Directorios sin seguimiento o ignorados: todo lo que contienen hereda el estado. */
const wholeDirs = new Map<string, string>();
/** Carpetas que contienen cambios, con el estado más grave. */
const changedDirs = new Map<string, string>();

const subs = new Set<(i: GitInfo | null) => void>();
export const onGitChange = (f: (i: GitInfo | null) => void) => { subs.add(f); };
export const gitInfo = () => info;

export function refreshGit(root: string | null): Promise<GitInfo | null> {
  if (root && pending?.root === root) return pending.promise;
  const id = ++requestId;
  const promise = updateGit(root, id);
  if (root) {
    pending = { root, promise };
    void promise.finally(() => { if (pending?.promise === promise) pending = null; });
  } else pending = null;
  return promise;
}

async function updateGit(root: string | null, id: number): Promise<GitInfo | null> {
  let result: GitInfo | null = null;
  if (root) {
    try { result = await invoke<GitInfo | null>("git_status", { path: root }); } catch { result = null; }
  }
  if (id !== requestId) return info;
  info = result;
  exact.clear(); wholeDirs.clear(); changedDirs.clear();
  if (info) {
    for (const f of info.files) {
      if (f.dir) wholeDirs.set(f.path, f.status); else exact.set(f.path, f.status);
      if (f.status === "I") continue;
      for (let d = dirName(f.path); d; d = dirName(d)) {
        const cur = changedDirs.get(d);
        if (!cur || RANK[f.status] > RANK[cur]) changedDirs.set(d, f.status);
      }
    }
  }
  subs.forEach((s) => s(info));
  return info;
}

export interface Decoration { cls: string; badge: string }

function inherited(path: string): string | null {
  for (let d = path; d; d = dirName(d)) {
    const s = wholeDirs.get(d);
    if (s) return s;
  }
  return null;
}

/** Color y marca (U, M, D…) que el explorador muestra para un archivo o carpeta. */
export function decorate(path: string, isDir: boolean): Decoration | null {
  if (!info) return null;
  if (isDir) {
    const own = inherited(path);
    if (own === "I") return { cls: "git-I", badge: "" };
    const s = own ?? changedDirs.get(path);
    return s ? { cls: `git-${s === "!" ? "C" : s}`, badge: "●" } : null;
  }
  const s = exact.get(path) ?? inherited(path);
  if (!s) return null;
  return { cls: `git-${s === "!" ? "C" : s}`, badge: s === "I" ? "" : s === "!" ? "!" : s };
}
