import { t } from "./i18n";
import { connectGithub, deviceLoginAvailable, deviceLoginCancel, deviceLoginFinish, deviceLoginStart, type DeviceCode } from "./github";
import { openExternal } from "./external";
import { setStatus, showDialog } from "./ui";
import { h } from "./util";

/**
 * «Conectar con GitHub». Si la compilación trae la aplicación OAuth de Pulso, se inicia sesión con un
 * código en github.com (no hace falta Git). Si no, o si la persona lo prefiere, se usa la sesión que Git
 * ya tiene en este equipo (Git Credential Manager). Devuelve true si quedó conectado.
 */
export async function connectFlow(): Promise<boolean> {
  return (await deviceLoginAvailable()) ? deviceFlow() : gitFlow();
}

/** Conexión con la sesión de Git del equipo (Git Credential Manager). */
async function gitFlow(): Promise<boolean> {
  setStatus(t("Conectando con GitHub… si no hay sesión, se abrirá el navegador para que autorices el acceso."), 180000);
  try {
    const login = await connectGithub(true);
    setStatus(t("Conectado a GitHub como {login}", { login }), 6000);
    return true;
  } catch (e) {
    setStatus(t("No se pudo conectar con GitHub"), 4000);
    await showDialog({
      title: t("No se pudo conectar con GitHub"),
      message: e instanceof Error ? e.message : String(e),
      buttons: [{ label: t("Entendido"), value: "ok" }],
    });
    return false;
  }
}

type Outcome = { ok: true; login: string } | { ok: false; error: string };

function codeBox(code: DeviceCode): HTMLElement {
  const box = h("div", "gh-device");
  box.append(
    h("div", "gh-device-code", code.user_code),
    h("div", "gh-device-hint", t("Escríbelo en {url} y autoriza a Pulso.", { url: code.verification_uri })),
  );
  return box;
}

/** Inicio de sesión por código (OAuth device flow): el token llega a Rust sin pasar por Git ni por la interfaz. */
async function deviceFlow(): Promise<boolean> {
  let code: DeviceCode;
  try {
    code = await deviceLoginStart();
  } catch (e) {
    const r = await showDialog({
      title: t("No se pudo iniciar sesión con GitHub"),
      message: String(e),
      buttons: [
        { label: t("Cancelar"), value: "cancel" },
        { label: t("Usar la sesión de Git"), value: "git", primary: true },
      ],
    });
    return r === "git" ? gitFlow() : false;
  }
  // La espera empieza ya: GitHub responde «pendiente» hasta que se autorice el código.
  const waiting: Promise<Outcome> = deviceLoginFinish(code).then(
    (login) => ({ ok: true as const, login }),
    (e) => ({ ok: false as const, error: String(e) }),
  );
  const finished = waiting.then(() => "finished");

  const first = await showDialog({
    title: t("Iniciar sesión con GitHub"),
    message: t(
      "Pulso te pedirá permiso para ver tus repositorios, issues y pull requests. El token se guarda en el almacén de credenciales del sistema.",
    ),
    extra: codeBox(code),
    buttons: [
      { label: t("Cancelar"), value: "cancel" },
      { label: t("Usar la sesión de Git"), value: "git" },
      { label: t("Copiar el código y abrir GitHub"), value: "open", primary: true },
    ],
    closeWhen: finished,
  });
  if (first === "cancel" || first === "git") {
    await deviceLoginCancel();
    return first === "git" ? gitFlow() : false;
  }
  if (first === "open") {
    await navigator.clipboard.writeText(code.user_code).catch(() => {});
    await openExternal(code.verification_uri);
    const second = await showDialog({
      title: t("Esperando la autorización en GitHub…"),
      message: t("El código ya está copiado. Pégalo en la página que se abrió y pulsa «Authorize». Esta ventana se cerrará sola."),
      extra: codeBox(code),
      buttons: [{ label: t("Cancelar"), value: "cancel" }],
      closeWhen: finished,
    });
    if (second === "cancel") {
      await deviceLoginCancel();
      return false;
    }
  }
  const result = await waiting;
  if (result.ok) {
    setStatus(t("Conectado a GitHub como {login}", { login: result.login }), 6000);
    return true;
  }
  setStatus(t("No se pudo conectar con GitHub"), 4000);
  await showDialog({
    title: t("No se pudo conectar con GitHub"),
    message: result.error,
    buttons: [{ label: t("Entendido"), value: "ok" }],
  });
  return false;
}

/** Botón que conecta la cuenta y, si sale bien, ejecuta `after` (normalmente reintentar lo que falló). */
export function connectButton(after: () => void): HTMLButtonElement {
  const b = h("button", "diff-btn primary", t("Conectar con GitHub"));
  b.onclick = async () => {
    b.disabled = true;
    try {
      if (await connectFlow()) after();
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
