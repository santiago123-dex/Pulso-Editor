import { lang, t as tr } from "./i18n";
import { bus } from "./core/events";
import { currentRepo } from "./core/repo";
import { readStorage, writeStorage } from "./core/storage";
import { ago, buildItems, insertMention, lastSpoke, MAX_MESSAGE, mentionAt, mentionsPerson, mergeComments, splitBody, suggestMembers, unreadCount, type ChatComment, type ChatUser } from "./chatModel";
import { openExternal } from "./external";
import { getAccount, hasToken, isAuthProblem } from "./github";
import { connectButton } from "./githubConnect";
import { openFile } from "./groups";
import { githubChatStore as store, type ChatRepo, type ChatRoom } from "./repoChatApi";
import { setStatus, showDialog } from "./ui";
import { $, h } from "./util";
import { ws } from "./workspace";
import "./repoChat.css";

/** Chat de grupo del repositorio: la sala es una issue con la etiqueta «pulso-chat» que todas las personas encuentran solas. */
const POLL_MS = 4000;
const FULL_RELOAD_MS = 5 * 60_000;
const ROOM_CHECK_MS = 30_000;
const roomCheckMs = () => Number(readStorage("pulso.chatRoomCheckMs")) || ROOM_CHECK_MS;
const BACKGROUND_MS = 45_000;
const backgroundMs = () => Number(readStorage("pulso.chatBackgroundMs")) || BACKGROUND_MS;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const repoKey = (r: ChatRepo) => `${r.owner}/${r.repo}`.toLowerCase();
const seenKey = (r: ChatRepo) => `pulso.chatSeen:${repoKey(r)}`;
const readSeen = (r: ChatRepo) => Number(readStorage(seenKey(r))) || 0;

/** Solo se cargan imágenes del dominio oficial de avatares. */
function avatar(user: { login: string; avatar_url?: string }, size = 28): HTMLElement {
  const box = h("span", "chat-avatar");
  box.style.width = box.style.height = `${size}px`;
  box.textContent = user.login.slice(0, 1).toUpperCase();
  try {
    const url = new URL(user.avatar_url ?? "");
    if (url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com") {
      const img = document.createElement("img");
      img.draggable = false; img.alt = ""; img.loading = "lazy"; img.src = url.href;
      img.onload = () => { box.textContent = ""; box.append(img); };
    }
  } catch { /* sin imagen: queda la inicial */ }
  return box;
}

// ---------- Estado de la sala abierta (y del aviso de mensajes nuevos con el chat cerrado) ----------
interface Room { repo: ChatRepo; room: ChatRoom; comments: ChatComment[]; me: string; members: ChatUser[]; kind: "collaborators" | "contributors" | "unknown" }
let current: Room | null = null;
let background = 0;

function setBadge(n: number) {
  const badge = document.getElementById("chat-badge")!;
  const launch = document.querySelector<HTMLElement>('.act[data-view="chat"]')!;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n <= 0;
  launch.title = n > 0 ? (n === 1 ? tr("Chat del equipo · 1 mensaje nuevo") : tr("Chat del equipo · {count} mensajes nuevos", { count: n })) : tr("Chat del equipo");
}

const sinceOf = (list: readonly ChatComment[]) => (list.length ? list[list.length - 1].created_at : "1970-01-01T00:00:00Z");

/** Con el chat cerrado, pregunta de vez en cuando si hay mensajes nuevos para mostrar la insignia. */
function startBackground() {
  window.clearInterval(background);
  background = window.setInterval(async () => {
    const r = current;
    if (!r || isOpen() || document.visibilityState !== "visible" || !hasToken() || ws.root === null) return;
    try {
      const fresh = await store.newer(r.repo, r.room.number, sinceOf(r.comments));
      if (!fresh || current !== r) return;
      r.comments = mergeComments(r.comments, fresh);
      setBadge(unreadCount(r.comments, readSeen(r.repo), r.me));
    } catch { /* sin red o sin permiso: se reintenta */ }
  }, backgroundMs());
}

