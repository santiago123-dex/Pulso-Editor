import { t as tr } from "./i18n";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { openFile } from "./groups";
import { setStatus } from "./ui";
import { $, baseName, h } from "./util";

export interface DiffTarget { root: string; top: string; path: string; orig: string | null; staged: boolean; status: string }
export interface Sources { original: string; modified: string; binary: boolean }

export interface DiffAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
  run: () => void | Promise<void>;
}

/** Cualquier comparación de dos textos: la del control de código, la de un commit, la de una PR o una propuesta de IA. */
export interface DiffRequest {
  title: string;
  sub: string;
  /** Ruta, solo para colorear según la extensión. */
  path: string;
  load: () => Promise<Sources>;
  /** Ruta local para el botón «Abrir archivo»; sin ella no se ofrece. */
  openPath?: string;
  /** Texto a la derecha del título (por ejemplo «+3 −1»). */
  note?: string;
  /** Acciones adicionales en la cabecera (p. ej. Aplicar / Descartar en Diff Review de IA). */
  actions?: DiffAction[];
}

let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let models: monaco.editor.ITextModel[] = [];
let target: DiffRequest | null = null;
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

export async function openDiffRequest(t: DiffRequest) {
  closeDiff();
  const mine = ++token;
  target = t;
  const root = $("diff-view");
  root.hidden = false;
  window.addEventListener("keydown", onKey, true);

  const head = h("div", "diff-head");
  const title = h("span", "diff-title", t.title);
  const sub = h("span", "diff-sub", t.sub);
  const toggle = h("button", "diff-btn", inline ? tr("Lado a lado") : tr("En línea"));
  const close = h("button", "icon-btn diff-close");
  close.title = tr("Cerrar (Esc)");
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeDiff;
  head.append(title, sub, h("span", "grow"));
  if (t.note) head.append(h("span", "diff-sub", t.note));
  head.append(toggle);
  if (t.openPath) {
    const open = h("button", "diff-btn", tr("Abrir archivo"));
    const p = t.openPath;
    open.onclick = () => { closeDiff(); void openFile(p); };
    head.append(open);
  }
  for (const act of t.actions ?? []) {
    const btn = h("button", `diff-btn${act.primary ? " primary" : ""}${act.danger ? " danger" : ""}`, act.label);
    btn.type = "button";
    btn.onclick = () => void act.run();
    head.append(btn);
  }
  head.append(close);
  const body = h("div", "diff-body");
  root.replaceChildren(head, body);
  body.append(h("div", "diff-msg", tr("Cargando diferencias…")));

  let src: Sources;
  try {
    src = await t.load();
  } catch (e) {
    if (mine === token) body.replaceChildren(h("div", "diff-msg", tr("No se pudo cargar la comparación: {error}", { error: e instanceof Error ? e.message : String(e) })));
    return;
  }
  if (mine !== token) return;
  if (src.binary) { body.replaceChildren(h("div", "diff-msg", tr("Archivo binario: no se muestran diferencias."))); return; }

  body.replaceChildren();
  if (src.original === src.modified) body.append(h("div", "diff-msg", tr("Sin diferencias de contenido (por ejemplo, solo cambió el modo o el nombre).")));
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
    toggle.textContent = inline ? tr("Lado a lado") : tr("En línea");
    editor?.updateOptions({ renderSideBySide: !inline });
  };
  setStatus(tr("Diferencias de {file}", { file: baseName(t.path) }), 2500);
}

/** Diferencias de un archivo del control de código (preparado o sin preparar). */
export async function openDiff(t: DiffTarget) {
  const where = t.staged ? tr("Preparado (HEAD ↔ índice)") : t.status === "U" ? tr("Archivo nuevo") : tr("Sin preparar (índice ↔ disco)");
  await openDiffRequest({
    title: baseName(t.path),
    sub: `${t.path} — ${where}`,
    path: t.path,
    openPath: `${t.top}/${t.path}`,
    load: () => invoke<Sources>("git_diff_sources", { root: t.root, path: t.path, orig: t.orig, staged: t.staged }),
  });
}
