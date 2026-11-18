import { connectGithub } from "./github";
import { setStatus, showDialog } from "./ui";
import { h } from "./util";

/**
 * «Conectar con GitHub»: reutiliza la sesión que Git ya tiene o, si no hay, abre el navegador para que se
 * autoricen los permisos. Devuelve true si quedó conectado.
 */
export async function connectFlow(): Promise<boolean> {
  setStatus("Conectando con GitHub… si no hay sesión, se abrirá el navegador para que autorices el acceso.", 180000);
  try {
    const login = await connectGithub(true);
    setStatus(`Conectado a GitHub como ${login}`, 6000);
    return true;
  } catch (e) {
    setStatus("No se pudo conectar con GitHub", 4000);
    await showDialog({ title: "No se pudo conectar con GitHub", message: e instanceof Error ? e.message : String(e), buttons: [{ label: "Entendido", value: "ok" }] });
    return false;
  }
}

/** Botón que conecta la cuenta y, si sale bien, ejecuta `after` (normalmente reintentar lo que falló). */
export function connectButton(after: () => void): HTMLButtonElement {
  const b = h("button", "diff-btn primary", "Conectar con GitHub");
  b.onclick = async () => {
    b.disabled = true;
    try { if (await connectFlow()) after(); } finally { b.disabled = false; }
  };
  return b;
}