// ---------- Vista ----------
/** El chat es una vista de la barra lateral; con el botón de pantalla completa pasa a ocupar toda la ventana (menos las barras). */
const viewEl = () => document.getElementById("view-chat")!;
let session = 0;
let pollTimer = 0;
let onFocusTick: (() => void) | null = null;
let shown = false;
const FULL_KEY = "pulso.chatFull";
const isFull = () => readStorage(FULL_KEY) === "1";
const isOpen = () => shown && !document.getElementById("app")!.classList.contains("no-sidebar");

function applyMode() {
  const v = viewEl();
  v.classList.toggle("chat-full", isFull());
  v.classList.toggle("chat-docked", !isFull());
  // Con espacio de sobra la lista de personas va a la vista; en la barra lateral, plegada.
  v.querySelector(".chat-shell")?.classList.toggle("members-open", isFull());
  const expand = v.querySelector<HTMLElement>(".chat-expand");
  if (expand) { expand.title = isFull() ? tr("Volver a la barra lateral (Esc)") : tr("Pantalla completa"); expand.setAttribute("aria-label", expand.title); expand.innerHTML = isFull() ? ICON_SHRINK : ICON_EXPAND; }
}

function setFull(full: boolean) {
  writeStorage(FULL_KEY, full ? "1" : "0");
  if (full) bus.emit("overlay", "chat");
  applyMode();
}

const ICON_EXPAND = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_SHRINK = '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const ICON_PEOPLE = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.4c1.7.6 2.7 2.2 3 4.6"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';

const iconBtn = (svg: string, title: string, cls = ""): HTMLButtonElement => {
  const b = h("button", `icon-btn ${cls}`.trim());
  b.type = "button"; b.title = title; b.setAttribute("aria-label", title); b.innerHTML = svg;
  return b;
};

/** La vista se oculta (otra vista lateral, o la barra se pliega): se paran las consultas rápidas y la insignia sigue contando. */
export function stopChat() {
  shown = false;
  session++;
  window.clearInterval(pollTimer);
  window.removeEventListener("keydown", onKey, true);
  if (onFocusTick) { window.removeEventListener("focus", onFocusTick); onFocusTick = null; }
  if (current) setBadge(unreadCount(current.comments, readSeen(current.repo), current.me));
}

/** Al cambiar o cerrar carpeta se descarta la sala del repositorio anterior y se detiene el polling en segundo plano. */
export function resetRepoChat() {
  current = null;
  session++;
  window.clearInterval(pollTimer);
  window.clearInterval(background);
  background = 0;
  setBadge(0);
  if (shown) void openChat();
}

/** Lo llama el selector de vistas de la barra lateral. */
export function setChatVisible(visible: boolean) { if (visible) void openChat(); else stopChat(); }

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || document.querySelector(".modal")) return;
  if (document.querySelector(".chat-mention:not([hidden])")) return; // lo cierra el propio cuadro
  if (isFull()) { e.preventDefault(); e.stopPropagation(); setFull(false); }
}

function shell(title: string, sub: string): { root: HTMLElement; head: HTMLElement; body: HTMLElement; tools: HTMLElement } {
  const root = h("div", "chat-shell");
  const head = h("div", "chat-head");
  const t = h("div", "chat-titles");
  t.append(h("span", "chat-title", title), h("span", "chat-sub", sub));
  const tools = h("div", "chat-tools");
  const expand = iconBtn(ICON_EXPAND, tr("Pantalla completa"), "chat-expand");
  expand.onclick = () => setFull(!isFull());
  tools.append(expand);
  head.append(t, h("span", "grow"), tools);
  const body = h("div", "chat-body");
  root.append(head, body);
  return { root, head, body, tools };
}

function message(text: string, ...extra: HTMLElement[]): HTMLElement {
  const wrap = h("div", "chat-msg-box");
  wrap.append(h("p", "chat-msg", text), ...extra);
  return wrap;
}

