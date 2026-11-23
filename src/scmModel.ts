import { t } from "./i18n";
export interface Change { path: string; status: string; orig: string | null }
export interface Changes {
  top: string; branch: string; ahead: number; behind: number; has_head: boolean;
  staged: Change[]; unstaged: Change[]; conflicted: Change[];
}

/** El botón de confirmar solo vale con algo preparado y un mensaje escrito. */
export const canCommit = (c: Changes | null, message: string) => !!c && c.staged.length > 0 && message.trim().length > 0;

/** Cuántos cambios mostrar en la insignia de la barra de actividad. */
export const changeCount = (c: Changes | null) => (c ? c.staged.length + c.unstaged.length + c.conflicted.length : 0);

/** Rutas que se envían a git: un renombrado necesita también el nombre anterior para prepararse o quitarse entero. */
export const pathsOf = (list: Change[]) => list.flatMap((c) => (c.orig ? [c.path, c.orig] : [c.path]));

export interface Branch { name: string; current: boolean; remote: boolean; upstream: string | null }

/** Última línea con contenido de la salida de git: es la que resume el resultado de un push o un pull. */
export const lastLine = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";

/** Texto de confirmación al descartar: deja claro qué se pierde y qué va a la papelera. */
export function discardMessage(items: Change[]): string {
  const fresh = items.filter((c) => c.status === "U");
  const tracked = items.filter((c) => c.status !== "U");
  const shown = items.slice(0, 8).map((c) => `  ${c.path}`);
  if (items.length > 8) shown.push("  " + t("… y {count} más", { count: items.length - 8 }));
  const parts: string[] = [];
  if (tracked.length) parts.push(t("{count} archivo(s) volverán a su última versión preparada o confirmada: los cambios actuales se pierden.", { count: tracked.length }));
  if (fresh.length) parts.push(t("{count} archivo(s) nuevos sin seguimiento irán a la papelera de reciclaje.", { count: fresh.length }));
  return `${parts.join("\n")}\n\n${shown.join("\n")}\n\n${t("Pulso no puede deshacer esto.")}`;
}

/** Contadores y ayuda de los botones de sincronización. */
export function syncInfo(c: Changes | null): { pull: string; push: string; pullTip: string; pushTip: string } {
  const ahead = c?.ahead ?? 0;
  const behind = c?.behind ?? 0;
  return {
    pull: behind ? String(behind) : "",
    push: ahead ? String(ahead) : "",
    pullTip: behind ? t("Traer {count} commit(s) del remoto (pull)", { count: behind }) : t("Traer cambios del remoto (pull)"),
    pushTip: ahead ? t("Subir {count} commit(s) al remoto (push)", { count: ahead }) : t("Subir commits al remoto (push)"),
  };
}
