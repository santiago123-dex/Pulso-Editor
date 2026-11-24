import { lang, t as tr } from "./i18n";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "./core/events";
import { readStorage, removeStorage, writeStorage } from "./core/storage";
import { PROVIDERS, type AiTool, type AllAiTools } from "./ai/catalog";
import { addRequest, buildPermissionCard, clearConversation, parsePermissionEvent, pendingFor, resolveRequest } from "./ai/permissions";
import { applyAiAppearance, buildAppearancePopover } from "./ai/appearance";
import { buildPrompt, fileMentionAt, filterProjectFiles } from "./aiContext";
import {
  createProviderNormalizer,
  exitEvent,
  mergeAssistantRuns,
  formatModelName,
  isAuthError,
  planLabel,
  pruneUsage,
  reduce,
  splitAssistantTurn,
  touchedFiles,
  userEvent,
  type AiEvent,
  type AiProvider,
  type Block,
  type Turn,
  type UserImage,
} from "./aiModel";
import { chatsFor, deleteChat, initHistory, loadChats, sameDir, titleFrom } from "./aiStore";
import { checkExternal } from "./docs";
import { refreshTree } from "./explorer";
import { activePath, focusedEditor, openFile } from "./groups";
import { agoFrom } from "./historyModel";
import { refreshScm } from "./scm";
import { promptText, setStatus, showDialog } from "./ui";
import { $, baseName, dirName, h } from "./util";
import { rel, ws } from "./workspace";
import { openExternal } from "./external";
import { extractProposedEdits } from "./workflow/issueWorkflowModel";
import { reviewProposedEdit } from "./workflow/issueWorkflow";
import { ICON_EXPAND, ICON_SHRINK, ICON_PLUS, ICON_CLOCK, ICON_SEND, ICON_STOP, ICON_IMAGE, ICON_PALETTE, iconBtn } from "./ai/icons";
import { markdown, setLeaveFullscreenHook } from "./ai/markdownView";
import { S, ctl, lives, tools, isFull, seconds, viewEl, q, USAGE_KEY, USAGE_SIG_KEY, FULL_KEY, type Live, type AiMode } from "./ai/chatState";
import { INTERRUPTED_KEY, fromSaved, newLive, persist, saveRunningBeforeExit } from "./ai/conversations";
import { refreshExtraUsage, refreshUsage, saveUsage } from "./ai/usageSync";
import { buildDenialCard, dismissedDenials, proposalStatus, renderIssueBanner } from "./ai/denials";
import { detectProviderNow, renderFoot, setupMessage, startLoginFlow } from "./ai/accountView";
import { installAndConnect, openAccountsPopover, openModelPopover } from "./ai/popovers";
import { modelButtonText, syncModelButton } from "./ai/modelOptions";
import { buildEmptyWorkbench } from "./ai/workbench";
import { activityCard, resolveToolFile, turnNodes } from "./ai/turnView";
import { addImageFiles, attachProjectFile, editorContext, pruneUnusedImages, renderChips } from "./ai/attachments";
import { dismissPopover, openPopover } from "./ai/popoverBase";
import { openQuickPromptsPopover } from "./ai/quota";
import "./aiChat.css";

setLeaveFullscreenHook(() => { if (isFull()) setFull(false); });

/**
 * Asistente de IA: conversa en la carpeta del proyecto con Claude Code, ChatGPT/Codex (`codex app-server`) o Antigravity (`agy`).
 * Pulso nunca ve ni guarda credenciales; cada herramienta administra su propia sesión.
 */

function switchProvider(next: AiProvider) {
  if (S.activeProvider === next && S.tool === tools[next]) return;
  S.activeProvider = next;
  writeStorage("pulso.ai.provider", next);
  S.model = readStorage(PROVIDERS[next].modelKey) ?? "";
  S.tool = tools[next];
  if (S.current) {
    if (!S.current.convo.messages.length) {
      S.current.provider = next;
      S.current.normalize = createProviderNormalizer(next, S.model);
    } else if (S.current.provider !== next) {
      S.current = newLive();
    }
  }
  if (!S.tool) void detect(true);
  if (S.shown) renderBody();
}



// ---------- Eventos de la herramienta ----------
let diskTimer = 0;
function refreshDisk() {
  window.clearTimeout(diskTimer);
  diskTimer = window.setTimeout(() => { void checkExternal(); void refreshTree(); void refreshScm(); }, 500);
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued || !S.shown) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; renderBody(); });
}


let lastPersistAt = 0;

function apply(live: Live, ev: AiEvent) {
  const before = live.convo.touched;
  live.convo = reduce(live.convo, ev);
  if (live.convo.usage.fiveHour || live.convo.usage.sevenDay) {
    if (live.provider === "claude") saveUsage(live.convo.usage);
    else if (live.provider === "codex") S.codexUsage = pruneUsage(live.convo.usage);
  }
  if (live.convo.touched > before) refreshDisk();
  const now = Date.now();
  if (ev.type === "result" || ev.type === "pulso_exit") {
    lastPersistAt = now;
    persist(live, true);
    removeStorage(INTERRUPTED_KEY);
    if (live.convo.touched) refreshDisk();
    if (live.provider === "codex" || live.provider === "antigravity") void refreshExtraUsage();
  } else if (ev.type === "pulso_user" || ev.type === "system" || now - lastPersistAt >= 1200) {
    lastPersistAt = now;
    persist(live);
  }
  if (S.current === live) schedulePaint();
}

interface TurnCacheEntry { parts: Turn[]; active: boolean; activitySig: string; slot: HTMLElement }

