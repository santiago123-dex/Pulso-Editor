import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { state } from "./settings";
import { setStatus, showDialog } from "./ui";
import { baseName, fileKey, norm } from "./util";

/** Un archivo abierto. Su modelo se comparte entre todos los grupos de editores. */
export interface Doc {
  path: string;
  model: monaco.editor.ITextModel;
  /** Versión del modelo que coincide con lo guardado en disco (-1 = siempre sucio). */
  savedVersion: number;
  /** Fecha de modificación del disco que conoce el editor; sirve para detectar cambios externos. */
  mtime: number;
}

/** Copia de seguridad de cambios sin guardar. */
export interface Backup { path: string; contents: string; base_mtime: number; saved_at: number }

export const docs = new Map<string, Doc>();

/** Devuelve el documento existente aunque Windows o LSP usen otra capitalización. */
export function findOpenDoc(path: string): Doc | undefined {
  const exact = docs.get(path);
  if (exact) return exact;
  const key = fileKey(path);
  return Array.from(docs.values()).find((d) => fileKey(d.path) === key);
}

const subs = new Set<() => void>();
export const onDocsChange = (f: () => void) => { subs.add(f); };
const emit = () => subs.forEach((f) => f());

const savedSubs = new Set<(path: string) => void>();
/** Se llama después de guardar un archivo (para refrescar Git, por ejemplo). */
export const onDocSaved = (f: (path: string) => void) => { savedSubs.add(f); };

export const isDirty = (d: Doc) => d.model.getAlternativeVersionId() !== d.savedVersion;
export const dirtyDocs = () => Array.from(docs.values()).filter(isDirty);

// ---------- Autoguardado y copias de recuperación ----------
const timers = new Map<string, number>();
function scheduleAutoSave(d: Doc) {
  if (!state.settings.autoSave) return;
  clearTimeout(timers.get(d.path));
  timers.set(d.path, window.setTimeout(() => { if (isDirty(d)) void saveDoc(d); }, 800));
}

const BACKUP_DELAY = 1000;
const backupTimers = new Map<string, number>();
const backupOperations = new Map<string, Promise<void>>();

// Serializar por ruta evita que una copia antigua reaparezca después de guardar o descartar.
function queueBackup(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = backupOperations.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation).catch((e) => {
    setStatus(`No se pudo actualizar la recuperación de ${baseName(path)}: ${e}`, 10000);
  });
  backupOperations.set(path, next);
  void next.then(() => { if (backupOperations.get(path) === next) backupOperations.delete(path); });
  return next;
}

/** Guarda en segundo plano una copia de los cambios sin guardar, por si la app se cierra de golpe. */
function scheduleBackup(d: Doc) {
  if (backupTimers.has(d.path)) return;
  backupTimers.set(d.path, window.setTimeout(() => {
    backupTimers.delete(d.path);
    if (docs.get(d.path) !== d) return;
    if (!isDirty(d)) { void removeBackup(d.path); return; }
    const contents = d.model.getValue();
    void queueBackup(d.path, () => invoke("backup_write", { path: d.path, contents, baseMtime: d.mtime }));
  }, BACKUP_DELAY));
}

/** Borra la copia de recuperación de un archivo (ya se guardó o se descartó a propósito). */
export function removeBackup(path: string): Promise<void> {
  clearTimeout(backupTimers.get(path));
  backupTimers.delete(path);
  return queueBackup(path, () => invoke<void>("backup_remove", { path }));
}

function register(path: string, text: string, mtime: number): Doc {
  const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(path));
  model.updateOptions({ tabSize: state.settings.tabSize });
  const d: Doc = { path, model, savedVersion: model.getAlternativeVersionId(), mtime };
  model.onDidChangeContent(() => { emit(); scheduleAutoSave(d); scheduleBackup(d); });
  docs.set(path, d);
  return d;
}

const loading = new Map<string, Promise<Doc>>();

export function loadDoc(path: string): Promise<Doc> {
  path = norm(path);
  const key = fileKey(path);
  const existing = findOpenDoc(path);
  if (existing) return Promise.resolve(existing);
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      const text = await invoke<string>("read_file", { path });
      const mtime = await invoke<number>("file_mtime", { path });
      return register(path, text, mtime);
    })().finally(() => loading.delete(key));
    loading.set(key, p);
  }
  return p;
}

// ---------- Guardado ----------
const conflictOpen = new Set<string>();
const saving = new Set<string>();

/**
 * Guarda el archivo de forma atómica. Si el disco cambió desde que se abrió pregunta qué hacer
 * (salvo `force`), para no pisar en silencio el trabajo de otro programa.
 */
export async function saveDoc(d: Doc, force = false): Promise<boolean> {
  if (saving.has(d.path)) return false;
  saving.add(d.path);
  const version = d.model.getAlternativeVersionId();
  try {
    d.mtime = await invoke<number>("write_file", {
      path: d.path,
      contents: d.model.getValue(),
      expectedMtime: force ? null : d.mtime,
    });
    d.savedVersion = version;
    if (isDirty(d)) scheduleBackup(d); else await removeBackup(d.path);
    emit();
    savedSubs.forEach((f) => f(d.path));
    // El usuario pudo seguir escribiendo mientras se guardaba: no cerrar esos cambios.
    return !isDirty(d);
  } catch (e) {
    if (String(e).includes("CONFLICT")) {
      saving.delete(d.path);
      return resolveConflict(d);
    }
    setStatus(`Error al guardar ${baseName(d.path)}: ${e}`);
    return false;
  } finally {
    saving.delete(d.path);
  }
}

