// Traducción de la interfaz. El texto en español es la clave: lo que aún no tiene traducción se
// sigue viendo en español, así la interfaz se puede traducir por partes. Las traducciones al inglés
// están en src/locales/en.ts; i18n.test.ts comprueba que cada t("…") del código tenga la suya.
//
// El idioma se decide al cargar el módulo, antes de que el resto de módulos construya sus textos
// (menús, comandos), así que cambiarlo requiere recargar la ventana.
import { en } from "./locales/en";

export type Lang = "es" | "en";
export type LangSetting = "auto" | Lang;

/** "auto" sigue al sistema: español si la primera preferencia es español, si no inglés. */
export function resolveLang(setting: unknown, preferred: readonly string[]): Lang {
  if (setting === "es" || setting === "en") return setting;
  const first = (preferred[0] ?? "es").toLowerCase();
  return first.startsWith("es") ? "es" : "en";
}

function savedSetting(): unknown {
  try {
    return JSON.parse(globalThis.localStorage?.getItem("pulso.settings") ?? "{}")?.language;
  } catch {
    return undefined;
  }
}

let current: Lang = resolveLang(savedSetting(), globalThis.navigator?.languages ?? []);

export const lang = (): Lang => current;
/** Solo para pruebas. */
export function setLangForTests(l: Lang) {
  current = l;
}

/** Rellena «{nombre}» con los valores dados. */
export function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

/** Traduce un texto de la interfaz. Los valores variables van como «{nombre}» en el texto y en `params`. */
export function t(text: string, params?: Record<string, string | number>): string {
  return fill(current === "en" ? (en[text] ?? text) : text, params);
}

const ATTRS = ["title", "placeholder", "aria-label"] as const;

/** Traduce el HTML estático (index.html): textos y los atributos title, placeholder y aria-label. */
export function translateStatic(root: Element) {
  document.documentElement.lang = current;
  if (current === "es") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const raw = node.textContent ?? "";
    const key = raw.trim();
    if (key && en[key]) node.textContent = raw.replace(key, en[key]);
  }
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && en[v]) el.setAttribute(a, en[v]);
    }
  }
}
