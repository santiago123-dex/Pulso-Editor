import { invoke } from "@tauri-apps/api/core";

export interface Issue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string };
  labels: { name: string; color: string }[];
  comments: number;
  pull_request?: unknown;
}

const SECRET = "github-token";
/** Clave antigua: el token se guardaba en texto plano en localStorage. */
const LEGACY_KEY = "pulso.githubToken";

const inTauri = () => "__TAURI_INTERNALS__" in window;
let token = "";

/** Token vigente (en memoria). Se lee del almacén seguro del sistema al iniciar. */
export const getToken = () => token;

/** Carga el token del almacén de credenciales y migra el que hubiera en localStorage. */
export async function initToken(): Promise<void> {
  if (!inTauri()) return;
  try {
    token = (await invoke<string | null>("secret_get", { name: SECRET })) ?? "";
  } catch { /* sin almacén disponible */ }
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      if (!token) await invoke("secret_set", { name: SECRET, value: legacy });
      if (!token) token = legacy;
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* se deja donde estaba para no perderlo */ }
  }
}

/** Guarda el token en el almacén seguro. Devuelve false si solo quedó en memoria. */
export async function setToken(value: string): Promise<boolean> {
  const v = value.trim();
  token = v;
  if (!inTauri()) return false;
  try {
    if (v) await invoke("secret_set", { name: SECRET, value: v });
    else await invoke("secret_delete", { name: SECRET });
    return true;
  } catch {
    return false;
  }
}

/** Extrae owner/repo de URLs https o ssh de GitHub. */
export function parseRemote(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function fetchIssues(owner: string, repo: string, state: string): Promise<Issue[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=50`,
    { headers },
  );
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  const data: Issue[] = await res.json();
  // La API de issues también devuelve PRs; aquí solo mostramos issues.
  return data.filter((i) => !i.pull_request);
}
