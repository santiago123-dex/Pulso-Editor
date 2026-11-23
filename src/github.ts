import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { readStorage, removeStorage } from "./core/storage";

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

/** Clave antigua: el token se guardaba en texto plano en localStorage. */
const LEGACY_KEY = "pulso.githubToken";
const MAX_ETAG_ENTRIES = 200;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** En Tauri el token real nunca entra en JS; solo se guarda un flag booleano de sesión activa. */
let connected = false;
/** Solo para modo navegador/pruebas fuera de Tauri. */
let browserToken = "";

/** Indica si hay un token de GitHub configurado (en Rust o en modo navegador). */
export const hasToken = () => (inTauri() ? connected : !!browserToken);

/** Compatibilidad: en Tauri nunca expone el secreto en texto plano. */
export const getToken = () => (inTauri() ? "" : browserToken);

/** Carga el estado del token desde Rust y migra cualquier clave heredada de localStorage. */
export async function initToken(): Promise<void> {
  if (!inTauri()) return;
  try {
    connected = await invoke<boolean>("github_init");
  } catch {
    connected = false;
  }
  const legacy = readStorage(LEGACY_KEY);
  if (legacy) {
    try {
      if (!connected) {
        const saved = await invoke<boolean>("github_set_token", { token: legacy });
        connected = true;
        if (!saved) return;
      }
      removeStorage(LEGACY_KEY);
    } catch { /* se deja donde estaba para no perderlo */ }
  }
}