const activitySignature = (t: Turn, active: boolean): string => {
  if (t.role !== "assistant") return "";
  const { activity } = splitAssistantTurn(t.blocks);
  return `${active ? "1" : "0"}:${activity.length}:${activity.map((b) => (b.kind === "tool" ? `${b.id}:${b.result?.length ?? 0}:${b.error ? 1 : 0}` : b.kind === "image" ? b.name : `${b.kind}:${b.text.length}`)).join(",")}`;
};

/** ¿Son los mismos turnos originales, en el mismo orden? (si sí, el nodo ya pintado sirve) */
const sameParts = (a: Turn[], b: Turn[]) => a.length === b.length && a.every((t, i) => t === b[i]);
let renderedChatId = "";
let renderedTurns: TurnCacheEntry[] = [];
let turnsHost: HTMLElement | null = null;
let tailHost: HTMLElement | null = null;

function resetTurnCache() {
  renderedChatId = "";
  renderedTurns = [];
  turnsHost = null;
  tailHost = null;
}

function renderBody() {
  const body = q(".ai-body");
  const compose = q(".ai-compose");
  if (!body || !compose) return;
  const prov = S.current?.convo.messages.length ? S.current.provider : S.activeProvider;
  const meta = PROVIDERS[prov];
  const curTool = tools[prov] ?? (prov === S.activeProvider ? S.tool : null);
  S.tool = tools[S.activeProvider];
  const sub = q(".ai-sub");
  if (sub) {
    if (!curTool?.installed) sub.textContent = "";
    else if (prov === "claude") sub.textContent = `Claude Code${curTool.version ? ` ${curTool.version.split(" ")[0]}` : ""}${curTool.plan ? " · " + tr("plan {plan}", { plan: planLabel(curTool.plan) }) : ""}`;
    else sub.textContent = `${meta.title}${curTool.version ? ` ${curTool.version.split(" ")[0]}` : ""}${curTool.plan ? ` · ${curTool.plan}` : ""}`;
  }
  const liveDot = q(".ai-live-dot");
  if (liveDot) {
    liveDot.className = `ai-live-dot${curTool?.logged_in ? " on" : curTool ? " off" : " wait"}`;
  }
  const planBadge = q(".ai-plan-pill");
  if (planBadge) {
    planBadge.hidden = !curTool?.installed || !curTool.logged_in;
    planBadge.textContent = prov === "claude"
      ? (curTool?.plan ? tr("Plan {plan}", { plan: planLabel(curTool.plan) }) : tr("Conectado"))
      : prov === "codex"
        ? (curTool?.auth_method === "api_key" ? "Codex API" : curTool?.plan && curTool.plan !== "ChatGPT" ? `ChatGPT ${planLabel(curTool.plan)}` : "ChatGPT")
        : prov === "local" ? "Ollama" : (curTool?.plan || "Antigravity");
  }
  const histBtn = q<HTMLButtonElement>(`.ai-tools button[title="${CSS.escape(tr("Conversaciones anteriores"))}"]`);
  if (histBtn) { histBtn.classList.toggle("active", S.historyOpen); histBtn.setAttribute("aria-pressed", String(S.historyOpen)); }
  renderIssueBanner();
  renderFoot();
  const recheck = () => { S.toolAt = 0; void detect(true); };
  const ready = !!curTool?.installed && curTool.logged_in && !!ws.root;
  compose.hidden = !ready || S.historyOpen;
  if (!curTool) { resetTurnCache(); body.replaceChildren(setupMessage(tr("Detectando {provider}", { provider: meta.title }), tr("Comprobando sesión y estado de tu cuenta…"))); return; }
  if (!curTool.installed) {
    resetTurnCache();
    const canInstall = !!(meta.npmPkg || meta.installCmdPs);
    const installBtn = canInstall ? (() => { const b = h("button", "foot-btn ai-btn-primary", tr("Instalar y conectar")); b.type = "button"; b.onclick = () => void installAndConnect(prov); return b; })() : null;
    const again = h("button", canInstall ? "foot-btn foot-btn-line" : "foot-btn ai-btn-primary", tr("Volver a comprobar")); again.type = "button"; again.onclick = recheck;
    const guide = h("button", "foot-btn foot-btn-line", tr("Cómo instalarlo")); guide.type = "button"; guide.onclick = () => void openExternal(meta.docsUrl);
    const extraBtns: HTMLElement[] = [...(installBtn ? [installBtn] : []), again, guide];
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", tr("Volver a Claude Code")); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(tr("{provider} no está instalado", { provider: meta.title }), meta.installHint, ...extraBtns));
    return;
  }
  if (!curTool.logged_in) {
    resetTurnCache();
    const login = h("button", "foot-btn ai-btn-primary", meta.loginBtn); login.type = "button";
    login.onclick = () => startLoginFlow(prov);
    const again = h("button", "foot-btn foot-btn-line", prov === "local" ? tr("Volver a comprobar") : tr("Ya inicié sesión: volver a comprobar")); again.type = "button"; again.onclick = recheck;
    const extraBtns: HTMLElement[] = [login, again];
    // Para Ollama «sin sesión» significa que no hay ningún modelo descargado.
    const couldNotCheck = !!curTool.error && prov !== "local" && prov !== "cloud";
    const title = prov === "cloud" ? tr("Conecta un proveedor de modelos") : couldNotCheck ? tr("No se pudo comprobar tu sesión de {provider}", { provider: meta.title }) : prov === "claude" ? tr("Inicia sesión para cargar tu plan") : prov === "local" ? tr("Descarga un modelo para Ollama") : tr("Inicia sesión en {provider}", { provider: meta.title });
    const desc = prov === "cloud"
      ? tr("Pega la clave de un proveedor (OpenAI, Anthropic, Google, OpenRouter, DeepSeek… hay más de 300 en models.dev). La clave se guarda en el almacén seguro del sistema y nunca vuelve a la ventana.")
      : couldNotCheck
      ? tr("{provider} está instalado, pero no se pudo comprobar si hay una sesión iniciada (puede ser algo puntual). Pulsa «volver a comprobar»; si sigue igual, inicia sesión de nuevo.", { provider: meta.title })
      : prov === "local"
      ? tr("Ollama está en marcha pero no tiene ningún modelo. «Descargar un modelo» baja qwen2.5-coder:7b (unos 4,7 GB) en la terminal integrada; también puedes descargar otro con «ollama pull <modelo>».")
      : prov === "claude"
      ? tr("Claude Code está instalado pero no hay una sesión iniciada. Se abrirá el inicio de sesión y tu plan se cargará al instante.")
      : tr("{provider} está instalado pero no hay una sesión iniciada. Se abrirá el inicio de sesión en la terminal integrada.", { provider: meta.title });
    if (prov !== "claude") {
      const back = h("button", "foot-btn foot-btn-line", tr("Volver a Claude Code")); back.type = "button"; back.onclick = () => switchProvider("claude");
      extraBtns.push(back);
    }
    body.replaceChildren(setupMessage(title, desc, ...extraBtns));
    return;
  }
  if (!ws.root) { resetTurnCache(); body.replaceChildren(setupMessage(tr("Abre un proyecto"), tr("Abre una carpeta de proyecto para que el asistente pueda leer tu código y ayudarte dentro de ella."))); return; }
  if (S.historyOpen) { resetTurnCache(); renderHistory(body); return; }

  if (S.current && !sameDir(S.current.cwd, ws.root)) {
    if (S.current.convo.messages.length) persist(S.current, true);
    else lives.delete(S.current.id);
    S.current = null;
    resetTurnCache();
  }
  const live = S.current ?? (S.current = newLive());
  const c = live.convo;
  syncModelButton();
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;

  if (!c.messages.length) {
    resetTurnCache();
    body.replaceChildren(buildEmptyWorkbench());
  } else {
    const canReuse = renderedChatId === live.id && turnsHost && tailHost && body.contains(turnsHost) && body.contains(tailHost);
    if (!canReuse) {
      renderedChatId = live.id;
      renderedTurns = [];
      turnsHost = h("div", "ai-turns-host");
      tailHost = h("div", "ai-tail-host");
      body.replaceChildren(turnsHost, tailHost);
    }

    const view = mergeAssistantRuns(c.messages);
    // Recortar turnos sobrantes si la lista se acortó.
    while (renderedTurns.length > view.length) {
      renderedTurns.pop()?.slot.remove();
    }

    let userNum = 0;
    view.forEach(({ turn: t, parts }, idx) => {
      if (t.role === "user") userNum += 1;
      const activeTurn = c.running && idx === view.length - 1 && t.role === "assistant";
      const existing = renderedTurns[idx];
      if (existing && sameParts(existing.parts, parts) && existing.active === activeTurn) {
        return; // Sin cambios: conserva el DOM y cualquier selección de texto del usuario.
      }
      const slot = existing ? existing.slot : h("div", "ai-turn-slot");
      if (!existing) {
        turnsHost!.append(slot);
      }
      const nextActSig = activitySignature(t, activeTurn);
      if (existing && t.role === "assistant" && existing.activitySig === nextActSig) {
        // Solo cambió el texto en curso: conservar la tarjeta de actividad para no reiniciar su pulso ni provocar saltos.
        const { final } = splitAssistantTurn(t.blocks);
        let wrap = slot.querySelector<HTMLElement>(":scope > .ai-assistant");
        if (final.trim()) {
          if (!wrap) { wrap = h("div", "ai-assistant"); slot.append(wrap); }
          wrap.replaceChildren(...markdown(final));
        } else {
          wrap?.remove();
        }
      } else {
        slot.replaceChildren(...turnNodes(t, userNum, activeTurn));
      }
      renderedTurns[idx] = { parts: [...parts], active: activeTurn, activitySig: nextActSig, slot };
    });

    const tailNodes: HTMLElement[] = [];
    const last = c.messages[c.messages.length - 1];
    const lastSlot = renderedTurns[renderedTurns.length - 1]?.slot;
    const hasRunningTrace = c.running && !!lastSlot?.querySelector(".ai-activity.running");
    if (c.running && (!last || last.role === "user" || (!last.done && !hasRunningTrace))) {
      // Aún no llegó nada del asistente: la misma tarjeta de actividad, para que no cambie de forma al empezar a responder.
      tailNodes.push(activityCard(`${live.id}:espera:${c.messages.length}`, [], true));
    }
    if (c.error) {
      const e = h("div", "ai-error");
      e.append(h("div", "", c.error));
      if (isAuthError(c.error)) {
        const b = h("button", "foot-btn foot-btn-line", tr("Iniciar sesión en la terminal")); b.type = "button";
        b.onclick = () => startLoginFlow(live.provider);
        e.append(b);
      }
      tailNodes.push(e);
      if (!c.running && c.outcome?.denials) {
        const dKey = `${live.id}:${c.messages.length}`;
        if (!dismissedDenials.has(dKey)) {
          tailNodes.push(buildDenialCard(live, c.outcome.denials, c.outcome.deniedActions, dKey));
        }
      }
    } else if (!c.running) {
      // Propuestas revisables en bloques ```lang path=... del último turno del asistente.
      const lastAssistant = [...c.messages].reverse().find((m) => m.role === "assistant");
      const assistantMd = lastAssistant
        ? lastAssistant.blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map((b) => b.text).join("\n")
        : "";
      const proposals = assistantMd ? extractProposedEdits(assistantMd) : [];
      if (proposals.length) {
        const pbox = h("div", "ai-proposals");
        pbox.append(h("span", "ai-touched-label", tr("Revisar cambios propuestos ({count}):", { count: proposals.length })));
        for (const edit of proposals) {
          const pkey = `${live.id}:${lastAssistant?.id ?? ""}:${edit.path}`;
          const st = proposalStatus.get(pkey);
          const label = st === "applied" ? `${baseName(edit.path)} ✓` : st === "discarded" ? `${baseName(edit.path)} ✕` : `Diff: ${baseName(edit.path)}`;
          const btn = h("button", `ai-prop-btn${st ? ` ${st}` : ""}`, label);
          btn.type = "button";
          btn.title = tr("{path} — Revisar diferencias antes de aplicar", { path: edit.path });
          btn.onclick = () => {
            if (isFull()) setFull(false);
            void reviewProposedEdit(
              edit,
              () => { proposalStatus.set(pkey, "applied"); renderBody(); },
              () => { proposalStatus.set(pkey, "discarded"); renderBody(); },
            );
          };
          pbox.append(btn);
        }
        tailNodes.push(pbox);
      }
      if (c.outcome?.ok) {
        const files = touchedFiles(c.messages);
        if (files.length) {
          const box = h("div", "ai-touched");
          box.append(h("span", "ai-touched-label", tr("Archivos modificados:")));
          for (const fp of files) {
            const resolved = resolveToolFile(fp);
            const btn = h("button", "ai-touched-file", baseName(fp));
            btn.type = "button";
            btn.title = fp;
            btn.onclick = () => {
              if (!resolved) return;
              if (isFull()) setFull(false);
              void openFile(resolved);
            };
            box.append(btn);
          }
          tailNodes.push(box);
        }
        if (c.outcome.denials) {
          const dKey = `${live.id}:${c.messages.length}`;
          if (!dismissedDenials.has(dKey)) {
            tailNodes.push(buildDenialCard(live, c.outcome.denials, c.outcome.deniedActions, dKey));
          }
        }
        const secs = c.outcome.durationMs ? ` · ${seconds(c.outcome.durationMs)} s` : "";
        const modelTag = c.model ? ` · ${formatModelName(c.model)}` : "";
        const o = h("div", "ai-outcome", tr("Listo") + secs + modelTag);
        if (c.touched) o.append(" · " + (c.touched === 1 ? tr("1 archivo modificado") : tr("{count} archivos modificados", { count: c.touched })));
        if (c.outcome.denials) o.append(" · " + (c.outcome.denials === 1 ? tr("1 acción no permitida") : tr("{count} acciones no permitidas", { count: c.outcome.denials })));
        tailNodes.push(o);
      }
    }
    // Preguntas del agente que esperan tu respuesta (siempre al final, donde se ve).
    for (const r of pendingFor(live.id)) tailNodes.push(buildPermissionCard(live.id, r, () => renderBody()));
    tailHost!.replaceChildren(...tailNodes);
  }
  if (atBottom || pendingFor(live.id).length) body.scrollTop = body.scrollHeight;
  const send = q<HTMLButtonElement>(".ai-send")!;
  send.innerHTML = c.running ? ICON_STOP : ICON_SEND;
  send.title = c.running ? tr("Parar") : tr("Enviar (Enter)");
  send.setAttribute("aria-label", send.title);
  send.classList.toggle("stop", c.running);
  renderChips();
}