/** `known`: sala recién creada, para no volver a buscarla ni a leer una conversación vacía. */
export async function openChat(known?: ChatRoom) {
  stopChat();
  shown = true;
  const mine = session;
  if (isFull()) bus.emit("overlay", "chat");
  window.addEventListener("keydown", onKey, true);
  const ui = shell(tr("Chat del equipo"), tr("Conversación del repositorio"));
  viewEl().replaceChildren(ui.root);
  applyMode();
  const show = (...nodes: HTMLElement[]) => ui.body.replaceChildren(...nodes);
  show(message(tr("Buscando el chat del repositorio…")));

  const repo = await currentRepo();
  if (mine !== session) return;
  if (!repo) { show(message(tr("Abre una carpeta cuyo remoto «origin» sea un repositorio de GitHub para chatear con su equipo."))); return; }
  ui.root.querySelector(".chat-sub")!.textContent = `${repo.owner}/${repo.repo}`;
  if (!hasToken()) {
    show(message(tr("Conecta tu cuenta de GitHub para leer y escribir en el chat del equipo. Es un clic: se usa la sesión de Git de este equipo o se abre el navegador para autorizar."), connectButton(() => void openChat())));
    return;
  }

  let room: ChatRoom | null = known ?? null;
  try { if (!room) room = await store.findRoom(repo); }
  catch (e) {
    if (mine !== session) return;
    show(message(errorText(e), ...(isAuthProblem(e) ? [connectButton(() => void openChat())] : [])));
    return;
  }
  if (mine !== session) return;
  if (!room) {
    const create = h("button", "diff-btn primary", tr("Crear el chat del equipo"));
    create.onclick = async () => {
      const r = await showDialog({
        title: tr("Crear el chat del equipo"),
        message: tr("Se creará en {repo} una issue con la etiqueta «pulso-chat». Cada mensaje del chat será un comentario de esa issue, así que lo verá quien pueda ver el repositorio. Las demás personas que usen Pulso en este repositorio la encontrarán sola.", { repo: `${repo.owner}/${repo.repo}` }),
        buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Crear"), value: "ok", primary: true }],
      });
      if (r !== "ok" || mine !== session) return;
      show(message(tr("Creando el chat del equipo en GitHub…")));
      try { const made = await store.createRoom(repo); if (mine === session) void openChat(made); }
      catch (e) { if (mine === session) show(message(errorText(e), ...(isAuthProblem(e) ? [connectButton(() => void openChat())] : []))); }
    };
    show(message(tr("Todavía no hay chat para este repositorio. Quien lo cree lo deja disponible para todo el equipo."), create));
    return;
  }

  let me = getAccount();
  let comments: ChatComment[];
  try {
    const [list, who] = await Promise.all([known ? Promise.resolve([] as ChatComment[]) : store.comments(repo, room.number), me ? Promise.resolve({ login: me }) : store.me().catch(() => ({ login: "" }))]);
    comments = list; me = who.login;
  } catch (e) {
    if (mine !== session) return;
    show(message(errorText(e), ...(isAuthProblem(e) ? [connectButton(() => void openChat())] : [])));
    return;
  }
  if (mine !== session) return;

  const state: Room = current && repoKey(current.repo) === repoKey(repo) && current.room.number === room.number
    ? current
    : { repo, room, comments: [], me, members: [], kind: "unknown" };
  state.comments = mergeComments(state.comments, comments); state.me = me; state.room = room;
  current = state;
  mount(ui, state, mine);
}

