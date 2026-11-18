import { invoke } from "@tauri-apps/api/core";
import { setStatus } from "./ui";

/** Abre un enlace en el navegador del sistema. La ventana de Pulso no abre ventanas nuevas con `window.open`. */
export async function openExternal(url: string): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) { window.open(url, "_blank"); return; }
  try { await invoke("open_external", { url }); }
  catch (e) { setStatus(String(e), 6000); }
}