function renderHistory(body: HTMLElement) {
  const saved = chatsFor(loadChats(), ws.root ?? "");
  const rows: { id: string; title: string; when: number; running: boolean }[] = [];
  for (const l of lives.values()) if (l.convo.messages.length && ws.root && sameDir(l.cwd, ws.root)) rows.push({ id: l.id, title: titleFrom(l.convo.messages), when: Date.now(), running: l.convo.running });
  for (const c of saved) if (!rows.some((r) => r.id === c.id)) rows.push({ id: c.id, title: c.title, when: c.updatedAt, running: false });
  rows.sort((a, b) => b.when - a.when);
  const nodes: HTMLElement[] = [h("div", "ai-hist-title", tr("Conversaciones de este proyecto"))];
  if (!rows.length) nodes.push(h("div", "ai-hist-empty", tr("Aún no hay conversaciones guardadas.")));
  for (const r of rows) {
    const row = h("div", `ai-hist-row${S.current?.id === r.id ? " current" : ""}`);
    const open = h("button", "ai-hist-open"); open.type = "button";
    open.append(h("span", "ai-hist-name", r.title), h("span", "ai-hist-when", r.running ? "respondiendo…" : agoFrom(r.when)));
    open.onclick = () => {
      const opened = lives.get(r.id) ?? (() => { const l = fromSaved(saved.find((c) => c.id === r.id)!); lives.set(l.id, l); return l; })();
      switchProvider(opened.provider);
      S.current = opened;
      S.historyOpen = false; renderBody();
    };
    const del = iconBtn('<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>', tr("Eliminar esta conversación"), "ai-hist-del");
    del.onclick = () => { deleteChat(r.id); if (lives.get(r.id)?.convo.running) { void invoke("ai_stop", { id: r.id }); } lives.delete(r.id); if (S.current?.id === r.id) S.current = null; pruneUnusedImages(); renderBody(); };
    row.append(open, del);
    nodes.push(row);
  }
  body.replaceChildren(...nodes);
}

