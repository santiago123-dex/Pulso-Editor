/** Iconos de archivo y carpeta del Material Icon Theme (MIT), igual que en VS Code. */
interface IconSet {
  file: string;
  folder: string;
  folderExpanded: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}
interface Manifest extends IconSet { light: Partial<IconSet> }

let manifest: Manifest | null = null;
let lightMode = false;

export async function loadIconManifest() {
  try {
    manifest = await (await fetch("/icons/manifest.json")).json();
  } catch {
    manifest = null;
  }
}

/** Los temas claros usan las variantes de icono pensadas para fondo claro. */
export function setIconMode(light: boolean) {
  lightMode = light;
}

const pickMap = (key: keyof IconSet, name: string): string | undefined => {
  if (!manifest) return undefined;
  const light = lightMode ? (manifest.light[key] as Record<string, string> | undefined) : undefined;
  return light?.[name] ?? (manifest[key] as Record<string, string>)[name];
};

const pickDefault = (key: "file" | "folder" | "folderExpanded"): string => {
  if (!manifest) return key === "file" ? "file" : "folder";
  return (lightMode ? manifest.light[key] : undefined) ?? manifest[key];
};

function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  const byName = pickMap("fileNames", lower);
  if (byName) return byName;
  // "app.test.ts" prueba "test.ts" y luego "ts".
  let dot = lower.indexOf(".");
  while (dot >= 0) {
    const hit = pickMap("fileExtensions", lower.slice(dot + 1));
    if (hit) return hit;
    dot = lower.indexOf(".", dot + 1);
  }
  return pickDefault("file");
}

function iconEl(icon: string, extra = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = "ficon" + extra;
  const img = document.createElement("img");
  img.src = `/icons/${icon}.svg`;
  img.alt = "";
  img.draggable = false;
  el.append(img);
  return el;
}

export const fileIcon = (name: string): HTMLElement => iconEl(fileIconName(name));

export function folderIcon(name: string, open: boolean): HTMLElement {
  const lower = name.toLowerCase();
  const icon = open
    ? pickMap("folderNamesExpanded", lower) ?? pickDefault("folderExpanded")
    : pickMap("folderNames", lower) ?? pickDefault("folder");
  return iconEl(icon, " folder");
}
