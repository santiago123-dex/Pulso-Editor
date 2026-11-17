import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
  const raw = parseJsonc(await invoke<string>("read_file", { path }));
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
    setStatus(`Tema «${theme.label}» importado y aplicado`);
  } catch (e) {
    setStatus(`No se pudo importar el tema: ${errMsg(e)}`);
  }
}

/** Importa un archivo .json de tema de VS Code. */
export async function importFromFile() {
  const file = await open({ filters: [{ name: "Tema de VS Code", extensions: ["json", "jsonc"] }] });
  if (typeof file === "string") await addTheme(norm(file), baseName(file).replace(/\.jsonc?$/i, ""));
}

/** Lista los temas de las extensiones instaladas en VS Code y permite importarlos. */
export function importInstalled() {
  quickPick({
    placeholder: "Temas instalados en VS Code…",
    empty: "No se encontraron temas en VS Code",
    load: async () => {
      const refs = await invoke<ThemeRef[]>("scan_vscode_themes");
      if (!refs.length) setStatus("No se encontraron temas instalados en VS Code. Usa «Importar archivo de tema».");
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
    placeholder: "Quitar un tema importado…",
    empty: "No hay temas importados",
    load: () => Object.entries(state.settings.customThemes).map<PickItem>(([id, t]) => ({
      label: t.label,
      run: () => {
        delete state.settings.customThemes[id];
        if (state.settings.theme === id) { setTheme("pulso-dark"); } else { commit(); }
        setStatus(`Tema «${t.label}» quitado`);
      },
    })),
  });
}

export const hasImported = () => Object.keys(allThemes()).some((id) => id.startsWith("custom-"));