// ---------- Acciones ----------
async function detect(force = false) {
  if (!force && S.tool && Date.now() - S.toolAt < 60_000) { if (S.shown) renderBody(); return; }
  if (S.detectInFlight) return S.detectInFlight;
  const wasLogged = !!tools[S.activeProvider]?.logged_in;
  if (!S.tool && S.shown) renderBody();
  S.detectInFlight = (async () => {
    try {
      const all = await invoke<AllAiTools>("ai_detect_all").catch(async () => {
        const claude = await invoke<AiTool>("ai_detect");
        return { claude, codex: null, antigravity: null } as unknown as { claude: AiTool; codex: AiTool | null; antigravity: AiTool | null };
      });
      const nextClaude = all.claude;
      const sig = `${nextClaude.auth_method}:${nextClaude.plan}`;
      const prevSig = readStorage(USAGE_SIG_KEY);
      if (!nextClaude.logged_in || prevSig !== sig) {
        S.usage = {};
        S.usageError = "";
        removeStorage(USAGE_KEY);
      }
      tools.claude = nextClaude;
      tools.codex = all.codex;
      tools.antigravity = all.antigravity;
      tools.local = ("local" in all ? all.local : null) ?? null;
      tools.cloud = ("cloud" in all ? all.cloud : null) ?? null;
      S.tool = tools[S.activeProvider];

      if (nextClaude.logged_in) {
        writeStorage(USAGE_SIG_KEY, sig);
        void refreshUsage();
      }
      if (all.codex?.logged_in || all.antigravity?.logged_in) {
        void refreshExtraUsage();
      }
      const curTool = tools[S.activeProvider];
      if (curTool?.logged_in && (S.awaitingLogin || (!wasLogged && S.shown))) {
        S.awaitingLogin = false;
        window.clearInterval(S.loginWatchTimer);
        if (S.activeProvider === "claude" && curTool.plan) {
          setStatus(tr("Claude Code conectado · Plan {plan}", { plan: planLabel(curTool.plan) }), 4000);
        } else if (S.activeProvider !== "claude") {
          setStatus(tr("{provider} conectado", { provider: PROVIDERS[S.activeProvider].title }), 4000);
        }
      }
    } catch (e) {
      const fail: AiTool = { installed: false, version: "", logged_in: false, auth_method: "", plan: "", error: String(e) };
      tools[S.activeProvider] = fail;
      S.tool = fail;
    } finally {
      S.toolAt = Date.now();
      S.detectInFlight = null;
      if (S.shown) renderBody();
    }
  })();
  return S.detectInFlight;
}

