import { t as tr } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { allThemes, commit, setTheme, state } from "./settings";
import { parseJsonc, themeFromVSCode } from "./themes";
import { quickPick, setStatus, type PickItem } from "./ui";
import { baseName, dirName, errMsg, norm } from "./util";

interface ThemeRef { label: string; dir: string; rel: string; ui: string; ext: string }

function joinPath(dir: string, rel: string): string {
  const parts = dir.split("/");
  for (const seg of norm(rel).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
}

/** Lee un tema de VS Code y resuelve su `include` (muchos temas heredan de otro archivo). */
async function loadRaw(path: string, depth = 0): Promise<any> {
  const raw = parseJsonc(await invoke<string>("read_theme_file", { path }));
  if (typeof raw.include === "string" && depth < 4) {
    const base = await loadRaw(joinPath(dirName(path), raw.include), depth + 1);
    return {
      ...base, ...raw,
      colors: { ...(base.colors ?? {}), ...(raw.colors ?? {}) },
      tokenColors: [...(Array.isArray(base.tokenColors) ? base.tokenColors : []), ...(Array.isArray(raw.tokenColors) ? raw.tokenColors : [])],
    };
  }
  return raw;
}

async function addTheme(path: string, label: string, ui?: string) {
  try {
    const raw = await loadRaw(path);
    if (!raw.type && ui) raw.type = ui === "vs" ? "light" : "dark";
    const theme = themeFromVSCode(raw, label);
    const id = "custom-" + theme.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    state.settings.customThemes[id] = theme;
    setTheme(id);
    setStatus(tr("Tema «{theme}» importado y aplicado", { theme: theme.label }));
  } catch (e) {
    setStatus(tr("No se pudo importar el tema: {error}", { error: errMsg(e) }));
  }
}

/** Importa un archivo .json de tema de VS Code. */
export async function importFromFile() {
  // El diálogo lo abre Rust: la ventana no elige la ruta, solo recibe la que la persona escogió.
  const file = await invoke<string | null>("pick_theme_file");
  if (typeof file === "string") await addTheme(norm(file), baseName(file).replace(/\.jsonc?$/i, ""));
}

/** Lista los temas de las extensiones instaladas en VS Code y permite importarlos. */
export function importInstalled() {
  quickPick({
    placeholder: tr("Temas instalados en VS Code…"),
    empty: tr("No se encontraron temas en VS Code"),
    load: async () => {
      const refs = await invoke<ThemeRef[]>("scan_vscode_themes");
      if (!refs.length) setStatus(tr("No se encontraron temas instalados en VS Code. Usa «Importar archivo de tema»."));
      return refs.map<PickItem>((r) => ({
        label: r.label,
        detail: r.ext,
        run: () => addTheme(joinPath(r.dir, r.rel), r.label, r.ui),
      }));
    },
  });
}

/** Quita un tema importado. */
export function removeImported() {
  quickPick({
    placeholder: tr("Quitar un tema importado…"),
    empty: tr("No hay temas importados"),
    load: () => Object.entries(state.settings.customThemes).map<PickItem>(([id, t]) => ({
      label: t.label,
      run: () => {
        delete state.settings.customThemes[id];
        if (state.settings.theme === id) { setTheme("pulso-dark"); } else { commit(); }
        setStatus(tr("Tema «{theme}» quitado", { theme: t.label }));
      },
    })),
  });
}

export const hasImported = () => Object.keys(allThemes()).some((id) => id.startsWith("custom-"));
