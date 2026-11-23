import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { detectManager, parseScripts, scriptCommand } from "./scriptsModel";
import { runInTerminal } from "./terminal";
import { quickPick, setStatus, type PickItem } from "./ui";
import { ws } from "./workspace";

/** «Tareas: Ejecutar script de package.json»: elige un script y lo ejecuta en la terminal integrada. */
export async function pickScript() {
  const root = ws.root;
  if (!root) { setStatus(t("Abre una carpeta para ver sus scripts")); return; }
  quickPick({
    placeholder: t("Ejecutar un script de package.json"),
    empty: t("Este proyecto no tiene package.json con scripts"),
    load: async () => {
      let text: string;
      try { text = await invoke<string>("read_file", { path: `${root}/package.json` }); }
      catch { return []; }
      const scripts = parseScripts(text);
      if (!scripts.length) return [];
      let manager = detectManager([]);
      try { manager = detectManager((await invoke<{ name: string }[]>("list_dir", { path: root })).map((e) => e.name)); } catch { /* sin lista: npm */ }
      return scripts.map<PickItem>((s) => ({
        label: s.name,
        detail: s.command,
        hint: manager,
        run: () => {
          setStatus(t("Ejecutando «{command}» en la terminal", { command: scriptCommand(manager, s.name) }), 4000);
          return runInTerminal(scriptCommand(manager, s.name));
        },
      }));
    },
  });
}
