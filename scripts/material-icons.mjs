// Copia los SVG de material-icon-theme (MIT) a public/icons y genera el mapa nombre -> icono.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("material-icon-theme/package.json"));
const { generateManifest } = require("material-icon-theme");
const man = generateManifest();

const base = (key) => path.basename(man.iconDefinitions[key]?.iconPath ?? "", ".svg");
const mapOf = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, base(v)]).filter(([, v]) => v));
const pick = (m) => ({
  file: base(m.file ?? "file"),
  folder: base(m.folder ?? "folder"),
  folderExpanded: base(m.folderExpanded ?? "folder-open"),
  fileExtensions: mapOf(m.fileExtensions),
  fileNames: mapOf(m.fileNames),
  folderNames: mapOf(m.folderNames),
  folderNamesExpanded: mapOf(m.folderNamesExpanded),
});

const out = { ...pick(man), light: pick(man.light ?? {}) };



const dest = "public/icons";
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(path.join(pkgDir, "icons"))) {
  fs.copyFileSync(path.join(pkgDir, "icons", f), path.join(dest, f));
}
fs.copyFileSync(path.join(pkgDir, "LICENSE"), path.join(dest, "LICENSE-material-icon-theme.txt"));
fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(out));
console.log("iconos:", fs.readdirSync(dest).length);