function autosize() {
  const t = q<HTMLTextAreaElement>(".ai-input");
  if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }
}

/** Mensajes anteriores en texto para el agente local (sin el último, que es el que se envía ahora). */
function localHistory(live: Live): { role: string; content: string }[] {
  return live.convo.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? splitAssistantTurn(m.blocks).final : m.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n"),
  })).filter((m) => m.content.trim()).slice(-30);
}

async function dispatchPrompt(live: Live, displayText: string, prompt: string, effectiveMode: AiMode, images: readonly UserImage[] = []) {
  if (!ws.root || live.convo.running) return;
  live.cwd = ws.root;
  live.stopping = false;
  if (!live.convo.messages.length) {
    live.provider = S.activeProvider;
    live.normalize = createProviderNormalizer(live.provider, S.model || "");
  }
  const useEffort = PROVIDERS[live.provider].supportsEffort && !(live.provider === "antigravity" && S.model)
    ? S.effort || null
    : null;
  apply(live, userEvent(displayText, images));
  try {
    // El agente local no guarda sesiones: recibe la conversación anterior (solo el texto) desde aquí.
    const sendModel = live.provider === "local" ? S.model || tools.local?.models?.[0]?.id || null
      : live.provider === "cloud" ? S.model || tools.cloud?.models?.[0]?.id || null
      : S.model || null;
    const history = live.provider === "local" || live.provider === "cloud" ? localHistory(live) : null;
    const imagePaths = images.length ? images.map((i) => i.path) : null;
    await invoke("ai_send", { id: live.id, cwd: ws.root, prompt, session: live.convo.sessionId || null, model: sendModel, effort: useEffort, mode: effectiveMode, provider: live.provider, history, images: imagePaths });
  } catch (e) {
    apply(live, exitEvent(1, String(e)));
  }
}

async function send() {
  const live = S.current;
  const input = q<HTMLTextAreaElement>(".ai-input");
  if (!live || !input || !ws.root) return;
  if (live.convo.running) { live.stopping = true; await invoke("ai_stop", { id: live.id }).catch(() => {}); return; }
  const text = input.value.trim();
  if (!text && !S.attachedImages.length) return;
  const imgs = [...S.attachedImages];
  const promptText = text || (imgs.length === 1 ? tr("Analiza la imagen adjunta.") : tr("Analiza las imágenes adjuntas."));
  const prompt = buildPrompt(promptText, editorContext());
  input.value = ""; autosize();
  S.attachedImages = [];
  S.extraNotes = [];
  renderChips();
  await dispatchPrompt(live, text, prompt, S.mode, imgs);
}

function newConversation() {
  dismissPopover();
  if (S.current && !S.current.convo.messages.length) { S.historyOpen = false; renderBody(); return; }
  S.current = newLive();
  S.extraFiles = [];
  S.extraNotes = [];
  S.attachedImages = [];
  S.historyOpen = false;
  renderBody();
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

function applyMode() {
  const v = viewEl();
  v.classList.toggle("ai-full", isFull());
  v.classList.toggle("ai-docked", !isFull());
  const expand = q<HTMLElement>(".ai-expand");
  if (expand) { expand.title = isFull() ? tr("Volver a la barra lateral (Esc)") : tr("Pantalla completa"); expand.setAttribute("aria-label", expand.title); expand.innerHTML = isFull() ? ICON_SHRINK : ICON_EXPAND; }
}

function setFull(full: boolean) {
  writeStorage(FULL_KEY, full ? "1" : "0");
  if (full) bus.emit("overlay", "ai");
  applyMode();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !S.closePopover && isFull() && !document.querySelector(".modal")) { e.preventDefault(); e.stopPropagation(); setFull(false); }
}

