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
