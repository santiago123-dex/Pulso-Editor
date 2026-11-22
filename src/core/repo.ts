import { invoke } from "@tauri-apps/api/core";
import { parseRemote } from "../github";
import { ws } from "../workspace";

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Propietario y nombre del repositorio de GitHub de la carpeta abierta, o null si no hay carpeta o remoto. */
export async function currentRepo(): Promise<RepoRef | null> {
  if (!ws.root) return null;
  try {
    return parseRemote(await invoke<string>("git_remote", { path: ws.root }));
  } catch {
    return null;
  }
}