// ---------- Conversación ----------
function mount(ui: { root: HTMLElement; head: HTMLElement; body: HTMLElement; tools: HTMLElement }, st: Room, mine: number) {
  const { repo, room } = st;
  const alive = () => mine === session && ws.root !== null && current === st;

  const people = iconBtn(ICON_PEOPLE, tr("Personas del repositorio"), "chat-people");
  people.onclick = () => ui.root.classList.toggle("members-open");
  const gh = iconBtn(ICON_LINK, tr("Abrir en GitHub la issue que guarda los mensajes"));
  gh.onclick = () => void openExternal(room.html_url);
  ui.tools.prepend(people, gh);

  const main = h("div", "chat-main");
  const scroll = h("div", "chat-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "log");
  scroll.setAttribute("aria-label", tr("Mensajes"));
  const fresh = h("button", "chat-fresh", tr("↓ Mensajes nuevos"));
  fresh.hidden = true;
  const note = h("div", "chat-note");
  const compose = h("form", "chat-compose");
  const box = h("textarea", "chat-input");
  box.rows = 1; box.placeholder = tr("Escribe un mensaje…"); box.maxLength = MAX_MESSAGE;
  box.setAttribute("aria-label", tr("Mensaje"));
  const send = h("button", "chat-send");
  send.type = "submit"; send.title = tr("Enviar (Enter)"); send.setAttribute("aria-label", tr("Enviar")); send.innerHTML = ICON_SEND;
  const mention = h("div", "chat-mention");
  mention.hidden = true;
  mention.setAttribute("role", "listbox");
  const field = h("div", "chat-field");
  field.append(box, send);
  compose.append(mention, field);
  const privacy = h("div", "chat-privacy", tr("Enter envía · Mayús+Enter, nueva línea · @ menciona. Lo ve quien tenga acceso al repositorio; llega en unos segundos."));
  main.append(scroll, fresh, note, compose, privacy);

  const side = h("aside", "chat-members");
  ui.body.replaceChildren(main, side);

  // --- mensajes ---
  let pending: { tmp: number; body: string; failed: boolean }[] = [];
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;

  function bubble(body: string): HTMLElement {
    const b = h("div", "chat-bubble");
    for (const part of splitBody(body)) {
      if (part.kind === "text") b.append(document.createTextNode(part.text));
      else if (part.kind === "mention") b.append(h("span", `chat-mention-tag${part.text.slice(1).toLowerCase() === st.me.toLowerCase() ? " is-me" : ""}`, part.text));
      else if (part.kind === "issue" && part.issue) {
        const a = h("button", "chat-ref", part.text);
        a.type = "button";
        a.title = tr("Abrir issue #{number} en GitHub", { number: part.issue });
        a.onclick = () => void openExternal(`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${part.issue}`);
        b.append(a);
      } else if (part.kind === "file" && part.path && part.line) {
        const a = h("button", "chat-ref chat-file-ref", part.text);
        a.type = "button";
        a.title = tr("Abrir {path} en la línea {line}", { path: part.path, line: part.line });
        a.onclick = () => {
          if (!ws.root) return;
          if (isFull()) setFull(false);
          void openFile(`${ws.root}/${part.path}`, { line: part.line });
        };
        b.append(a);
      } else {
        const a = h("a", "chat-link", part.text);
        a.href = part.text; a.rel = "noreferrer";
        a.onclick = (e) => { e.preventDefault(); void openExternal(part.text); };
        b.append(a);
      }
    }
    return b;
  }

  function render(forceBottom = false) {
    const stick = forceBottom || atBottom();
    const items = buildItems(st.comments, st.me);
    const nodes: HTMLElement[] = [];
    if (st.comments.length >= 500) nodes.push(h("div", "chat-day", tr("Se muestran los últimos 500 mensajes; el resto está en GitHub")));
    if (!items.length && !pending.length) nodes.push(h("div", "chat-empty", tr("Todavía no hay mensajes. Escribe el primero: lo verán todas las personas del repositorio.")));
    for (const it of items) {
      if (it.type === "day") { nodes.push(h("div", "chat-day", it.label)); continue; }
      const row = h("div", `chat-row${it.mine ? " mine" : ""}${it.head ? " head" : ""}${it.tail ? " tail" : ""}`);
      if (!it.mine) row.append(it.head ? avatar({ login: it.login, avatar_url: it.avatar }) : h("span", "chat-avatar-gap"));
      const col = h("div", "chat-col");
      const time = new Date(it.at).toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" });
      if (it.head && !it.mine) col.append(h("div", "chat-who", it.login));
      const b = bubble(it.body);
      if (mentionsPerson(it.body, st.me) && !it.mine) b.classList.add("pings-me");
      b.title = new Date(it.at).toLocaleString(lang());
      col.append(b);
      if (it.tail) col.append(h("div", "chat-time", time));
      row.append(col);
      nodes.push(row);
    }
    for (const p of pending) {
      const row = h("div", "chat-row mine tail pending");
      const col = h("div", "chat-col");
      col.append(bubble(p.body));
      const state = h("div", "chat-time", p.failed ? tr("No se envió · ") : tr("Enviando…"));
      if (p.failed) {
        const retry = h("button", "chat-retry", tr("Reintentar"));
        retry.onclick = () => { pending = pending.filter((x) => x !== p); box.value = p.body; void submit(); };
        state.append(retry);
      }
      col.append(state);
      row.append(col);
      nodes.push(row);
    }
    scroll.replaceChildren(...nodes);
    if (stick) { scroll.scrollTop = scroll.scrollHeight; fresh.hidden = true; }
    markSeen();
  }

  function markSeen() {
    if (!isOpen()) return;
    const last = st.comments.length ? st.comments[st.comments.length - 1].id : 0;
    if (last > readSeen(repo)) writeStorage(seenKey(repo), String(last));
    setBadge(0);
  }

  // --- miembros ---
  function renderMembers() {
    const spoke = lastSpoke(st.comments);
    const logins = new Set(st.members.map((m) => m.login.toLowerCase()));
    // Quien escribió pero no sale en la lista (por ejemplo, sin permiso para ver colaboradores) también aparece.
    const extra: ChatUser[] = [];
    for (const c of st.comments) if (c.user && !logins.has(c.user.login.toLowerCase())) { logins.add(c.user.login.toLowerCase()); extra.push(c.user); }
    const all = [...st.members, ...extra].sort((a, b) => (spoke.get(b.login.toLowerCase()) ?? 0) - (spoke.get(a.login.toLowerCase()) ?? 0) || a.login.localeCompare(b.login));
    const title = st.kind === "contributors" ? tr("Contribuyentes · {count}", { count: all.length }) : tr("Personas · {count}", { count: all.length });
    const nodes: HTMLElement[] = [h("div", "chat-members-title", title)];
    if (st.kind === "contributors") nodes.push(h("div", "chat-members-hint", tr("GitHub no dejó ver los colaboradores: se muestran quienes han contribuido, que no siempre tienen acceso.")));
    if (!all.length) nodes.push(h("div", "chat-members-hint", st.kind === "unknown" ? tr("Cargando personas…") : tr("Sin personas que mostrar.")));
    for (const u of all) {
      const li = h("button", "chat-member");
      li.type = "button";
      li.title = tr("Mencionar a @{login}", { login: u.login });
      const text = h("span", "chat-member-text");
      const me = u.login.toLowerCase() === st.me.toLowerCase();
      text.append(h("span", "chat-member-name", u.login + (me ? tr(" (tú)") : "")));
      const t = spoke.get(u.login.toLowerCase());
      text.append(h("span", "chat-member-when", t ? tr("escribió {when}", { when: ago(t) }) : tr("sin mensajes")));
      li.append(avatar(u, 26), text);
      li.onclick = () => { insertAtCaret(`@${u.login} `); };
      nodes.push(li);
    }
    side.replaceChildren(...nodes);
  }

  // --- envío ---
  function insertAtCaret(text: string) {
    const a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
    box.value = box.value.slice(0, a) + text + box.value.slice(b);
    box.selectionStart = box.selectionEnd = a + text.length;
    box.focus(); autosize();
  }
  const autosize = () => { box.style.height = "auto"; box.style.height = `${Math.min(box.scrollHeight, 140)}px`; };

  async function submit() {
    const body = box.value.trim();
    if (!body || !alive()) return;
    box.value = ""; autosize(); closeMention();
    const p = { tmp: -Date.now(), body, failed: false };
    pending.push(p);
    render(true);
    try {
      const made = await store.send(repo, room.number, body);
      pending = pending.filter((x) => x !== p);
      if (!alive()) return;
      st.comments = mergeComments(st.comments, [made]);
      render(true); renderMembers();
    } catch (e) {
      p.failed = true;
      if (!alive()) return;
      note.textContent = tr("No se pudo enviar: {error}", { error: errorText(e) });
      render(true);
    }
  }
  compose.onsubmit = (e) => { e.preventDefault(); void submit(); };

  // --- menciones ---
  let suggestions: ChatUser[] = [];
  let picked = 0;
  function closeMention() { mention.hidden = true; suggestions = []; }
  function updateMention() {
    const q = mentionAt(box.value, box.selectionStart ?? 0);
    if (!q) { closeMention(); return; }
    suggestions = suggestMembers([...st.members, ...st.comments.flatMap((c) => (c.user ? [c.user] : []))].filter((u, i, a) => a.findIndex((x) => x.login.toLowerCase() === u.login.toLowerCase()) === i), q.query);
    if (!suggestions.length) { closeMention(); return; }
    picked = Math.min(picked, suggestions.length - 1);
    mention.replaceChildren(...suggestions.map((u, i) => {
      const o = h("button", `chat-mention-opt${i === picked ? " on" : ""}`);
      o.type = "button"; o.tabIndex = -1; o.setAttribute("role", "option");
      o.append(avatar(u, 18), h("span", "", u.login));
      o.onmousedown = (e) => { e.preventDefault(); choose(i); };
      return o;
    }));
    mention.hidden = false;
  }
  function choose(i: number) {
    const q = mentionAt(box.value, box.selectionStart ?? 0);
    const u = suggestions[i];
    if (!q || !u) return;
    const r = insertMention(box.value, q, u.login);
    box.value = r.text; box.selectionStart = box.selectionEnd = r.caret;
    closeMention(); box.focus(); autosize();
  }
  box.oninput = () => { note.textContent = ""; picked = 0; autosize(); updateMention(); };
  box.onclick = updateMention;
  box.onkeydown = (e) => {
    if (!mention.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); picked = (picked + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length; updateMention(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(picked); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  };
  box.onblur = () => window.setTimeout(closeMention, 120);
  fresh.onclick = () => { scroll.scrollTop = scroll.scrollHeight; fresh.hidden = true; };
  scroll.onscroll = () => { if (atBottom()) fresh.hidden = true; };

  // --- actualización ---
  let lastFull = Date.now();
  let lastRoomCheck = Date.now();
  let busy = false;
  async function tick() {
    if (busy || !alive() || document.visibilityState !== "visible") return;
    busy = true;
    try {
      if (Date.now() - lastRoomCheck > roomCheckMs()) {
        lastRoomCheck = Date.now();
        // Si la issue de la sala se cerró o se borró en GitHub, el chat ya no es esa sala: se vuelve a buscar u ofrecer crear otra.
        if ((await store.roomOpen(repo, room.number)) === false && alive()) {
          current = null; setBadge(0);
          setStatus(tr("La issue del chat se cerró o se borró en GitHub"), 8000);
          void openChat();
          return;
        }
        if (!alive()) return;
      }
      if (Date.now() - lastFull > FULL_RELOAD_MS) {
        // Cada tanto se relee todo para reflejar mensajes editados o borrados en GitHub.
        const list = await store.comments(repo, room.number);
        if (!alive()) return;
        lastFull = Date.now();
        if (JSON.stringify(list.map((c) => [c.id, c.body])) !== JSON.stringify(st.comments.map((c) => [c.id, c.body]))) { st.comments = list; render(); renderMembers(); }
      } else {
        const news = await store.newer(repo, room.number, sinceOf(st.comments));
        if (!alive() || !news) { if (alive()) note.textContent = ""; return; }
        const before = st.comments.length;
        const known = new Map(st.comments.map((c) => [c.id, c.body]));
        const changed = news.filter((c) => known.get(c.id) !== c.body);
        if (!changed.length) return;
        const stick = atBottom();
        st.comments = mergeComments(st.comments, news);
        render();
        renderMembers();
        if (st.comments.length > before && !stick && changed.some((c) => c.user?.login.toLowerCase() !== st.me.toLowerCase())) fresh.hidden = false;
      }
      note.textContent = "";
    } catch (e) {
      if (alive()) note.textContent = tr("Sin conexión con GitHub ({error}). Se reintenta solo.", { error: errorText(e) });
    } finally { busy = false; }
  }
  pollTimer = window.setInterval(() => void tick(), POLL_MS);
  onFocusTick = () => void tick();
  window.addEventListener("focus", onFocusTick);

  render(true);
  renderMembers();
  box.focus();
  void store.members(repo).then(({ users, kind }) => { if (!alive()) return; st.members = users; st.kind = kind; renderMembers(); })
    .catch(() => { if (alive()) { st.kind = "contributors"; renderMembers(); } });
  startBackground();
}
// Abrir el tablero con el chat en pantalla completa lo devuelve a la barra lateral.
bus.on("overlay", (kind) => { if (kind === "board" && isFull()) setFull(false); });
