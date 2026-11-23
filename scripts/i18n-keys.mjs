// Claves de traducción en uso: los t("…") del código de src/ y los textos fijos de index.html.
// La usan src/i18n.test.ts (que cada clave tenga traducción) y, con --missing, quien traduce:
//   node scripts/i18n-keys.mjs --missing   → lista lo que falta en src/locales/en.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// `tr` es el mismo t importado con otro nombre en archivos que ya tienen una variable `t`.
const T_CALL = /\b(?:t|tr)\(\s*"((?:[^"\\]|\\.)*)"/g;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "locales" || name === "test" ? [] : sourceFiles(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

export function codeKeys(root = ".") {
  const keys = new Set();
  for (const file of sourceFiles(join(root, "src"))) {
    for (const m of readFileSync(file, "utf8").matchAll(T_CALL)) keys.add(JSON.parse(`"${m[1]}"`));
  }
  return keys;
}

/** `t("…")` metidos por error dentro de otra cadena (p. ej. un selector CSS): no se ejecutan y rompen el código. */
export function misplacedCalls(root = ".") {
  const found = [];
  for (const file of sourceFiles(join(root, "src"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/'[^'\n]*\b(?:t|tr)\("[^'\n]*'/.test(line) || /\[[\w-]+=(?:t|tr)\(/.test(line)) found.push(`${file}:${i + 1}`);
    });
  }
  return found;
}

/** Textos y atributos (title, placeholder, aria-label) de index.html que translateStatic traduce. */
export function htmlKeys(root = ".") {
  const html = readFileSync(join(root, "index.html"), "utf8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "");
  const keys = new Set();
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const s = decode(m[1].trim());
    if (/[a-záéíóúñ]{2}/i.test(s)) keys.add(s);
  }
  for (const m of html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g)) keys.add(decode(m[1]));
  return keys;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { en } = await import(pathToFileURL(join(process.cwd(), "src/locales/en.ts")).href).catch(() => ({ en: null }));
  const all = [...new Set([...codeKeys(), ...htmlKeys()])];
  const list = process.argv.includes("--missing") && en ? all.filter((k) => !(k in en)) : all;
  console.log(JSON.stringify(list, null, 1));
}
