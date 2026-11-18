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
  assignees?: { login: string }[];
  body?: string | null;
  updated_at?: string;
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

/**
 * Dirección de la API. Solo cambia con `pulso.githubApi` en localStorage, que usan las pruebas contra un servidor
 * local falso; nada en la interfaz permite fijarla, así que el token no sale hacia otro sitio por accidente.
 */
const apiBase = () => (localStorage.getItem("pulso.githubApi") || "https://api.github.com").replace(/\/+$/, "");

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** Mensaje en español para un fallo de la API: dice qué hacer, no solo el código. */
export function explainStatus(status: number, writing: boolean): string {
  if (status === 401) return "GitHub rechazó el token (no es válido o caducó). Revísalo en Configuración → GitHub.";
  if (status === 403 || status === 429) {
    return writing
      ? "GitHub no permitió el cambio: el token necesita permiso de escritura en las issues del repositorio, o se alcanzó el límite de uso de la API."
      : "GitHub no permitió la consulta: puede faltar un token o se alcanzó el límite de uso de la API.";
  }
  if (status === 404) return "GitHub no encontró el repositorio o la issue. Si el repositorio es privado, configura un token con acceso.";
  if (status === 422) return "GitHub no pudo aplicar el cambio (datos no válidos).";
  return `GitHub respondió ${status}`;
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: authHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

export async function fetchIssues(owner: string, repo: string, state: string): Promise<Issue[]> {
  const res = await request("GET", `/repos/${owner}/${repo}/issues?state=${state}&per_page=50`);
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  const data: Issue[] = await res.json();
  // La API de issues también devuelve PRs; aquí solo mostramos issues.
  return data.filter((i) => !i.pull_request);
}

export interface IssuePage { issues: Issue[]; truncated: boolean }

/** Todas las issues de un estado, página a página, hasta `max` (las más recientemente actualizadas primero). */
export async function fetchAllIssues(owner: string, repo: string, state: "open" | "closed", max = 300): Promise<IssuePage> {
  const perPage = 100;
  const out: Issue[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const res = await request("GET", `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`);
    if (!res.ok) throw new Error(explainStatus(res.status, false));
    const data: Issue[] = await res.json();
    out.push(...data.filter((i) => !i.pull_request));
    if (data.length < perPage) break;
    // Las PR cuentan para la paginación pero no para el límite: se corta por páginas recibidas.
    if (page * perPage >= max) { truncated = true; break; }
  }
  return { issues: out, truncated };
}

async function write(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<void> {
  const res = await request(method, path, body);
  if (res.ok || okStatuses.includes(res.status)) return;
  throw new Error(explainStatus(res.status, true));
}

export const addLabel = (owner: string, repo: string, number: number, label: string) =>
  write("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, { labels: [label] });

/** Quitar una etiqueta que la issue ya no tiene (404) no es un error. */
export const removeLabel = (owner: string, repo: string, number: number, label: string) =>
  write("DELETE", `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, undefined, [404]);

export const setIssueState = (owner: string, repo: string, number: number, state: "open" | "closed") =>
  write("PATCH", `/repos/${owner}/${repo}/issues/${number}`, { state });

async function writeJson<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await request(method, path, body);
  if (!res.ok) throw new Error(explainStatus(res.status, true));
  return (await res.json()) as T;
}

export interface IssueDraft { title: string; body: string; labels: string[] }

/** Crea una issue y devuelve la que GitHub registró (con su número). */
export const createIssue = (owner: string, repo: string, draft: IssueDraft) =>
  writeJson<Issue>("POST", `/repos/${owner}/${repo}/issues`, { title: draft.title, body: draft.body, labels: draft.labels });

/** Cambia título, descripción y/o etiquetas. `labels` reemplaza todas las etiquetas de la issue. */
export const updateIssue = (owner: string, repo: string, number: number, patch: Partial<IssueDraft>) =>
  writeJson<Issue>("PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch);
