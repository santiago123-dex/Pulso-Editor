import { githubFetch, GithubError, type GithubProxyResult } from "./github";
import { ROOM_LABEL, ROOM_TITLE, type ChatComment, type ChatUser } from "./chatModel";

export type { ChatComment, ChatUser } from "./chatModel";
export interface ChatRepo { owner: string; repo: string }
export interface ChatRoom { number: number; title: string; html_url: string }
export interface ChatMembers { users: ChatUser[]; kind: "collaborators" | "contributors" }

/** La interfaz depende de este contrato, no de cómo se almacenen los mensajes. */
export interface ChatStore {
  /** La sala del repositorio (una issue con la etiqueta «pulso-chat»), o null si aún no existe. */
  findRoom(repo: ChatRepo): Promise<ChatRoom | null>;
  createRoom(repo: ChatRepo): Promise<ChatRoom>;
  /** ¿Sigue abierta la sala? false si se cerró o borró; null si no cambió (304). */
  roomOpen(repo: ChatRepo, room: number): Promise<boolean | null>;
  /** Hasta las últimas 500 mensajes (5 páginas de 100). */
  comments(repo: ChatRepo, room: number): Promise<ChatComment[]>;
  /** Mensajes nuevos o editados desde `sinceIso`; null si GitHub dice que no cambió nada (no gasta cuota). */
  newer(repo: ChatRepo, room: number, sinceIso: string): Promise<ChatComment[] | null>;
  send(repo: ChatRepo, room: number, body: string): Promise<ChatComment>;
  members(repo: ChatRepo): Promise<ChatMembers>;
  me(): Promise<ChatUser>;
}

const path = ({ owner, repo }: ChatRepo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const etags = new Map<string, string>();

async function responseFor(url: string, method = "GET", body?: unknown, conditional = false): Promise<GithubProxyResult> {
  const known = conditional ? etags.get(url) : undefined;
  const response = await githubFetch(url, { method, body, ifNoneMatch: known });
  if (response.status === 304) return response;
  if (!response.ok) throw new GithubError(response.status, method !== "GET");
  if (conditional && response.etag) etags.set(url, response.etag);
  return response;
}
async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  return (await responseFor(url, method, body)).json<T>();
}

/** La etiqueta de la sala debe existir antes de usarla: se intenta crear y, si ya existe (422), se sigue. Una sola llamada. */
async function ensureRoomLabel(repo: ChatRepo): Promise<void> {
  try { await request(`${path(repo)}/labels`, "POST", { name: ROOM_LABEL, color: "7c3aed", description: "Chat del equipo en Pulso" }); }
  catch (e) { if (!(e instanceof GithubError) || e.status !== 422) throw e; /* otra persona la creó a la vez */ }
}

export const githubChatStore: ChatStore = {
  async findRoom(repo) {
    const list = await request<Array<ChatRoom & { pull_request?: unknown }>>(`${path(repo)}/issues?labels=${encodeURIComponent(ROOM_LABEL)}&state=open&sort=created&direction=asc&per_page=10`);
    // Si por error hubiera varias, todas las personas eligen la más antigua y acaban en la misma sala.
    const room = list.find((i) => !i.pull_request);
    return room ? { number: room.number, title: room.title, html_url: room.html_url } : null;
  },
  async createRoom(repo) {
    await ensureRoomLabel(repo);
    const made = await request<ChatRoom>(`${path(repo)}/issues`, "POST", {
      title: ROOM_TITLE,
      body: "Conversación del equipo desde Pulso Editor. Cada comentario es un mensaje del chat; tienen la visibilidad de este repositorio. Mejor no cerrar ni borrar esta issue.",
      labels: [ROOM_LABEL],
    });
    return { number: made.number, title: made.title, html_url: made.html_url };
  },
  async roomOpen(repo, room) {
    try {
      const res = await responseFor(`${path(repo)}/issues/${room}`, "GET", undefined, true);
      if (res.status === 304) return null;
      return ((await res.json()) as { state?: string }).state === "open";
    } catch (e) {
      if (e instanceof GithubError && (e.status === 404 || e.status === 410)) return false;
      throw e;
    }
  },
  async comments(repo, room) {
    const base = `${path(repo)}/issues/${room}/comments?per_page=100&page=`;
    const first = await responseFor(`${base}1`);
    const firstPage = await first.json<ChatComment[]>();
    const lastLink = first.link?.split(",").find((part) => /rel="last"/.test(part));
    const lastPage = Number(lastLink?.match(/[?&]page=(\d+)/)?.[1] || 1);
    const all: ChatComment[] = lastPage <= 5 ? firstPage : [];
    // Solo se reconstruyen números de página: el token nunca se envía a enlaces del encabezado.
    for (let page = Math.max(2, lastPage - 4); page <= lastPage; page++) {
      all.push(...await request<ChatComment[]>(`${base}${page}`));
    }
    return all.sort((a, b) => a.id - b.id);
  },
  async newer(repo, room, sinceIso) {
    const url = `${path(repo)}/issues/${room}/comments?per_page=100&since=${encodeURIComponent(sinceIso)}`;
    const res = await responseFor(url, "GET", undefined, true);
    if (res.status === 304) return null;
    return (await res.json()) as ChatComment[];
  },
  send: (repo, room, body) => request(`${path(repo)}/issues/${room}/comments`, "POST", { body }),
  async members(repo) {
    try {
      const users = await request<ChatUser[]>(`${path(repo)}/collaborators?per_page=100`);
      return { users, kind: "collaborators" };
    } catch (error) {
      if (!(error instanceof GithubError) || ![403, 404].includes(error.status)) throw error;
      const users = await request<ChatUser[]>(`${path(repo)}/contributors?per_page=100`);
      return { users, kind: "contributors" };
    }
  },
  me: () => request<ChatUser>("/user"),
};