/** Guarda el token en Rust y en el almacén seguro del SO. Devuelve false si solo quedó en memoria. */
export async function setToken(value: string): Promise<boolean> {
  const v = value.trim();
  etagCache.clear(); // las respuestas guardadas pueden ser de otra cuenta
  if (!inTauri()) {
    browserToken = v;
    return false;
  }
  try {
    const persisted = await invoke<boolean>("github_set_token", { token: v });
    connected = !!v;
    return persisted;
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
 * local falso; en producción Rust ignora cualquier origen distinto de `https://api.github.com`.
 */
export const apiBase = () => (readStorage("pulso.githubApi") || "https://api.github.com").replace(/\/+$/, "");

function customApiBase(): string | null {
  const raw = readStorage("pulso.githubApi")?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

export interface GithubProxyResult {
  ok: boolean;
  status: number;
  etag: string | null;
  link: string | null;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

interface RawProxyResponse {
  status: number;
  body: string;
  etag: string | null;
  link: string | null;
}

/**
 * Transporte unificado hacia la API de GitHub:
 * - En Tauri ejecuta la petición desde Rust (`github_api`), inyectando el token sin exponerlo al WebView.
 * - Fuera de Tauri (navegador / pruebas unitarias) usa `fetch`.
 */
export async function githubFetch(
  path: string,
  opts: { method?: string; body?: unknown; accept?: string; ifNoneMatch?: string } = {},
): Promise<GithubProxyResult> {
  const method = opts.method ?? "GET";
  const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (inTauri()) {
    const res = await invoke<RawProxyResponse>("github_api", {
      method,
      path,
      body: bodyStr ?? null,
      accept: opts.accept ?? null,
      ifNoneMatch: opts.ifNoneMatch ?? null,
      baseUrl: customApiBase(),
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      etag: res.etag,
      link: res.link,
      text: async () => res.body,
      json: async <T = unknown>() => JSON.parse(res.body) as T,
    };
  }
  const headers = authHeaders(opts.body !== undefined);
  if (opts.accept) headers.Accept = opts.accept;
  if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: bodyStr,
    cache: "no-store",
  });
  return {
    ok: res.ok,
    status: res.status,
    etag: res.headers?.get?.("etag") ?? null,
    link: res.headers?.get?.("link") ?? null,
    text: () => res.text(),
    json: <T = unknown>() => res.json() as Promise<T>,
  };
}

/** Mensaje en español para un fallo de la API: dice qué hacer, no solo el código. */
export function explainStatus(status: number, writing: boolean): string {
  if (status === 401) return t("GitHub rechazó el token (no es válido o caducó). Vuelve a conectar tu cuenta en Configuración → GitHub.");
  if (status === 403 || status === 429) {
    return writing
      ? t("GitHub no permitió el cambio: el token necesita permiso de escritura en las issues del repositorio, o se alcanzó el límite de uso de la API.")
      : t("GitHub no permitió la consulta: puede faltar un token o se alcanzó el límite de uso de la API.");
  }
  if (status === 404) return t("GitHub no encontró el repositorio o la issue. Si el repositorio es privado, conecta tu cuenta de GitHub (debe tener acceso a él).");
  if (status === 422) return t("GitHub no pudo aplicar el cambio (datos no válidos).");
  return t("GitHub respondió {status}", { status });
}

/** Explica un error de GraphQL al eliminar una issue. GitHub solo lo permite a quien administra el repositorio. */
export function explainDeleteError(message: string): string {
  if (/admin|permission|access|forbidden|not authorized|insufficient|resource not accessible/i.test(message)) {
    return t("GitHub solo permite eliminar issues a quienes administran el repositorio. Puedes cerrarla en su lugar.");
  }
  return t("GitHub no pudo eliminar la issue: {reason}", { reason: message });
}

/** Elimina una issue para siempre (mutación GraphQL; la API REST no lo permite). */
export async function deleteIssue(nodeId: string): Promise<void> {
  const res = await githubFetch("/graphql", {
    method: "POST",
    body: { query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }", variables: { id: nodeId } },
  });
  if (!res.ok) throw new GithubError(res.status, true);
  const data = await res.json<{ errors?: { message?: string }[] }>();
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

async function whoAmI(): Promise<string> {
  const res = await githubFetch("/user");
  if (!res.ok) throw new GithubError(res.status);
  const data = await res.json<{ login?: string }>();
  return data.login ?? "";
}

/**
 * Conecta con la cuenta de GitHub que Git ya usa en este equipo (Git Credential Manager).
 * Toda la verificación y almacenamiento del token ocurre en Rust; JS solo recibe el nombre de usuario.
 */
export async function connectGithub(interactive: boolean): Promise<string> {
  const login = await invoke<string>("github_connect", { interactive, baseUrl: customApiBase() });
  etagCache.clear();
  connected = true;
  account = login;
  return login;
}

/** Código que da GitHub para iniciar sesión desde Pulso (OAuth device flow). */
export interface DeviceCode { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }

/** Dirección web de GitHub; en desarrollo las pruebas la apuntan a un servidor simulado. */
function customWebBase(): string | null {
  const raw = readStorage("pulso.githubWeb")?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** El inicio de sesión por código solo está disponible si la compilación tiene el identificador de la aplicación OAuth. */
export async function deviceLoginAvailable(): Promise<boolean> {
  return inTauri() && invoke<boolean>("github_device_available").catch(() => false);
}

export const deviceLoginStart = () => invoke<DeviceCode>("github_device_start", { webBase: customWebBase() });

/** Espera a que se autorice el código en GitHub; deja el token guardado en Rust y devuelve el usuario. */
export async function deviceLoginFinish(code: DeviceCode): Promise<string> {
  const login = await invoke<string>("github_device_poll", {
    deviceCode: code.device_code, interval: code.interval, expiresIn: code.expires_in,
    webBase: customWebBase(), apiBase: customApiBase(),
  });
  etagCache.clear();
  connected = true;
  account = login;
  return login;
}

export const deviceLoginCancel = () => invoke("github_device_cancel").catch(() => {});

/** Al iniciar, si no hay token, adopta en silencio la sesión de GitHub que Git ya tiene. Devuelve el usuario o null. */
export async function autoConnect(): Promise<string | null> {
  // `pulso.noAutoConnect` lo fijan las pruebas para que no adopten la sesión real de quien las ejecuta.
  if (!inTauri() || hasToken() || readStorage("pulso.noAutoConnect")) return null;
  try { return await connectGithub(false); } catch { return null; }
}

/** Usuario del token actual, o "" si no hay token o no es válido. */
export async function refreshAccount(): Promise<string> {
  if (!hasToken()) { account = ""; return ""; }
  try { account = await whoAmI(); } catch { account = ""; }
  return account;
}

export async function disconnectGithub(): Promise<void> {
  etagCache.clear();
  account = "";
  if (inTauri()) {
    await invoke("github_disconnect");
    connected = false;
  } else {
    browserToken = "";
  }
}

/** Respuestas ya vistas, por URL (acotado para evitar fugas de memoria). */
const etagCache = new Map<string, { etag: string; data: unknown }>();

function cacheSet(key: string, val: { etag: string; data: unknown }) {
  if (etagCache.size >= MAX_ETAG_ENTRIES && !etagCache.has(key)) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) etagCache.delete(oldest);
  }
  etagCache.set(key, val);
}

/** GET con ETag: si GitHub responde 304 se devuelve lo guardado; así se puede consultar a menudo sin coste. */
export async function getJson<T>(path: string): Promise<T> {
  const key = `${apiBase()}${path}`;
  const known = etagCache.get(key);
  const res = await githubFetch(path, { ifNoneMatch: known?.etag });
  if (res.status === 304 && known) return known.data as T;
  if (!res.ok) throw new GithubError(res.status);
  const data = await res.json<T>();
  if (res.etag) cacheSet(key, { etag: res.etag, data });
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
  const res = await githubFetch(path, { method, body });
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
  const res = await githubFetch(path, { method, body });
  if (!res.ok) throw new GithubError(res.status, true);
  return res.json<T>();
}

export interface IssueDraft { title: string; body: string; labels: string[] }

/** Crea una issue y devuelve la que GitHub registró (con su número). */
export const createIssue = (owner: string, repo: string, draft: IssueDraft) =>
  writeJson<Issue>("POST", `/repos/${owner}/${repo}/issues`, { title: draft.title, body: draft.body, labels: draft.labels });

/** Cambia título, descripción y/o etiquetas. `labels` reemplaza todas las etiquetas de la issue. */
export const updateIssue = (owner: string, repo: string, number: number, patch: Partial<IssueDraft>) =>
  writeJson<Issue>("PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch);
