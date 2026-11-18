import { dirName } from "./util";

/** Entradas visibles en orden de lectura; los hijos de carpetas cerradas no están en la lista. */
export interface ExplorerEntry { path: string; isDir: boolean; expanded: boolean }
export type ExplorerAction = { kind: "select" | "expand" | "collapse" | "open"; path: string };

/** Decide la acción sin mover el foco fuera del árbol. */
export function explorerKey(entries: ExplorerEntry[], selected: string | null, key: string): ExplorerAction | null {
  if (!entries.length) return null;
  const index = entries.findIndex((entry) => entry.path === selected);
  if (index < 0) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return { kind: "select", path: entries[key === "End" ? entries.length - 1 : 0].path };
    return null;
  }
  const item = entries[index];
  if (key === "ArrowDown") return { kind: "select", path: entries[Math.min(index + 1, entries.length - 1)].path };
  if (key === "ArrowUp") return { kind: "select", path: entries[Math.max(index - 1, 0)].path };
  if (key === "Home" || key === "End") return { kind: "select", path: entries[key === "Home" ? 0 : entries.length - 1].path };
  if (key === "ArrowRight" && item.isDir) {
    if (!item.expanded) return { kind: "expand", path: item.path };
    const child = entries[index + 1];
    return child && dirName(child.path) === item.path ? { kind: "select", path: child.path } : null;
  }
  if (key === "ArrowLeft") {
    if (item.isDir && item.expanded) return { kind: "collapse", path: item.path };
    const parent = entries.find((entry) => entry.path === dirName(item.path));
    return parent ? { kind: "select", path: parent.path } : null;
  }
  if (key === "Enter") return { kind: item.isDir ? (item.expanded ? "collapse" : "expand") : "open", path: item.path };
  if (key === " " && item.isDir) return { kind: item.expanded ? "collapse" : "expand", path: item.path };
  return null;
}
