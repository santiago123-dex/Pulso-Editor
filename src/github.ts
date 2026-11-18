import { invoke } from "@tauri-apps/api/core";

export interface Issue {
  number: number;
  /** Identificador global (GraphQL): hace falta para eliminar. */
  node_id?: string;
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
  if (v !== token) etagCache.clear(); // las respuestas guardadas son de otra cuenta
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
export const apiBase = () => (localStorage.getItem("pulso.githubApi") || "https://api.github.com").replace(/\/+$/, "");

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** Mensaje en español para un fallo de la API: dice qué hacer, no solo el código. */
export function explainStatus(status: number, writing: boolean): string {
  if (status === 401) return "GitHub rechazó el token (no es válido o caducó). Vuelve a conectar tu cuenta en Configuración → GitHub.";
  if (status === 403 || status === 429) {
    return writing
      ? "GitHub no permitió el cambio: el token necesita permiso de escritura en las issues del repositorio, o se alcanzó el límite de uso de la API."
      : "GitHub no permitió la consulta: puede faltar un token o se alcanzó el límite de uso de la API.";
  }
  if (status === 404) return "GitHub no encontró el repositorio o la issue. Si el repositorio es privado, conecta tu cuenta de GitHub (debe tener acceso a él).";
  if (status === 422) return "GitHub no pudo aplicar el cambio (datos no válidos).";
  return `GitHub respondió ${status}`;
}

/** Explica un error de GraphQL al eliminar una issue. GitHub solo lo permite a quien administra el repositorio. */
export function explainDeleteError(message: string): string {
  if (/admin|permission|access|forbidden|not authorized|insufficient|resource not accessible/i.test(message)) {
    return "GitHub solo permite eliminar issues a quienes administran el repositorio. Puedes cerrarla en su lugar.";
  }
  return `GitHub no pudo eliminar la issue: ${message}`;
}

/** Elimina una issue para siempre (mutación GraphQL; la API REST no lo permite). */
export async function deleteIssue(nodeId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/graphql`, {
    cache: "no-store",
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }", variables: { id: nodeId } }),
  });
  if (!res.ok) throw new GithubError(res.status, true);
  const data = (await res.json()) as { errors?: { message?: string }[] };
  if (data.errors?.length) throw new Error(explainDeleteError(data.errors[0].message ?? ""));
}

/** Fallo de la API con su código, para que la interfaz ofrezca conectar la cuenta cuando es un problema de acceso. */
export class GithubError extends Error {
  constructor(readonly status: number, writing = false) { super(explainStatus(status, writing)); }
}

/** 401, 403 y 404 suelen significar «falta iniciar sesión o permisos»: GitHub responde 404 a un repositorio privado sin acceso. */
export const isAuthProblem = (e: unknown): boolean => e instanceof GithubError && [401, 403, 404].includes(e.status);

let account = "";
/** Usuario de GitHub con el que se conectó Pulso en esta sesión ("" = sin comprobar). */
export const getAccount = () => account;

async function whoAmI(tokenValue: string): Promise<string> {
  const res = await fetch(`${apiBase()}/user`, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${tokenValue}` } });
  if (!res.ok) throw new GithubError(res.status);
  const data = (await res.json()) as { login?: string };
  return data.login ?? "";
}

/**
 * Conecta con la cuenta de GitHub que Git ya usa en este equipo (Git Credential Manager). Con `interactive`,
 * si no hay sesión se abre el navegador para autorizar; sin él solo se reutiliza lo ya guardado.
 */
export async function connectGithub(interactive: boolean): Promise<string> {
  const cred = await invoke<{ username: string; token: string }>("github_credential", { interactive });
  let login: string;
  try { login = (await whoAmI(cred.token)) || cred.username; }
  catch (e) {
    if (e instanceof GithubError && e.status === 401) throw new Error("GitHub rechazó la sesión guardada en Git (caducó o se revocó). Vuelve a iniciar sesión desde una terminal con «git credential-manager github login» y reintenta.");
    throw e;
  }
  await setToken(cred.token);
  account = login;
  return login;
}

/** Al iniciar, si no hay token, adopta en silencio la sesión de GitHub que Git ya tiene. Devuelve el usuario o null. */
export async function autoConnect(): Promise<string | null> {
  // `pulso.noAutoConnect` lo fijan las pruebas para que no adopten la sesión real de quien las ejecuta.
  if (!inTauri() || token || localStorage.getItem("pulso.noAutoConnect")) return null;
  try { return await connectGithub(false); } catch { return null; }
}

/** Usuario del token actual, o "" si no hay token o no es válido. */
export async function refreshAccount(): Promise<string> {
  if (!token) { account = ""; return ""; }
  try { account = await whoAmI(token); } catch { account = ""; }
  return account;
}

export async function disconnectGithub(): Promise<void> {
  await setToken("");
  account = "";
}

/**
 * Sin caché del navegador: GitHub responde con `max-age=60` y el WebView daría datos de hasta un minuto atrás
 * (por eso una issue reabierta en GitHub seguía en «Hecho» en el tablero).
 */
async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: authHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  return res;
}

/** Respuestas ya vistas, por URL: una consulta condicional (ETag) que devuelve 304 no gasta cuota de la API. */
const etagCache = new Map<string, { etag: string; data: unknown }>();

/** GET con ETag: si GitHub responde 304 se devuelve lo guardado; así se puede consultar a menudo sin coste. */
async function getJson<T>(path: string): Promise<T> {
  const url = `${apiBase()}${path}`;
  const known = etagCache.get(url);
  const headers = authHeaders();
  if (known) headers["If-None-Match"] = known.etag;
  const res = await fetch(url, { headers, cache: "no-store" });
  if (res.status === 304 && known) return known.data as T;
  if (!res.ok) throw new GithubError(res.status);
  const data = (await res.json()) as T;
  const tag = res.headers?.get?.("etag");
  if (tag) etagCache.set(url, { etag: tag, data });
  return data;
}

export async function fetchIssues(owner: string, repo: string, state: string): Promise<Issue[]> {
  const data = await getJson<Issue[]>(`/repos/${owner}/${repo}/issues?state=${state}&per_page=50`);
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
    const data = await getJson<Issue[]>(`/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`);
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
  throw new GithubError(res.status, true);
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
  if (!res.ok) throw new GithubError(res.status, true);
  return (await res.json()) as T;
}

export interface IssueDraft { title: string; body: string; labels: string[] }

/** Crea una issue y devuelve la que GitHub registró (con su número). */
export const createIssue = (owner: string, repo: string, draft: IssueDraft) =>
  writeJson<Issue>("POST", `/repos/${owner}/${repo}/issues`, { title: draft.title, body: draft.body, labels: draft.labels });

/** Cambia título, descripción y/o etiquetas. `labels` reemplaza todas las etiquetas de la issue. */
export const updateIssue = (owner: string, repo: string, number: number, patch: Partial<IssueDraft>) =>
  writeJson<Issue>("PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch);
