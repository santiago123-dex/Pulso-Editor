import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { bus } from "./core/events";
import { readStorage, writeStorage } from "./core/storage";
import { findOpenDoc, isDirty, onDocSaved } from "./docs";
import { blameText, relativeToTop, type BlameLine } from "./historyModel";
import { gitTop, refreshScm } from "./scm";
import { setStatus } from "./ui";
import { norm } from "./util";
import { ws } from "./workspace";

/** Culpa (blame) en línea: junto a la línea del cursor, quién la cambió, cuándo y por qué. Se activa y desactiva con un comando. */
const KEY = "pulso.blame";
let enabled = readStorage(KEY) === "1";
const cache = new Map<string, Promise<BlameLine[] | null>>();
const marks = new WeakMap<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>();
const attached = new WeakSet<monaco.editor.ICodeEditor>();

const clear = (ed: monaco.editor.ICodeEditor) => marks.get(ed)?.clear();

async function top(): Promise<string | null> {
  if (!gitTop() && ws.root) await refreshScm();
  return gitTop();
}

/** Líneas con su culpa para un archivo abierto y guardado; null si no es de un repositorio o no se puede leer. */
function load(path: string): Promise<BlameLine[] | null> {
  let p = cache.get(path);
  if (!p) {
    p = (async () => {
      const t = await top();
      const rel = t && relativeToTop(path, t);
      if (!rel || !ws.root) return null;
      try { return await invoke<BlameLine[]>("git_blame", { root: ws.root, path: rel }); } catch { return null; }
    })();
    cache.set(path, p);
  }
  return p;
}

async function update(ed: monaco.editor.ICodeEditor) {
  const model = ed.getModel();
  if (!enabled || !model || model.uri.scheme !== "file") { clear(ed); return; }
  const path = norm(model.uri.fsPath);
  const doc = findOpenDoc(path);
  // Con cambios sin guardar los números de línea ya no coinciden con los de git: no se muestra nada engañoso.
  if (!doc || isDirty(doc)) { clear(ed); return; }
  const line = ed.getPosition()?.lineNumber;
  if (!line) { clear(ed); return; }
  const data = await load(path);
  // El cursor o el documento pudieron cambiar mientras git respondía.
  if (!enabled || ed.getModel() !== model || ed.getPosition()?.lineNumber !== line || isDirty(doc)) return;
  const text = blameText(data?.find((b) => b.line === line));
  if (!text) { clear(ed); return; }
  const mark = marks.get(ed) ?? ed.createDecorationsCollection();
  marks.set(ed, mark);
  mark.set([{ range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)), options: { after: { content: `    ${text}`, inlineClassName: "blame-inline" }, showIfCollapsed: true } }]);
}

function attach(ed: monaco.editor.ICodeEditor) {
  if (attached.has(ed)) return;
  attached.add(ed);
  const disposables = [
    ed.onDidChangeCursorPosition(() => void update(ed)),
    ed.onDidChangeModel(() => void update(ed)),
    ed.onDidChangeModelContent(() => clear(ed)),
  ];
  ed.onDidDispose(() => {
    for (const d of disposables) d.dispose();
    marks.get(ed)?.clear();
    marks.delete(ed);
  });
}

const refreshAll = () => { for (const ed of monaco.editor.getEditors()) void update(ed); };

export function blameEnabled() { return enabled; }

/** «Git: Alternar culpa en línea». */
export function toggleBlame() {
  enabled = !enabled;
  writeStorage(KEY, enabled ? "1" : "0");
  if (!enabled) for (const ed of monaco.editor.getEditors()) clear(ed);
  else refreshAll();
  setStatus(`Culpa en línea: ${enabled ? "activada. Se muestra en la línea del cursor de los archivos guardados" : "desactivada"}`);
}

export function initBlame() {
  monaco.editor.getEditors().forEach(attach);
  monaco.editor.onDidCreateEditor(attach);
  // Guardar o confirmar cambia la culpa; también cambiar de carpeta.
  onDocSaved((path) => { cache.delete(path); refreshAll(); });
  bus.on("scm-refreshed", () => { cache.clear(); refreshAll(); });
}
