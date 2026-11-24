/**
 * «Memoria del agente en este proyecto»: las notas que el agente propio guardó en sesiones anteriores (fuera del proyecto, en la
 * carpeta de datos de Pulso). Elegir una la borra; la primera opción borra todas.
 */
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { quickPick, setStatus, type PickItem } from "../ui";
import { ws } from "../workspace";

interface MemoryEntry { index: number; note: string }

export function showAgentMemory(): void {
  if (!ws.root) { setStatus(tr("Abre una carpeta de proyecto primero."), 5000); return; }
  const cwd = ws.root;
  quickPick({
    placeholder: tr("Notas que el agente recuerda de este proyecto (elige una para borrarla)"),
    empty: tr("El agente todavía no guardó ninguna nota de este proyecto."),
    load: async () => {
      let list: MemoryEntry[];
      try {
        list = await invoke<MemoryEntry[]>("agent_memory_list", { cwd });
      } catch (e) {
        setStatus(tr("No se pudo leer la memoria del agente: {error}", { error: String(e) }), 8000);
        return [];
      }
      const remove = (index?: number) => async () => {
        try {
          await invoke("agent_memory_remove", { cwd, index });
          setStatus(index === undefined ? tr("Memoria del agente borrada") : tr("Nota borrada"), 5000);
        } catch (e) {
          setStatus(tr("No se pudo borrar: {error}", { error: String(e) }), 8000);
        }
      };
      const items = list.map<PickItem>((m) => ({ label: m.note, detail: tr("Elegir para borrar esta nota"), run: remove(m.index) }));
      if (items.length > 1) items.unshift({ label: tr("Borrar toda la memoria de este proyecto"), detail: tr("Quita las {n} notas", { n: list.length }), run: remove() });
      return items;
    },
  });
}