async function chooseMode(next: AiMode) {
  if (next === S.mode) return;
  if (next === "edit" && readStorage("pulso.ai.editOk") !== "1") {
    const msg = tr("Con «Puede editar», {provider} podrá modificar y crear archivos en tu proyecto sin preguntar cada vez. Verás los cambios en el panel de Git y podrás descartarlos. Si necesita ejecutar un comando de terminal, Pulso te pedirá permiso.", { provider: PROVIDERS[S.activeProvider].title });
    const r = await showDialog({
      title: tr("Permitir que la IA edite archivos"),
      message: msg,
      buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Permitir editar"), value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    writeStorage("pulso.ai.editOk", "1");
  } else if (next === "full" && readStorage("pulso.ai.fullOk") !== "1") {
    const msg = tr("Con «Agente», {provider} podrá modificar archivos Y ejecutar comandos de terminal (pruebas, búsquedas, diagnósticos, git, etc.) dentro de tu proyecto sin pedir confirmación en cada paso. Actívalo solo en proyectos en los que confíes.", { provider: PROVIDERS[S.activeProvider].title });
    const r = await showDialog({
      title: tr("Activar modo Agente completo"),
      message: msg,
      buttons: [{ label: tr("Cancelar"), value: "cancel" }, { label: tr("Activar modo Agente"), value: "ok", primary: true }],
    });
    if (r !== "ok") { build(); return; }
    writeStorage("pulso.ai.fullOk", "1");
  }
  S.mode = next;
  writeStorage("pulso.ai.mode", S.mode);
  build();
}

function openAppearancePopover(anchor: HTMLElement) {
  openPopover(anchor, buildAppearancePopover(viewEl()), "below");
}


// ---------- Construcción de la vista ----------
function build() {
  const root = viewEl();
  const keep = q<HTMLTextAreaElement>(".ai-input")?.value ?? "";
  const shell = h("div", "ai-shell");
  const head = h("div", "ai-head");
  const titles = h("div", "ai-titles");
  const titleRow = h("div", "ai-title-row");
  const planBtn = h("button", "ai-plan-pill", "");
  planBtn.type = "button";
  planBtn.title = tr("Ver y conectar suscripciones (Claude, ChatGPT, Antigravity)");
  planBtn.onclick = () => openAccountsPopover(planBtn);
  titleRow.append(h("span", "ai-live-dot", ""), h("span", "ai-title", tr("Asistente")), planBtn);
  titles.append(titleRow, h("span", "ai-sub", ""));
  const tools = h("div", "ai-tools");
  const add = iconBtn(ICON_PLUS, tr("Nueva conversación")); add.onclick = newConversation;
  const hist = iconBtn(ICON_CLOCK, tr("Conversaciones anteriores")); hist.onclick = () => { S.historyOpen = !S.historyOpen; renderBody(); };
  const themeBtn = iconBtn(ICON_PALETTE, tr("Cambiar color de fondo")); themeBtn.onclick = () => openAppearancePopover(themeBtn);
  const expand = iconBtn(ICON_EXPAND, tr("Pantalla completa"), "ai-expand"); expand.onclick = () => setFull(!isFull());
  tools.append(add, hist, themeBtn, expand);
  head.append(titles, h("span", "grow"), tools);

  const body = h("div", "ai-body");
  body.tabIndex = 0;
  body.setAttribute("role", "log");
  body.setAttribute("aria-label", tr("Conversación con la IA"));

  const compose = h("form", "ai-compose");
  const mentionBox = h("div", "ai-mention");
  mentionBox.hidden = true;
  mentionBox.setAttribute("role", "listbox");
  mentionBox.setAttribute("aria-label", tr("Mencionar archivo del proyecto"));
  const dock = h("div", "ai-dock");
  const dockCtx = h("div", "ai-dock-ctx"); dockCtx.hidden = true;
  const chips = h("div", "ai-chips"); chips.hidden = true;
  dockCtx.append(h("span", "ai-dock-ctx-lbl", tr("Contexto")), chips);

  const inputWrap = h("div", "ai-input-wrap");
  const input = h("textarea", "ai-input");
  input.rows = 1; input.placeholder = tr("Describe el cambio, duda o archivo a inspeccionar…"); input.setAttribute("aria-label", tr("Mensaje para la IA")); input.value = keep;
  inputWrap.append(h("span", "ai-input-caret", "›"), input);

  const dockBar = h("div", "ai-dock-bar");
  const leftBar = h("div", "ai-dock-left");
  const attachBtn = iconBtn(ICON_PLUS, tr("Adjuntar archivo del proyecto"), "ai-compose-act");
  attachBtn.onclick = attachProjectFile;
  const imgInput = document.createElement("input");
  imgInput.type = "file";
  imgInput.accept = "image/png,image/jpeg,image/webp,image/gif";
  imgInput.multiple = true;
  imgInput.hidden = true;
  imgInput.onchange = () => {
    if (imgInput.files?.length) void addImageFiles(Array.from(imgInput.files));
    imgInput.value = "";
  };
  const imgBtn = iconBtn(ICON_IMAGE, tr("Adjuntar imagen (o pega con Ctrl+V)"), "ai-compose-act");
  imgBtn.onclick = () => imgInput.click();
  const quickBtn = iconBtn('<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>', tr("Acciones rápidas"), "ai-compose-act");
  quickBtn.onclick = () => openQuickPromptsPopover(quickBtn);

  const modelBtn = h("button", "ai-model-btn");
  modelBtn.type = "button";
  modelBtn.title = tr("Cambiar modelo y esfuerzo");
  modelBtn.setAttribute("aria-label", tr("Modelo"));
  modelBtn.append(h("span", "ai-model-btn-label", modelButtonText()), h("span", "ai-model-btn-chev", "⌄"));
  modelBtn.onclick = () => openModelPopover(modelBtn);

  const seg = h("div", "seg ai-mode");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", tr("Permisos"));
  const modeOptions: readonly [AiMode, string, string][] = [
    ["read", tr("Solo leer"), tr("La IA puede leer y buscar en tu proyecto, pero no modificarlo")],
    ["edit", tr("Puede editar"), tr("La IA puede editar archivos directamente. Si intenta ejecutar comandos, Pulso te pedirá permiso")],
    ["full", tr("Agente"), tr("La IA puede editar archivos y ejecutar comandos de terminal en tu proyecto para completar tareas")],
  ];
  for (const [value, label, hint] of modeOptions) {
    const b = h("button", "", label); b.type = "button"; b.title = hint; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(S.mode === value));
    b.onclick = () => void chooseMode(value);
    seg.append(b);
  }
  leftBar.append(attachBtn, imgBtn, imgInput, quickBtn, modelBtn, seg);

  const rightBar = h("div", "ai-dock-right");
  const sendBtn = h("button", "ai-send"); sendBtn.type = "submit"; sendBtn.innerHTML = ICON_SEND; sendBtn.title = tr("Enviar (Enter)"); sendBtn.setAttribute("aria-label", tr("Enviar"));
  rightBar.append(h("span", "ai-send-hint", "Enter ↵"), sendBtn);
  dockBar.append(leftBar, rightBar);
  dock.append(dockCtx, inputWrap, dockBar);
  compose.append(mentionBox, dock);

  let mentionItems: string[] = [];
  let mentionIdx = 0;
  let mentionStart = -1;
  let mentionQuery = "";
  const closeMention = () => { mentionBox.hidden = true; mentionItems = []; mentionStart = -1; };
  const pickMention = (file: string) => {
    if (mentionStart < 0) return;
    const end = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(end);
    const inserted = `@${file} `;
    input.value = `${before}${inserted}${after}`;
    input.selectionStart = input.selectionEnd = before.length + inserted.length;
    if (!S.extraFiles.includes(file)) S.extraFiles.push(file);
    closeMention();
    renderChips();
    autosize();
    input.focus();
  };
  const paintMention = () => {
    if (!mentionItems.length) { closeMention(); return; }
    mentionBox.replaceChildren(...mentionItems.map((file, i) => {
      const row = h("button", `ai-mention-item${i === mentionIdx ? " active" : ""}`);
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === mentionIdx));
      row.append(h("span", "ai-mention-name", baseName(file)));
      const dir = dirName(file);
      if (dir) row.append(h("span", "ai-mention-dir", dir));
      row.onmousedown = (e) => { e.preventDefault(); pickMention(file); };
      return row;
    }));
    mentionBox.hidden = false;
  };
  const updateMention = async () => {
    if (!ws.root) { closeMention(); return; }
    const hit = fileMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (!hit) { closeMention(); return; }
    mentionStart = hit.start;
    mentionQuery = hit.query;
    const root = ws.root;
    if (!S.mentionFiles || S.mentionFiles.root !== root) {
      try {
        const raw = await invoke<string[]>("list_files", { path: root });
        S.mentionFiles = { root, list: raw.map((p) => rel(p)).sort((a, b) => a.localeCompare(b)) };
      } catch {
        closeMention();
        return;
      }
    }
    if (ws.root !== root || mentionStart < 0) return;
    const again = fileMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (!again || again.query !== mentionQuery) return;
    mentionItems = filterProjectFiles(S.mentionFiles.list, again.query, 8);
    mentionIdx = 0;
    paintMention();
  };

  compose.onsubmit = (e) => { e.preventDefault(); closeMention(); void send(); };
  input.oninput = () => { autosize(); void updateMention(); };
  input.onblur = () => { window.setTimeout(closeMention, 120); };
  input.onkeydown = (e) => {
    if (!mentionBox.hidden && mentionItems.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = (mentionIdx + 1) % mentionItems.length; paintMention(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = (mentionIdx - 1 + mentionItems.length) % mentionItems.length; paintMention(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); pickMention(mentionItems[mentionIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  };
  input.onpaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void addImageFiles(files);
    }
  };
  dock.ondragover = (e) => {
    if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file" && it.type.startsWith("image/"))) {
      e.preventDefault();
      dock.classList.add("drag-over");
    }
  };
  dock.ondragleave = (e) => {
    if (!dock.contains(e.relatedTarget as Node | null)) dock.classList.remove("drag-over");
  };
  dock.ondrop = (e) => {
    dock.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addImageFiles(files);
    }
  };
  const issueBanner = h("div", "ai-issue-banner");
  issueBanner.hidden = true;
  const foot = h("div", "ai-foot");
  shell.append(head, issueBanner, body, compose, foot);
  root.replaceChildren(shell);
  applyMode();
  renderBody();
  autosize();
}

