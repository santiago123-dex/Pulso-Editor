import { t } from "../i18n";
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
export interface AllAiTools { claude: AiTool; codex: AiTool; antigravity: AiTool; local?: AiTool }

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
  { value: "", label: t("Predeterminado"), tier: t("Cuenta"), badge: "Auto", hint: t("Modelo configurado por defecto en tu sesión de Claude Code") },
  { value: "fable", label: "Claude Fable 5.2", tier: t("Máxima capacidad"), badge: t("Nuevo"), hint: t("Alias «fable»: el Fable más reciente. Si tu plan no lo incluye, Claude Code lo avisará") },
  { value: "opus", label: "Claude Opus 5.5", tier: t("Profundo"), badge: t("Nuevo"), hint: t("Alias «opus» para análisis complejo y arquitectura") },
  { value: "sonnet", label: "Claude Sonnet 5.5", tier: t("Equilibrado"), badge: t("Nuevo"), hint: t("Alias «sonnet» (último Sonnet disponible en tu plan)") },
  { value: "haiku", label: "Claude Haiku 5.5", tier: t("Rápido"), badge: t("Ligero"), hint: t("Alias «haiku» para respuestas inmediatas") },
];

export const SPECIFIC_MODELS: ModelOption[] = [
  { value: "claude-fable-5-2", label: "Claude Fable 5.2", tier: "claude-fable-5-2", badge: t("Fijo"), hint: t("Fijar versión Fable 5.2") },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "claude-opus-5-5", badge: t("Fijo"), hint: t("Fijar versión Opus 5.5") },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "claude-sonnet-5-5", badge: t("Fijo"), hint: t("Fijar versión Sonnet 5.5") },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "claude-haiku-5-5", badge: t("Fijo"), hint: t("Fijar versión Haiku 5.5") },
];

export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  claude: {
    id: "claude",
    short: "Claude",
    title: "Claude Code",
    accountTitle: "Claude (Anthropic)",
    loginCmd: "claude auth login",
    loginBtn: t("Iniciar sesión con Claude Code"),
    installHint: t("Instálalo, inicia sesión con tu cuenta y pulsa «Volver a comprobar». El asistente usa tu suscripción; Pulso no guarda ninguna clave."),
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
    loginBtn: t("Iniciar sesión con ChatGPT"),
    installHint: t("Instala la app de Codex o `@openai/codex` (`npm i -g @openai/codex`), inicia sesión con tu cuenta de ChatGPT y pulsa «Volver a comprobar»."),
    docsUrl: "https://chatgpt.com/codex",
    modelKey: "pulso.ai.model.codex",
    supportsEffort: true,
    models: [
      { value: "", label: t("Predeterminado"), tier: t("Cuenta"), badge: "Auto", hint: t("Modelo configurado en tu cuenta de ChatGPT / Codex") },
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
    loginBtn: t("Iniciar sesión con Google (Antigravity)"),
    installHint: t("Instala Antigravity CLI (`agy`) con el instalador oficial de Google, inicia sesión con tu cuenta y pulsa «Volver a comprobar»."),
    docsUrl: "https://antigravity.google",
    modelKey: "pulso.ai.model.antigravity",
    supportsEffort: true,
    models: [
      { value: "", label: t("Predeterminado"), tier: t("Cuenta"), badge: "Auto", hint: t("Antigravity selecciona automáticamente el mejor modelo") },
    ],
    specific: [],
  },
  local: {
    id: "local",
    short: "Local",
    title: "Ollama (local)",
    accountTitle: "Ollama",
    installCmdPs: "winget install --id Ollama.Ollama -e",
    installCmdSh: "curl -fsSL https://ollama.com/install.sh | sh",
    loginCmd: "ollama pull qwen2.5-coder:7b",
    loginBtn: t("Descargar un modelo"),
    installHint: t("Instala Ollama, descarga un modelo (por ejemplo «ollama pull qwen2.5-coder:7b») y pulsa «Volver a comprobar». Todo se ejecuta en este equipo: sin cuenta, sin claves y sin enviar tu código a ningún servicio."),
    docsUrl: "https://ollama.com/download",
    modelKey: "pulso.ai.model.local",
    supportsEffort: false,
    // Los modelos salen de la instalación de Ollama (`ollama list`).
    models: [],
    specific: [],
  },
};

export const EFFORTS: { value: string; label: string; short: string }[] = [
  { value: "", label: "Auto", short: "" },
  { value: "low", label: t("Bajo"), short: t("Bajo") },
  { value: "medium", label: t("Medio"), short: t("Medio") },
  { value: "high", label: t("Alto"), short: t("Alto") },
  { value: "max", label: t("Máx"), short: t("Máx") },
];

export const QUICK_PROMPTS: { label: string; tag: string; prompt: string }[] = [
  { label: t("Explicar este código"), tag: t("Lectura"), prompt: t("Explica paso a paso qué hace este código y sus dependencias principales.") },
  { label: t("Buscar posibles errores"), tag: t("Revisión"), prompt: t("Revisa este código en busca de errores, condiciones de carrera o casos borde sin cubrir.") },
  { label: t("Escribir pruebas unitarias"), tag: t("Tests"), prompt: t("Propón e implementa pruebas unitarias claras cubriendo casos normales y límites.") },
  { label: t("Refactorizar para claridad"), tag: t("Mejora"), prompt: t("Refactoriza este fragmento para hacerlo más legible y modular sin cambiar su comportamiento.") },
  { label: t("Documentar funciones"), tag: t("Docs"), prompt: t("Añade comentarios JSDoc/TSDoc concisos explicando parámetros, retorno y propósito.") },
];

export const EXAMPLES: { code: string; label: string; tag: string; prompt: string }[] = [
  { code: "01", label: t("Explica qué hace este archivo"), tag: t("Lectura"), prompt: t("Explica qué hace este archivo") },
  { code: "02", label: t("Busca posibles errores en lo que tengo abierto"), tag: t("Revisión"), prompt: t("Busca posibles errores en lo que tengo abierto") },
  { code: "03", label: t("Propón pruebas para la selección"), tag: t("Tests"), prompt: t("Propón pruebas para la selección") },
  { code: "04", label: t("Simplifica y refactoriza este bloque"), tag: t("Refactor"), prompt: t("Simplifica este código para hacerlo más claro y mantenible sin cambiar su comportamiento.") },
];
