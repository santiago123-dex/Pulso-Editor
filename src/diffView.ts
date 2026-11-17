import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { openFile } from "./groups";
import { setStatus } from "./ui";
import { $, baseName, h } from "./util";

export interface DiffTarget { root: string; top: string; path: string; orig: string | null; staged: boolean; status: string }
interface Sources { original: string; modified: string; binary: boolean }

let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let models: monaco.editor.ITextModel[] = [];
let target: DiffTarget | null = null;
let token = 0;
let inline = false;

export const isDiffOpen = () => target !== null;

/** Lenguaje de Monaco según la extensión, para colorear el contenido de la comparación. */
function languageOf(path: string): string | undefined {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = name.slice(dot).toLowerCase();
  return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext))?.id;
}

export function closeDiff() {
  token++;
  target = null;
  const root = $("diff-view");
  root.hidden = true;
  editor?.dispose();
  editor = null;
  models.forEach((m) => m.dispose());
  models = [];
  root.replaceChildren();
  window.removeEventListener("keydown", onKey, true);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDiff(); }
}

export async function openDiff(t: DiffTarget) {
  closeDiff();
  const mine = ++token;
  target = t;
  const root = $("diff-view");
  root.hidden = false;
  window.addEventListener("keydown", onKey, true);

  const head = h("div", "diff-head");
  const title = h("span", "diff-title", baseName(t.path));
  const where = t.staged ? "Preparado (HEAD ↔ índice)" : t.status === "U" ? "Archivo nuevo" : "Sin preparar (índice ↔ disco)";
  const sub = h("span", "diff-sub", `${t.path} — ${where}`);
  const toggle = h("button", "diff-btn", inline ? "Lado a lado" : "En línea");
  const open = h("button", "diff-btn", "Abrir archivo");
  const close = h("button", "icon-btn diff-close");
  close.title = "Cerrar (Esc)";
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeDiff;
  open.onclick = () => { const p = `${t.top}/${t.path}`; closeDiff(); void openFile(p); };
  head.append(title, sub, h("span", "grow"), toggle, open, close);
  const body = h("div", "diff-body");
  root.replaceChildren(head, body);
  body.append(h("div", "diff-msg", "Cargando diferencias…"));

  let src: Sources;
  try {
    src = await invoke<Sources>("git_diff_sources", { root: t.root, path: t.path, orig: t.orig, staged: t.staged });
  } catch (e) {
    if (mine === token) body.replaceChildren(h("div", "diff-msg", `No se pudo cargar la comparación: ${e}`));
    return;
  }
  if (mine !== token) return;
  if (src.binary) { body.replaceChildren(h("div", "diff-msg", "Archivo binario: no se muestran diferencias.")); return; }

  body.replaceChildren();
  if (src.original === src.modified) body.append(h("div", "diff-msg", "Sin diferencias de contenido (por ejemplo, solo cambió el modo o el nombre)."));
  const holder = h("div", "diff-editor");
  body.append(holder);
  const lang = languageOf(t.path);
  const stamp = `${Date.now()}-${mine}`;
  const side = (name: string, text: string) => monaco.editor.createModel(text, lang, monaco.Uri.from({ scheme: "pulso-diff", path: `/${stamp}/${name}/${t.path}` }));
  models = [side("a", src.original), side("b", src.modified)];
  editor = monaco.editor.createDiffEditor(holder, {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: !inline,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderOverviewRuler: true,
  });
  editor.setModel({ original: models[0], modified: models[1] });
  toggle.onclick = () => {
    inline = !inline;
    toggle.textContent = inline ? "Lado a lado" : "En línea";
    editor?.updateOptions({ renderSideBySide: !inline });
  };
  setStatus(`Diferencias de ${baseName(t.path)}`, 2500);
}