/** Lo que los demás módulos del panel (`src/ai/`) necesitan llamar de este controlador: se registra aquí para que no tengan que importarlo. */
const controller = { autosize, build, detect, dispatchPrompt, renderBody, setFull, switchProvider };
export type Controller = typeof controller;
Object.assign(ctl, controller);

/** Lo llama el selector de vistas de la barra lateral. */
export function setAiVisible(visible: boolean) {
  S.shown = visible;
  window.removeEventListener("keydown", onKey, true);
  if (!visible) { dismissPopover(); return; }
  window.addEventListener("keydown", onKey, true);
  if (isFull()) bus.emit("overlay", "ai");
  if (!q(".ai-shell")) build(); else { applyMode(); renderBody(); }
  void detect(!S.tool?.logged_in);
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

export function initAi() {
  applyAiAppearance(viewEl());
  if (!("__TAURI_INTERNALS__" in window)) return;
  // El historial vive en un archivo: se carga una vez, recupera si cerró ejecutando y repinta si corresponde.
  void initHistory().then(() => {
    try {
      const raw = readStorage(INTERRUPTED_KEY);
      if (raw) {
        removeStorage(INTERRUPTED_KEY);
        const info = JSON.parse(raw) as { id?: string; cwd?: string };
        const saved = info.id ? loadChats().find((c) => c.id === info.id) : undefined;
        if (saved && (!ws.root || sameDir(saved.cwd, ws.root))) {
          const l = fromSaved(saved);
          lives.set(l.id, l);
          switchProvider(l.provider);
          S.current = l;
        }
      }
    } catch { /* nada que hacer */ }
    pruneUnusedImages();
    if (S.shown) renderBody();
  });
  window.addEventListener("beforeunload", saveRunningBeforeExit);
  window.addEventListener("pagehide", saveRunningBeforeExit);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveRunningBeforeExit(); });
  // Reconoce Claude Code y su plan al instante al iniciar la aplicación.
  void detect(true);
  window.addEventListener("focus", () => {
    if (S.awaitingLogin) void detectProviderNow(S.loginProvider);
    else if (S.shown && !S.tool?.logged_in) void detect(true);
  });
  void listen<{ id: string; line: string }>("ai-line", (e) => {
    const live = lives.get(e.payload.id);
    if (!live) return;
    try {
      const raw = JSON.parse(e.payload.line) as AiEvent;
      // El agente propio se detiene a pedir permiso (comandos, páginas web): se muestra una tarjeta y se espera la respuesta.
      const perm = parsePermissionEvent(raw);
      if (perm) {
        if (perm.kind === "ask") {
          addRequest(live.id, perm.req);
          setStatus(tr("El agente espera tu aprobación"), 8000);
        } else {
          resolveRequest(live.id, perm.id);
        }
        if (live === S.current) renderBody();
        return;
      }
      for (const ev of live.normalize(raw)) apply(live, ev);
    } catch { /* línea que no es JSON: se ignora */ }
  });
  void listen<{ id: string; code: number | null; stderr: string }>("ai-exit", (e) => {
    const live = lives.get(e.payload.id);
    if (live) clearConversation(live.id);
    if (live) apply(live, exitEvent(live.stopping ? null : e.payload.code, e.payload.stderr));
  });
  // El contexto adjunto sigue al editor: archivo y selección actuales, liberando listeners al cerrar el editor.
  const attach = (ed: monaco.editor.ICodeEditor) => {
    const d1 = ed.onDidChangeCursorSelection(() => { if (S.shown && ed === focusedEditor()) { S.useSel = true; renderChips(); } });
    const d2 = ed.onDidFocusEditorText(() => { const p = activePath() ?? ""; if (p !== S.lastFile) { S.lastFile = p; S.useFile = true; } if (S.shown) renderChips(); });
    ed.onDidDispose(() => { d1.dispose(); d2.dispose(); });
  };
  monaco.editor.getEditors().forEach(attach);
  monaco.editor.onDidCreateEditor(attach);
  bus.on("overlay", (kind) => { if (kind === "board" && isFull()) setFull(false); });
  bus.on("issue-workflow-start", ({ body: prompt }) => {
    S.historyOpen = false;
    newConversation();
    renderIssueBanner();
    const inp = q<HTMLTextAreaElement>(".ai-input");
    if (inp) {
      inp.value = prompt;
      autosize();
      inp.focus();
    }
  });
}