async function resolveConflict(d: Doc): Promise<boolean> {
  if (conflictOpen.has(d.path)) return false;
  conflictOpen.add(d.path);
  try {
    const r = await showDialog({
      title: "El archivo cambió en el disco",
      message: `${baseName(d.path)} se modificó fuera del editor después de abrirlo. Si guardas ahora, esos cambios se perderán.`,
      buttons: [
        { label: "Cancelar", value: "cancel" },
        { label: "Cargar la versión del disco", value: "reload" },
        { label: "Sobrescribir con la mía", value: "overwrite", danger: true },
      ],
    });
    if (r === "overwrite") return await saveDoc(d, true);
    if (r === "reload") {
      await reloadDoc(d.path);
      setStatus(`${baseName(d.path)} se recargó desde el disco`);
    }
    return false;
  } catch (e) {
    setStatus(`No se pudo resolver el conflicto de ${baseName(d.path)}: ${e}`);
    return false;
  } finally {
    conflictOpen.delete(d.path);
  }
}

/** Vuelve a leer el archivo del disco conservando el historial de deshacer. */
export async function reloadDoc(path: string) {
  const d = docs.get(path);
  if (!d) return;
  const text = await invoke<string>("read_file", { path });
  d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text }], () => null);
  d.savedVersion = d.model.getAlternativeVersionId();
  d.mtime = await invoke<number>("file_mtime", { path });
  void removeBackup(path);
  emit();
}

export function disposeDoc(path: string) {
  const d = docs.get(path);
  if (!d) return;
  clearTimeout(timers.get(path));
  d.model.dispose();
  docs.delete(path);
  // Si se llegó aquí el archivo se guardó, se descartó a propósito o se eliminó.
  void removeBackup(path);
}

/** Copia un documento a otra ruta (para renombrar/mover) conservando el estado. */
export function cloneDoc(d: Doc, newPath: string): Doc {
  const dirty = isDirty(d);
  const nd = register(newPath, d.model.getValue(), d.mtime);
  if (dirty) {
    nd.savedVersion = -1;
    scheduleBackup(nd);
  }
  return nd;
}

// ---------- Cambios externos ----------
let checking = false;

/** Detecta archivos modificados fuera del editor y ofrece recargarlos. */
export async function checkExternal() {
  if (checking) return;
  checking = true;
  try {
    for (const d of Array.from(docs.values())) {
      let m: number;
      try { m = await invoke<number>("file_mtime", { path: d.path }); } catch { continue; }
      if (m === d.mtime) continue;
      if (!isDirty(d)) {
        await reloadDoc(d.path);
        setStatus(`${baseName(d.path)} se recargó porque cambió en el disco`);
        continue;
      }
      const r = await showDialog({
        title: "El archivo cambió en el disco",
        message: `${baseName(d.path)} se modificó fuera del editor y tienes cambios sin guardar.`,
        buttons: [
          { label: "Mantener los míos", value: "keep" },
          { label: "Recargar desde el disco", value: "reload", danger: true },
        ],
      });
      // Con "mantener", guardar volverá a avisar del conflicto: la decisión final es al guardar.
      if (r === "reload") await reloadDoc(d.path);
    }
  } finally {
    checking = false;
  }
}

// ---------- Recuperación tras un cierre inesperado ----------
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "hace unos segundos";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}

/** Vuelve a poner en un documento los cambios de una copia de recuperación. */
export async function restoreFromBackup(b: Backup): Promise<Doc> {
  let d = docs.get(b.path);
  if (!d) {
    try {
      d = await loadDoc(b.path);
    } catch {
      // El archivo ya no existe: se recrea como documento sin guardar.
      const created = register(b.path, b.contents, 0);
      created.savedVersion = -1;
      scheduleBackup(created);
      return created;
    }
  }
  d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: b.contents }], () => null);
  // Se conserva la fecha que tenía el archivo al hacer la copia: si cambió en el disco desde entonces,
  // guardar avisará del conflicto en vez de pisarlo.
  d.mtime = b.base_mtime;
  if (isDirty(d)) scheduleBackup(d); else void removeBackup(b.path);
  emit();
  return d;
}

/** Al iniciar, ofrece recuperar los cambios sin guardar de la sesión anterior. */
export async function offerRecovery(open: (path: string) => Promise<void>): Promise<void> {
  let list: Backup[];
  try { list = await invoke<Backup[]>("backup_list"); } catch { return; }
  if (!list.length) return;
  const shown = list.slice(0, 8).map((b) => `• ${baseName(b.path)} (${ago(b.saved_at)})`).join("\n");
  const more = list.length > 8 ? `\n… y ${list.length - 8} más` : "";
  const r = await showDialog({
    title: "Recuperar cambios sin guardar",
    message: `Pulso se cerró antes de guardar estos archivos:\n\n${shown}${more}`,
    buttons: [
      { label: "Descartar", value: "discard", danger: true },
      { label: "Más tarde", value: "later" },
      { label: "Restaurar", value: "restore", primary: true },
    ],
  });
  if (r === "discard") {
    await Promise.all(list.map((b) => removeBackup(b.path)));
  } else if (r === "restore") {
    for (const b of list) {
      await restoreFromBackup(b);
      await open(b.path);
    }
    setStatus(`${list.length} archivo(s) restaurado(s). Revisa los cambios y guarda.`);
  }
}

/** Descarta las copias de todos los archivos con cambios sin guardar (al salir sin guardar a propósito). */
export async function discardDirtyBackups() {
  await Promise.all(dirtyDocs().map((d) => removeBackup(d.path)));
}
