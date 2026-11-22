import type { AiProvider } from "../aiModel";

export interface AiModelInfo { id: string; label: string; note: string }
export interface AiTool {
  installed: boolean;
  version: string;
  logged_in: boolean;
  auth_method: string;
  plan: string;
  error: string;
  models?: AiModelInfo[];
}
export interface WindowQuota { used_percent: number; resets_at: number }
export interface CodexQuota { plan: string; five_hour?: WindowQuota; seven_day?: WindowQuota }
export interface AntigravityBucket { id: string; name: string; window: string; remaining_fraction: number; reset_time: string }
export interface AntigravityQuotaGroup { name: string; description: string; buckets: AntigravityBucket[] }
export interface AntigravityUsage { groups: AntigravityQuotaGroup[] }
export interface ExtraUsage { codex?: CodexQuota; antigravity?: AntigravityUsage }
export interface AllAiTools { claude: AiTool; codex: AiTool; antigravity: AiTool }

export interface ModelOption {
  value: string;
  label: string;
  tier: string;
  badge?: string;
  hint: string;
}

export interface ProviderMeta {
  id: AiProvider;
  short: string;
  title: string;
  accountTitle: string;
  npmPkg?: string;
  installCmdPs?: string;
  installCmdSh?: string;
  loginCmd: string;
  loginBtn: string;
  installHint: string;
  docsUrl: string;
  modelKey: string;
  supportsEffort: boolean;
  models: ModelOption[];
  specific: ModelOption[];
}

export const MODELS: ModelOption[] = [
  { value: "", label: "Predeterminado", tier: "Cuenta", badge: "Auto", hint: "Modelo configurado por defecto en tu sesión de Claude Code" },
  { value: "fable", label: "Claude Fable 5.2", tier: "Máxima capacidad", badge: "Nuevo", hint: "Alias «fable»: el Fable más reciente. Si tu plan no lo incluye, Claude Code lo avisará" },
  { value: "opus", label: "Claude Opus 5.5", tier: "Profundo", badge: "Nuevo", hint: "Alias «opus» para análisis complejo y arquitectura" },
  { value: "sonnet", label: "Claude Sonnet 5.5", tier: "Equilibrado", badge: "Nuevo", hint: "Alias «sonnet» (último Sonnet disponible en tu plan)" },
  { value: "haiku", label: "Claude Haiku 5.5", tier: "Rápido", badge: "Ligero", hint: "Alias «haiku» para respuestas inmediatas" },
];

export const SPECIFIC_MODELS: ModelOption[] = [
  { value: "claude-fable-5-2", label: "Claude Fable 5.2", tier: "claude-fable-5-2", badge: "Fijo", hint: "Fijar versión Fable 5.2" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "claude-opus-5-5", badge: "Fijo", hint: "Fijar versión Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "claude-sonnet-5-5", badge: "Fijo", hint: "Fijar versión Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "claude-haiku-5-5", badge: "Fijo", hint: "Fijar versión Haiku 5.5" },
];

export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  claude: {
    id: "claude",
    short: "Claude",
    title: "Claude Code",
    accountTitle: "Claude (Anthropic)",
    loginCmd: "claude auth login",
    loginBtn: "Iniciar sesión con Claude Code",
    installHint: "Instálalo, inicia sesión con tu cuenta y pulsa «Volver a comprobar». El asistente usa tu suscripción; Pulso no guarda ninguna clave.",
    docsUrl: "https://claude.com/claude-code",
    modelKey: "pulso.ai.model",
    supportsEffort: true,
    models: MODELS,
    specific: SPECIFIC_MODELS,
  },
  codex: {
    id: "codex",
    short: "Codex",
    title: "ChatGPT / Codex",
    accountTitle: "ChatGPT / Codex (OpenAI)",
    npmPkg: "@openai/codex",
    loginCmd: "codex login",
    loginBtn: "Iniciar sesión con ChatGPT",
    installHint: "Instala la app de Codex o `@openai/codex` (`npm i -g @openai/codex`), inicia sesión con tu cuenta de ChatGPT y pulsa «Volver a comprobar».",
    docsUrl: "https://chatgpt.com/codex",
    modelKey: "pulso.ai.model.codex",
    supportsEffort: true,
    models: [
      { value: "", label: "Predeterminado", tier: "Cuenta", badge: "Auto", hint: "Modelo configurado en tu cuenta de ChatGPT / Codex" },
    ],
    specific: [],
  },
  antigravity: {
    id: "antigravity",
    short: "Antigravity",
    title: "Antigravity (agy)",
    accountTitle: "Antigravity (Google)",
    installCmdPs: "irm https://antigravity.google/cli/install.ps1 | iex",
    installCmdSh: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    loginCmd: "agy acp --login",
    loginBtn: "Iniciar sesión con Google (Antigravity)",
    installHint: "Instala Antigravity CLI (`agy`) con el instalador oficial de Google, inicia sesión con tu cuenta y pulsa «Volver a comprobar».",
    docsUrl: "https://antigravity.google",
    modelKey: "pulso.ai.model.antigravity",
    supportsEffort: true,
    models: [
      { value: "", label: "Predeterminado", tier: "Cuenta", badge: "Auto", hint: "Antigravity selecciona automáticamente el mejor modelo" },
    ],
    specific: [],
  },
};

export const EFFORTS: { value: string; label: string; short: string }[] = [
  { value: "", label: "Auto", short: "" },
  { value: "low", label: "Bajo", short: "Bajo" },
  { value: "medium", label: "Medio", short: "Medio" },
  { value: "high", label: "Alto", short: "Alto" },
  { value: "max", label: "Máx", short: "Máx" },
];

export const QUICK_PROMPTS: { label: string; tag: string; prompt: string }[] = [
  { label: "Explicar este código", tag: "Lectura", prompt: "Explica paso a paso qué hace este código y sus dependencias principales." },
  { label: "Buscar posibles errores", tag: "Revisión", prompt: "Revisa este código en busca de errores, condiciones de carrera o casos borde sin cubrir." },
  { label: "Escribir pruebas unitarias", tag: "Tests", prompt: "Propón e implementa pruebas unitarias claras cubriendo casos normales y límites." },
  { label: "Refactorizar para claridad", tag: "Mejora", prompt: "Refactoriza este fragmento para hacerlo más legible y modular sin cambiar su comportamiento." },
  { label: "Documentar funciones", tag: "Docs", prompt: "Añade comentarios JSDoc/TSDoc concisos explicando parámetros, retorno y propósito." },
];

export const EXAMPLES: { code: string; label: string; tag: string; prompt: string }[] = [
  { code: "01", label: "Explica qué hace este archivo", tag: "Lectura", prompt: "Explica qué hace este archivo" },
  { code: "02", label: "Busca posibles errores en lo que tengo abierto", tag: "Revisión", prompt: "Busca posibles errores en lo que tengo abierto" },
  { code: "03", label: "Propón pruebas para la selección", tag: "Tests", prompt: "Propón pruebas para la selección" },
  { code: "04", label: "Simplifica y refactoriza este bloque", tag: "Refactor", prompt: "Simplifica este código para hacerlo más claro y mantenible sin cambiar su comportamiento." },
];
