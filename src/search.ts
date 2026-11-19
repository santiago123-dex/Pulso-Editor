import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { dirtyDocs, docs, isDirty, reloadDoc } from "./docs";
import { openFile } from "./groups";
import { fileIcon } from "./icons";
import { computeLineReplacements } from "./searchReplace";
import { setStatus, showDialog } from "./ui";
import { $, baseName, dirName, h, inp } from "./util";
import { rel, ws } from "./workspace";

interface Match { path: string; line: number; col: number; len: number; text: string }

let seq = 0;
let timer = 0;
let results = new Map<string, Match[]>();
/** La búsqueda llegó al límite: los recuentos por archivo pueden estar incompletos. */
let truncated = false;
const collapsed = new Set<string>();

const opts = () => ({
  query: inp("sq").value,
  caseSensitive: $("sq-case").classList.contains("on"),
  wholeWord: $("sq-word").classList.contains("on"),
  useRegex: $("sq-re").classList.contains("on"),
});

function schedule(delay = 300) {
  clearTimeout(timer);
  timer = window.setTimeout(() => void run(), delay);
}

export function focusSearch(prefill?: string) {
  const q = inp("sq");
  if (prefill) q.value = prefill;
  q.focus();
  q.select();
  if (q.value) schedule(0);
}

async function run() {
  const id = ++seq;
  const o = opts();
  const summary = $("search-summary");
  const box = $("search-results");
  if (!ws.root) { summary.textContent = "Abre una carpeta para buscar."; box.replaceChildren(); return; }
  if (!o.query) { summary.textContent = ""; box.replaceChildren(); results = new Map(); return; }
  summary.textContent = "Buscando…";
  try {
    const found = await invoke<Match[]>("search_files", {
      root: ws.root,
      query: o.query,
      caseSensitive: o.caseSensitive,
      useRegex: o.useRegex,
      wholeWord: o.wholeWord,
      include: inp("sinc").value.split(",").map((s) => s.trim()).filter(Boolean),
      // Los documentos con cambios sin guardar se buscan tal como están en pantalla.
      unsaved: Object.fromEntries(dirtyDocs().map((d) => [d.path, d.model.getValue()])),
    });
    if (id !== seq) return;
    results = new Map();
    truncated = found.length >= 5000;
    for (const m of found) {
      const list = results.get(m.path);
      if (list) list.push(m); else results.set(m.path, [m]);
    }
    const files = results.size;
    summary.textContent = found.length
      ? `${found.length} resultado(s) en ${files} archivo(s)${found.length >= 5000 ? " (se muestran los primeros 5000)" : ""}`
      : "Sin resultados";
    paint();
  } catch (e) {
    if (id !== seq) return;
    summary.textContent = String(e);
    box.replaceChildren();
    results = new Map();
  }
}

function paint() {
  const box = $("search-results");
  box.replaceChildren();
  for (const [path, list] of results) {
    const isCollapsed = collapsed.has(path);
    const head = h("div", "sfile" + (isCollapsed ? " closed" : ""));
    head.append(h("span", "chev"), fileIcon(baseName(path)), h("span", "name", baseName(path)));
    const open = docs.get(path);
    if (open && isDirty(open)) head.append(h("span", "sdir", "sin guardar"));
    const dir = rel(dirName(path));
    if (dir) head.append(h("span", "sdir", dir));
    head.append(h("span", "scount", String(list.length)));
    const rep = h("button", "icon-btn sfile-rep");
    rep.title = "Reemplazar en este archivo";
    rep.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h12l-3-3M20 17H8l3 3"/></svg>';
    rep.onclick = (e) => { e.stopPropagation(); void replaceIn([path]); };
    head.append(rep);
    head.onclick = () => {
      if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
      paint();
    };
    box.append(head);
    if (isCollapsed) continue;
    for (const m of list) {
      const row = h("div", "smatch");
      const lead = m.text.length - m.text.trimStart().length;
      const text = m.text.trimStart();
      const start = m.col - 1 - lead;
      if (start >= 0 && start + m.len <= text.length) {
        row.append(text.slice(0, start), h("mark", "", text.slice(start, start + m.len)), text.slice(start + m.len));
      } else {
        row.textContent = text;
      }
      row.title = `Línea ${m.line}`;
      row.onclick = () => void openFile(m.path, { line: m.line, col: m.col, len: m.len });
      box.append(row);
    }
  }
}

