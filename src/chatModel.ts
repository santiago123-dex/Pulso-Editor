import { lang, t as tr } from "./i18n";
/** Lógica pura del chat del repositorio (sin DOM ni red) para poder probarla. */
export interface ChatUser {
  login: string;
  avatar_url: string;
}
export interface ChatComment {
  id: number;
  body: string;
  user: ChatUser | null;
  created_at: string;
}

/** Mensajes seguidos de la misma persona dentro de este margen se agrupan bajo un solo nombre. */
const GROUP_GAP_MS = 5 * 60_000;

export type ChatItem =
  | { type: "day"; key: string; label: string }
  | { type: "msg"; id: number; login: string; avatar: string; mine: boolean; body: string; at: number; head: boolean; tail: boolean };

const sameLogin = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** «Hoy», «Ayer» o la fecha corta. */
export function dayLabel(t: number, now = Date.now()): string {
  if (dayKey(t) === dayKey(now)) return tr("Hoy");
  if (dayKey(t) === dayKey(now - 86_400_000)) return tr("Ayer");
  return new Date(t).toLocaleDateString(lang(), { weekday: "long", day: "numeric", month: "long" });
}

/** Lista de comentarios → elementos de pantalla: separadores de día y mensajes agrupados por persona. */
export function buildItems(comments: readonly ChatComment[], me: string, now = Date.now()): ChatItem[] {
  const out: ChatItem[] = [];
  let lastDay = "";
  let prev: Extract<ChatItem, { type: "msg" }> | null = null;
  for (const c of comments) {
    const at = Date.parse(c.created_at) || 0;
    const day = dayKey(at);
    if (day !== lastDay) {
      out.push({ type: "day", key: day, label: dayLabel(at, now) });
      lastDay = day;
      prev = null;
    }
    const login = c.user?.login ?? tr("usuario eliminado");
    const joins = !!prev && sameLogin(prev.login, login) && at - prev.at < GROUP_GAP_MS;
    if (prev && !joins) prev.tail = true;
    const msg: Extract<ChatItem, { type: "msg" }> = {
      type: "msg",
      id: c.id,
      login,
      avatar: c.user?.avatar_url ?? "",
      mine: sameLogin(login, me),
      body: c.body,
      at,
      head: !joins,
      tail: false,
    };
    out.push(msg);
    prev = msg;
  }
  if (prev) prev.tail = true;
  return out;
}

/** Junta comentarios nuevos con los que ya había (por id, los nuevos sustituyen) y los deja en orden. */
export function mergeComments(existing: readonly ChatComment[], incoming: readonly ChatComment[]): ChatComment[] {
  const by = new Map<number, ChatComment>();
  for (const c of existing) by.set(c.id, c);
  for (const c of incoming) by.set(c.id, c);
  return [...by.values()].sort((a, b) => a.id - b.id);
}

/** Mensajes de otras personas posteriores al último que se vio. */
export function unreadCount(comments: readonly ChatComment[], lastSeenId: number, me: string): number {
  return comments.filter((c) => c.id > lastSeenId && !sameLogin(c.user?.login, me)).length;
}

export interface BodyPart {
  text: string;
  kind: "text" | "mention" | "link" | "issue" | "file";
  issue?: number;
  path?: string;
  line?: number;
}

/** Parte un mensaje en texto, @menciones, enlaces https, #issues y referencias archivo:línea sin usar HTML. */
export function splitBody(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  const re =
    /(https?:\/\/[^\s<>"']+)|(^|[^\w@])(@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])|(^|[\s(])(#[1-9]\d{0,6})(?![\w-])|(^|[\s(`"'])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}):(\d{1,6})(?![\w.:/])/g;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[1]) {
      // Los signos finales de puntuación no forman parte del enlace.
      const url = m[1].replace(/[.,;:!?)\]]+$/, "");
      if (m.index > last) parts.push({ text: body.slice(last, m.index), kind: "text" });
      parts.push({ text: url, kind: "link" });
      last = m.index + url.length;
      re.lastIndex = last;
    } else if (m[3]) {
      const start = m.index + m[2].length;
      if (start > last) parts.push({ text: body.slice(last, start), kind: "text" });
      parts.push({ text: m[3], kind: "mention" });
      last = start + m[3].length;
    } else if (m[5]) {
      const start = m.index + m[4].length;
      if (start > last) parts.push({ text: body.slice(last, start), kind: "text" });
      parts.push({ text: m[5], kind: "issue", issue: Number(m[5].slice(1)) });
      last = start + m[5].length;
    } else if (m[7]) {
      const start = m.index + m[6].length;
      if (m[7].includes("..")) continue;
      if (start > last) parts.push({ text: body.slice(last, start), kind: "text" });
      parts.push({ text: `${m[7]}:${m[8]}`, kind: "file", path: m[7], line: Number(m[8]) });
      last = start + m[7].length + 1 + m[8].length;
    }
  }
  if (last < body.length) parts.push({ text: body.slice(last), kind: "text" });
  return parts;
}

export const mentionsPerson = (body: string, login: string): boolean =>
  !!login && splitBody(body).some((p) => p.kind === "mention" && p.text.slice(1).toLowerCase() === login.toLowerCase());

export interface MentionQuery {
  start: number;
  query: string;
}

/** ¿El cursor está escribiendo una @mención? Devuelve dónde empieza y lo escrito tras la @. */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const m = /(^|[\s(])@([A-Za-z0-9-]{0,39})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** Personas cuyo usuario empieza por lo escrito (las que empiezan por ello antes que las que solo lo contienen). */
export function suggestMembers(members: readonly ChatUser[], query: string, limit = 6): ChatUser[] {
  const q = query.toLowerCase();
  const starts = members.filter((u) => u.login.toLowerCase().startsWith(q));
  const has = members.filter((u) => !u.login.toLowerCase().startsWith(q) && u.login.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, limit);
}

/** Texto con la mención elegida puesta en lugar de lo que se estaba escribiendo. */
export function insertMention(text: string, q: MentionQuery, login: string): { text: string; caret: number } {
  const caret = q.start + q.query.length + 1;
  const next = `${text.slice(0, q.start)}@${login} ${text.slice(caret)}`;
  return { text: next, caret: q.start + login.length + 2 };
}

/** «hace 5 min», «hace 2 h», «hace 3 d». */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return tr("hace un momento");
  if (s < 3600) return tr("hace {n} min", { n: Math.round(s / 60) });
  if (s < 86400) return tr("hace {n} h", { n: Math.round(s / 3600) });
  return tr("hace {n} d", { n: Math.round(s / 86400) });
}

/** Última vez que escribió cada persona (milisegundos), para el panel de miembros. */
export function lastSpoke(comments: readonly ChatComment[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of comments) {
    const login = c.user?.login.toLowerCase();
    if (!login) continue;
    const at = Date.parse(c.created_at) || 0;
    if (at > (out.get(login) ?? 0)) out.set(login, at);
  }
  return out;
}

export const ROOM_LABEL = "pulso-chat";
/** La issue que guarda el chat no es trabajo: no debe salir en el tablero ni en la lista de issues. */
export const isChatRoom = (issue: { labels: readonly { name: string }[] }): boolean =>
  issue.labels.some((l) => l.name.toLowerCase() === ROOM_LABEL);
// Fijo, sin traducir: es el nombre de la issue de la sala en GitHub, igual para todo el equipo.
export const ROOM_TITLE = "💬 Chat de Pulso";
export const MAX_MESSAGE = 4000;
