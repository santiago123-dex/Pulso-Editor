export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const sel = (id: string) => $<HTMLSelectElement>(id);
export const inp = (id: string) => $<HTMLInputElement>(id);

/** Usa siempre barras `/` para que una misma ruta no aparezca en dos formatos. */
export const norm = (p: string) => p.replace(/\\/g, "/");
/** Identidad de archivo para comparar rutas de Windows sin alterar la ruta mostrada. */
export const fileKey = (p: string) => {
  const path = norm(p);
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
};
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirName = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
};

/** Crea un elemento con clase y texto opcionales. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Nerd Fonts habituales: traen los iconos que usan prompts como oh-my-posh o Starship. */
const NERD_FONTS = [
  "CaskaydiaCove Nerd Font", "CaskaydiaCove NF", "CaskaydiaMono Nerd Font", "MesloLGS NF", "MesloLGM Nerd Font",
  "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", "Symbols Nerd Font Mono",
];

/**
 * Familia tipográfica de la terminal, de más a menos prioritaria: la que el usuario escribió, las que
 * ya usa en VS Code / Windows Terminal, las Nerd Fonts instaladas, las habituales y la del editor.
 * El navegador usa, carácter a carácter, la primera instalada que tenga el símbolo.
 */
export function terminalFontStack(custom: string, editorFont: string, preferred: string[] = [], installedNerd: string[] = []): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (stack: string) => {
    for (const raw of stack.split(",")) {
      const name = raw.trim();
      const key = name.replace(/^["']|["']$/g, "").toLowerCase();
      if (name && !seen.has(key)) { seen.add(key); out.push(name); }
    }
  };
  if (custom.trim()) add(custom);
  preferred.forEach((p) => { if (p.trim()) add(p); });
  installedNerd.forEach((f) => add(`"${f}"`));
  if (!custom.trim()) NERD_FONTS.forEach((f) => add(`"${f}"`));
  add(editorFont);
  return out.join(", ");
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