async function replaceIn(paths: string[]) {
  const o = opts();
  if (!o.query || !paths.length) return;
  const replacement = inp("sr").value;
  const dirty = paths.filter((p) => { const d = docs.get(p); return d && isDirty(d); });
  const total = paths.reduce((n, p) => n + (results.get(p)?.length ?? 0), 0);
  const MAX_LIST = 12;
  const lines = paths.slice(0, MAX_LIST).map((p) => {
    const d = docs.get(p);
    const mark = d && isDirty(d) ? " (en editor, sin guardar)" : "";
    return `  ${rel(p)} — ${results.get(p)?.length ?? 0}${mark}`;
  });
  if (paths.length > MAX_LIST) lines.push(`  … y ${paths.length - MAX_LIST} archivo(s) más`);
  const diskOnly = paths.length > dirty.length;
  const r = await showDialog({
    title: "Reemplazar",
    message: `«${o.query}» → «${replacement}»\n\n${total} coincidencia(s) en ${paths.length} archivo(s):\n${lines.join("\n")}` +
      (dirty.length ? "\n\nLos archivos abiertos sin guardar se editarán en el editor (puedes deshacer con Ctrl+Z)." : "") +
      (diskOnly ? "\nLos demás archivos se modifican en disco y esa parte no se puede deshacer desde Pulso." : ""),
    buttons: [
      { label: "Cancelar", value: "cancel" },
      { label: "Reemplazar", value: "ok", danger: true },
    ],
  });
  if (r !== "ok") return;
  let changed = 0, done = 0;
  const failed: string[] = [];
  for (const path of paths) {
    const open = docs.get(path);
    if (open && isDirty(open)) {
      try {
        const res = computeLineReplacements(open.model.getValue(), { ...o, replacement });
        if (res.count > 0) {
          open.model.pushEditOperations(
            [],
            res.edits.map((e) => ({ range: new monaco.Range(e.lineNumber, 1, e.lineNumber, e.endColumn), text: e.text })),
            () => null,
          );
          changed += res.count;
        }
        done++;
      } catch (e) {
        failed.push(`  ${rel(path)}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    try {
      changed += await invoke<number>("replace_in_file", {
        path, query: o.query, replacement,
        caseSensitive: o.caseSensitive, useRegex: o.useRegex, wholeWord: o.wholeWord,
        expected: truncated ? null : results.get(path)?.length ?? null,
      });
      done++;
      if (docs.has(path)) await reloadDoc(path);
    } catch (e) {
      failed.push(`  ${rel(path)}: ${String(e).replace(/^CONFLICT$/, "el archivo cambió en disco")}`);
    }
  }
  await run();
  if (failed.length) {
    await showDialog({
      title: "Reemplazo incompleto",
      message: `${changed} coincidencia(s) reemplazadas en ${done} archivo(s).\n\nNo se modificaron:\n${failed.join("\n")}\n\nLa búsqueda se actualizó; revisa y repite si hace falta.`,
      buttons: [{ label: "Entendido", value: "ok" }],
    });
  } else {
    setStatus(`${changed} coincidencia(s) reemplazadas en ${done} archivo(s)`);
  }
}

export function initSearch() {
  inp("sq").oninput = () => schedule();
  inp("sq").onkeydown = (e) => { if (e.key === "Enter") schedule(0); };
  inp("sinc").oninput = () => schedule();
  for (const id of ["sq-case", "sq-word", "sq-re"]) {
    $(id).onclick = () => { $(id).classList.toggle("on"); schedule(0); };
  }
  $("sr-all").onclick = () => void replaceIn(Array.from(results.keys()));
  inp("sr").onkeydown = (e) => { if (e.key === "Enter") void replaceIn(Array.from(results.keys())); };
  $("search-clear").onclick = () => {
    inp("sq").value = ""; inp("sr").value = ""; inp("sinc").value = "";
    results = new Map();
    $("search-results").replaceChildren();
    $("search-summary").textContent = "";
  };
}

/** Limita la búsqueda a una carpeta (desde el menú del explorador). */
export function searchInFolder(path: string) {
  inp("sinc").value = rel(path);
  focusSearch();
}
