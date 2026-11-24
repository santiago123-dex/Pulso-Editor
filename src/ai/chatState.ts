/**
 * Estado compartido del asistente de IA: la conversación en curso, el proveedor y el modelo elegidos, el uso del plan, lo que se adjunta…
 * Vive aquí (y no suelto en `aiChat.ts`) para que cada parte del panel —popovers, cuotas, adjuntos, pintado— pueda estar en su propio
 * archivo y leer o cambiar lo mismo. Es un único objeto mutable (`S`) porque los módulos de ES no dejan asignar variables importadas.
 */
import { lang } from "../i18n";
import { readStorage, removeStorage } from "../core/storage";
import { $ } from "../util";
import { PROVIDERS, type AiTool, type AntigravityUsage } from "./catalog";
import type { ContextNote } from "../aiContext";
import { pruneUsage, type AiEvent, type AiProvider, type Conversation, type UserImage } from "../aiModel";

/** Una conversación del panel (la que se ve o una que sigue en marcha en segundo plano). */
export interface Live {
  id: string;
  provider: AiProvider;
  normalize: (ev: AiEvent) => AiEvent[];
  convo: Conversation;
  cwd: string;
  title: string;
  stopping?: boolean;
}

export type AiMode = "read" | "edit" | "full";

// v2: la clave anterior pudo quedar con cifras de pruebas; se ignora y se borra al arrancar.
export const USAGE_KEY = "pulso.ai.usage.v2";
export const USAGE_SIG_KEY = "pulso.ai.usageSig";
export const FULL_KEY = "pulso.aiFull";

export function readStoredUsage(): Conversation["usage"] {
  try {
    removeStorage("pulso.ai.usage");
    const raw = JSON.parse(readStorage(USAGE_KEY) ?? "{}");
    return pruneUsage(raw);
  } catch {
    return {};
  }
}

export function savedProvider(): AiProvider {
  const p = readStorage("pulso.ai.provider");
  if (p === "codex") return "codex";
  if (p === "antigravity" || p === "gemini") return "antigravity";
  if (p === "local") return "local";
  if (p === "cloud") return "cloud";
  return "claude";
}

export function savedMode(): AiMode {
  const m = readStorage("pulso.ai.mode");
  if (m === "full" || m === "edit") return m;
  return "read";
}

/** Las conversaciones abiertas, por identificador. */
export const lives = new Map<string, Live>();
/** Lo que se sabe de cada herramienta (instalada, con sesión, modelos…). */
export const tools: Record<AiProvider, AiTool | null> = { claude: null, codex: null, antigravity: null, local: null, cloud: null };

export interface ChatState {
  activeProvider: AiProvider;
  current: Live | null;
  /** La herramienta del proveedor activo. */
  tool: AiTool | null;
  toolAt: number;
  detectInFlight: Promise<void> | null;
  usageInFlight: Promise<boolean> | null;
  usageSyncing: boolean;
  usageError: string;
  shown: boolean;
  historyOpen: boolean;
  model: string;
  effort: string;
  mode: AiMode;
  useFile: boolean;
  useSel: boolean;
  extraFiles: string[];
  extraNotes: ContextNote[];
  attachedImages: UserImage[];
  mentionFiles: { root: string; list: string[] } | null;
  lastFile: string;
  usage: Conversation["usage"];
  closePopover: (() => void) | null;
  loginWatchTimer: number;
  awaitingLogin: boolean;
  loginProvider: AiProvider;
  codexUsage: Conversation["usage"];
  agyUsage: AntigravityUsage | null;
  extraUsageInFlight: Promise<boolean> | null;
}

const initialProvider = savedProvider();

export const S: ChatState = {
  activeProvider: initialProvider,
  current: null,
  tool: null,
  toolAt: 0,
  detectInFlight: null,
  usageInFlight: null,
  usageSyncing: false,
  usageError: "",
  shown: false,
  historyOpen: false,
  model: readStorage(PROVIDERS[initialProvider].modelKey) ?? "",
  effort: readStorage("pulso.ai.effort") ?? "",
  mode: savedMode(),
  useFile: true,
  useSel: true,
  extraFiles: [],
  extraNotes: [],
  attachedImages: [],
  mentionFiles: null,
  lastFile: "",
  usage: readStoredUsage(),
  closePopover: null,
  loginWatchTimer: 0,
  awaitingLogin: false,
  loginProvider: initialProvider,
  codexUsage: {},
  agyUsage: null,
  extraUsageInFlight: null,
};

/** Funciones del controlador (`aiChat.ts`) que otros módulos del panel necesitan llamar; el controlador las registra al cargarse. */
export const ctl = {} as import("../aiChat").Controller;

export const isFull = () => readStorage(FULL_KEY) === "1";
/** Segundos con un decimal, con la coma o el punto que use el idioma elegido: «3,2» o «3.2». */
export const seconds = (ms: number) => (ms / 1000).toLocaleString(lang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const viewEl = () => $("view-ai");
export const q = <T extends HTMLElement>(sel: string) => viewEl().querySelector<T>(sel);
