import { invoke } from "@tauri-apps/api/core";
import { setStatus, showDialog } from "./ui";

export interface UpdateInfo { version: string; current: string; notes?: string | null }

/** Texto del aviso: versión actual y nueva, y las notas de la release recortadas a unas líneas. */
export function updateMessage(u: UpdateInfo, maxLines = 8, maxChars = 600): string {
  const head = `Tienes la ${u.current} y está disponible la ${u.version}. Pulso se cerrará, instalará la versión nueva y volverá a abrirse.`;
  const notes = (u.notes ?? "").trim();
  if (!notes) return head;
  let lines = notes.split(/\r?\n/).filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  let cut = lines.length > maxLines;
  lines = lines.slice(0, maxLines);
  let text = lines.join("\n");
  if (text.length > maxChars) { text = text.slice(0, maxChars).trimEnd(); cut = true; }
  return `${head}\n\nNovedades:\n${text}${cut ? "\n…" : ""}`;
}

let busy = false;
let beforeInstall: () => Promise<boolean> = async () => true;

/** `prepare` se llama antes de instalar (guardar cambios); si devuelve false no se instala. */
export function initUpdates(prepare: () => Promise<boolean>) {
  beforeInstall = prepare;
  // Al arrancar, en segundo plano y sin molestar: si falla (sin conexión, versión de desarrollo) no se dice nada.
  window.setTimeout(() => void checkForUpdates(false), 8000);
}

/** Busca una versión nueva. `manual` informa también de «no hay» y de los errores. */
export async function checkForUpdates(manual: boolean) {
  if (busy) return;
  busy = true;
  try {
    if (manual) setStatus("Buscando actualizaciones…", 15000);
    let info: UpdateInfo | null;
    try {
      info = await invoke<UpdateInfo | null>("update_check");
    } catch (e) {
      if (manual) await showDialog({ title: "No se pudo buscar actualizaciones", message: String(e), buttons: [{ label: "Aceptar", value: "ok", primary: true }] });
      return;
    }
    if (!info) {
      if (manual) setStatus("Pulso está al día.", 5000);
      return;
    }
    const r = await showDialog({
      title: `Hay una versión nueva de Pulso (${info.version})`,
      message: updateMessage(info),
      buttons: [
        { label: "Más tarde", value: "later" },
        { label: "Instalar y reiniciar", value: "install", primary: true },
      ],
    });
    if (r !== "install" || !(await beforeInstall())) return;
    setStatus(`Descargando Pulso ${info.version}…`, 120000);
    try {
      await invoke("update_install");
    } catch (e) {
      setStatus("La actualización no se instaló.", 5000);
      await showDialog({ title: "No se pudo actualizar", message: String(e), buttons: [{ label: "Aceptar", value: "ok", primary: true }] });
    }
  } finally {
    busy = false;
  }
}