/** ¿Hay alguna conversación de IA respondiendo actualmente en la carpeta indicada? */
export function hasRunningAiForWorkspace(root: string | null): boolean {
  if (!root) return false;
  for (const l of lives.values()) {
    if (l.convo.running && sameDir(l.cwd, root)) return true;
  }
  return false;
}

/** Detiene todas las conversaciones de IA en curso de la carpeta indicada. */
export async function stopRunningAiForWorkspace(root: string | null): Promise<void> {
  if (!root) return;
  const targets: Live[] = [];
  for (const l of lives.values()) {
    if (l.convo.running && sameDir(l.cwd, root)) targets.push(l);
  }
  for (const l of targets) {
    l.stopping = true;
    await invoke("ai_stop", { id: l.id }).catch(() => {});
  }
}

/** Al cambiar o cerrar carpeta se descarta la conversación activa del proyecto anterior y se actualiza la vista para el nuevo. */
export function resetAi() {
  dismissPopover();
  S.extraFiles = [];
  S.extraNotes = [];
  S.attachedImages = [];
  S.mentionFiles = null;
  S.lastFile = "";
  S.useFile = true;
  S.useSel = true;
  S.historyOpen = false;
  const keepCurrent = !!(ws.root && S.current && S.current.convo.messages.length && sameDir(S.current.cwd, ws.root));
  if (!keepCurrent && S.current) {
    if (S.current.convo.messages.length) persist(S.current, true);
    else lives.delete(S.current.id);
    S.current = null;
    resetTurnCache();
  }
  const input = q<HTMLTextAreaElement>(".ai-input");
  if (input) {
    input.value = "";
    autosize();
  }
  if (S.shown) renderBody();
}

/** «IA: Nueva conversación» desde la paleta. */
export const startNewConversation = () => { S.historyOpen = false; newConversation(); };
