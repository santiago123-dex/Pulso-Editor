import { invoke } from "@tauri-apps/api/core";
import { dirtyDocs } from "./docs";
import { decorate, refreshGit } from "./git";
import { FILE_MIME, openFile, removePaths, renamePaths, splitGroup } from "./groups";
import { fileIcon, folderIcon } from "./icons";
import { promptText, setStatus, showDialog, showMenu, type MenuItem } from "./ui";
import { $, baseName, dirName, h } from "./util";
import { rel, ws } from "./workspace";

interface Entry { name: string; path: string; is_dir: boolean }

const expanded = new Set<string>();
let selected: string | null = null;
let treeGeneration = 0;
const dirGeneration = new WeakMap<HTMLElement, number>();

export function resetExplorer() {
  treeGeneration++;
  expanded.clear();
  selected = null;
}

// ---------- Dibujo del árbol ----------
async function renderDir(path: string, into: HTMLElement) {
  const entries = await invoke<Entry[]>("list_dir", { path });
  const children: Promise<void>[] = [];
  for (const e of entries) {
    const open = e.is_dir && expanded.has(e.path);
    const node = h("div", "node" + (e.is_dir ? " dir" : "") + (open ? " open" : "") + (e.path === selected ? " sel" : ""));
    node.dataset.path = e.path;
    node.draggable = true;
    node.append(h("span", "chev"), e.is_dir ? folderIcon(e.name, open) : fileIcon(e.name), h("span", "name", e.name));
    const dec = decorate(e.path, e.is_dir);
    if (dec) {
      node.classList.add(dec.cls);
      if (dec.badge) node.append(h("span", "gitdec", dec.badge));
    }
    into.append(node);
    if (e.is_dir) {
      const kids = h("div", "children");
      into.append(kids);
      if (open) children.push(renderDir(e.path, kids));
    }
  }
  await Promise.all(children);
}

function repaintGit(tree: HTMLElement) {
  tree.querySelectorAll<HTMLElement>(".node").forEach((node) => {
    for (const cls of Array.from(node.classList)) if (cls.startsWith("git-")) node.classList.remove(cls);
    node.querySelector(".gitdec")?.remove();
    const dec = decorate(node.dataset.path!, node.classList.contains("dir"));
    if (dec) { node.classList.add(dec.cls); if (dec.badge) node.append(h("span", "gitdec", dec.badge)); }
  });
}

/** Actualiza las marcas sin volver a leer ni reconstruir todo el explorador. */
export async function refreshGitDecorations() {
  const root = ws.root;
  if (!root) return;
  await refreshGit(root);
  if (ws.root === root) repaintGit($("tree"));
}

/** Vuelve a dibujar el árbol conservando carpetas abiertas y scroll. */
export async function refreshTree() {
  const id = ++treeGeneration;
  const tree = $("tree");
  const root = ws.root;
  if (!root) {
    void refreshGit(null);
    tree.replaceChildren();
    $("tree-empty").hidden = false;
    $("folder-name").classList.remove("on");
    return;
  }
  const next = h("div");
  // Git no debe retrasar la apertura de la carpeta ni reemplazar el árbol más tarde.
  void refreshGit(root).then(() => { if (ws.root === root) repaintGit(tree); });
  try {
    await renderDir(root, next);
  } catch (e) {
    if (id === treeGeneration) setStatus(`No se pudo leer la carpeta: ${e}`);
    return;
  }
  if (id !== treeGeneration || ws.root !== root) return;
  if (!next.childNodes.length) next.append(h("div", "tree-note", "La carpeta está vacía"));
  const top = tree.scrollTop;
  tree.replaceChildren(...Array.from(next.childNodes));
  repaintGit(tree);
  tree.scrollTop = top;
}

export function collapseAll() {
  expanded.clear();
  void refreshTree();
}

/** Resalta el archivo activo en el árbol si está visible. */
export function highlight(path: string | null) {
  selected = path ?? selected;
  const tree = $("tree");
  tree.querySelectorAll<HTMLElement>(".node.sel").forEach((n) => n.classList.remove("sel"));
  if (path) tree.querySelector<HTMLElement>(`.node[data-path="${CSS.escape(path)}"]`)?.classList.add("sel");
}

function expandTo(path: string) {
  if (!ws.root) return;
  let dir = dirName(path);
  while (dir.length > ws.root.length) { expanded.add(dir); dir = dirName(dir); }
}

export async function revealInTree(path: string) {
  expandTo(path);
  selected = path;
  await refreshTree();
  $("tree").querySelector(".node.sel")?.scrollIntoView({ block: "nearest" });
}

function remapExpanded(from: string, to: string) {
  for (const p of Array.from(expanded)) {
    if (p === from || p.startsWith(from + "/")) { expanded.delete(p); expanded.add(to + p.slice(from.length)); }
  }
}

// ---------- Operaciones de archivos ----------
const BAD = /[<>:"|?*\u0000-\u001f]/;

function validate(v: string, allowSlash: boolean): string | null {
  if (!v) return "Escribe un nombre";
  if (BAD.test(v)) return "El nombre contiene caracteres no permitidos";
  if (!allowSlash && /[\\/]/.test(v)) return "El nombre no puede contener barras";
  if (v.split(/[\\/]/).some((s) => s === ".." || s === ".")) return "Nombre no válido";
  if (/^[\\/]|[\\/]$/.test(v)) return "El nombre no puede empezar ni terminar con barra";
  return null;
}

function currentDir(): string {
  if (!ws.root) return "";
  if (!selected) return ws.root;
  const node = Array.from($("tree").querySelectorAll<HTMLElement>(".node")).find((n) => n.dataset.path === selected);
  return node?.classList.contains("dir") ? selected : dirName(selected) || ws.root;
}

export async function newEntry(kind: "file" | "folder", dir?: string) {
  if (!ws.root) { setStatus("Abre una carpeta primero"); return; }
  const base = dir ?? currentDir();
  const name = await promptText({
    title: kind === "file" ? "Nuevo archivo" : "Nueva carpeta",
    placeholder: kind === "file" ? "nombre.ext (o carpeta/nombre.ext)" : "nombre de la carpeta",
    validate: (v) => validate(v, true),
  });
  if (!name) return;
  const path = `${base}/${name.replace(/\\/g, "/")}`;
  try {
    await invoke(kind === "file" ? "create_file" : "create_dir", { path });
  } catch (e) {
    setStatus(`No se pudo crear: ${e}`);
    return;
  }
  if (kind === "folder") expanded.add(path);
  expandTo(path);
  selected = path;
  await refreshTree();
  if (kind === "file") await openFile(path);
}

export async function renameEntry(path: string) {
  const old = baseName(path);
  const name = await promptText({ title: "Renombrar", value: old, validate: (v) => validate(v, false) });
  if (!name || name === old) return;
  const to = `${dirName(path)}/${name}`;
  try {
    await invoke("rename_path", { from: path, to });
  } catch (e) {
    setStatus(`No se pudo renombrar: ${e}`);
    return;
  }
  renamePaths(path, to);
  remapExpanded(path, to);
  if (selected && (selected === path || selected.startsWith(path + "/"))) selected = to + selected.slice(path.length);
  await refreshTree();
}

export async function deleteEntry(path: string) {
  const unsaved = dirtyDocs().filter((d) => d.path === path || d.path.startsWith(path + "/"));
  const r = await showDialog({
    title: "Eliminar",
    message: `¿Mover «${baseName(path)}» a la papelera de reciclaje?` +
      (unsaved.length ? `\n\nSe perderán los cambios sin guardar de ${unsaved.length} archivo(s) abierto(s).` : ""),
    buttons: [
      { label: "Cancelar", value: "cancel" },
      { label: "Mover a la papelera", value: "ok", danger: true },
    ],
  });
  if (r !== "ok") return;
  try {
    await invoke("delete_path", { path });
  } catch (e) {
    setStatus(`No se pudo eliminar: ${e}`);
    return;
  }
  await removePaths(path);
  for (const p of Array.from(expanded)) if (p === path || p.startsWith(path + "/")) expanded.delete(p);
  if (selected === path) selected = null;
  await refreshTree();
}

async function moveEntry(src: string, destDir: string) {
  if (dirName(src) === destDir) return;
  if (destDir === src || destDir.startsWith(src + "/")) { setStatus("No se puede mover una carpeta dentro de sí misma"); return; }
  const to = `${destDir}/${baseName(src)}`;
  try {
    await invoke("rename_path", { from: src, to });
  } catch (e) {
    setStatus(`No se pudo mover: ${e}`);
    return;
  }
  renamePaths(src, to);
  remapExpanded(src, to);
  expanded.add(destDir);
  selected = to;
  await refreshTree();
}

// ---------- Eventos ----------
function entryMenu(path: string, isDir: boolean): MenuItem[] {
  const dir = isDir ? path : dirName(path);
  return [
    ...(isDir ? [] : [
      { label: "Abrir", run: () => void openFile(path) },
      { label: "Abrir en un grupo nuevo", run: () => { const g = splitGroup(null); if (g) void openFile(path, { group: g }); } },
      "sep" as const,
    ]),
    { label: "Nuevo archivo…", run: () => void newEntry("file", dir) },
    { label: "Nueva carpeta…", run: () => void newEntry("folder", dir) },
    ...(isDir ? [{ label: "Buscar en la carpeta…", run: () => onSearchIn(path) }] : []),
    { label: "Abrir en la terminal integrada", run: () => onOpenTerminal(dir) },
    "sep",
    { label: "Renombrar…", hint: "F2", run: () => void renameEntry(path) },
    { label: "Eliminar", hint: "Supr", danger: true, run: () => void deleteEntry(path) },
    "sep",
    { label: "Copiar ruta", run: () => void navigator.clipboard.writeText(path) },
    { label: "Copiar ruta relativa", run: () => void navigator.clipboard.writeText(rel(path)) },
    { label: "Mostrar en el Explorador de Windows", run: () => void invoke("reveal_in_explorer", { path }) },
  ];
}

async function toggleDir(node: HTMLElement) {
  treeGeneration++;
  const id = (dirGeneration.get(node) ?? 0) + 1;
  dirGeneration.set(node, id);
  const path = node.dataset.path!;
  const kids = node.nextElementSibling as HTMLElement;
  const open = !expanded.has(path);
  if (open) expanded.add(path); else expanded.delete(path);
  node.classList.toggle("open", open);
  node.querySelector(".ficon")?.replaceWith(folderIcon(baseName(path), open));
  kids.replaceChildren();
  if (open) {
    try {
      const next = h("div");
      await renderDir(path, next);
      if (dirGeneration.get(node) === id && expanded.has(path)) kids.replaceChildren(...Array.from(next.childNodes));
    } catch (e) { if (dirGeneration.get(node) === id) setStatus(`No se pudo leer la carpeta: ${e}`); }
  }
}

let onSearchIn: (path: string) => void = () => {};
let onOpenTerminal: (dir: string) => void = () => {};

export function initExplorer(hooks: { onOpenFolder: () => void; onSearchIn: (path: string) => void; onOpenTerminal: (dir: string) => void }) {
  onSearchIn = hooks.onSearchIn;
  onOpenTerminal = hooks.onOpenTerminal;
  const tree = $("tree");
  tree.tabIndex = 0;
  const nodeOf = (t: EventTarget | null) => (t as HTMLElement).closest<HTMLElement>(".node");

  tree.addEventListener("click", (e) => {
    const node = nodeOf(e.target);
    if (!node) return;
    tree.focus();
    highlight(node.dataset.path!);
    if (node.classList.contains("dir")) void toggleDir(node); else void openFile(node.dataset.path!);
  });

  const menuFor = (e: MouseEvent) => {
    e.preventDefault();
    if (!ws.root) return;
    const node = nodeOf(e.target);
    if (node) {
      highlight(node.dataset.path!);
      showMenu(e.clientX, e.clientY, entryMenu(node.dataset.path!, node.classList.contains("dir")));
    } else {
      showMenu(e.clientX, e.clientY, [
        { label: "Nuevo archivo…", run: () => void newEntry("file", ws.root!) },
        { label: "Nueva carpeta…", run: () => void newEntry("folder", ws.root!) },
        { label: "Actualizar", run: () => void refreshTree() },
      ]);
    }
  };
  tree.addEventListener("contextmenu", menuFor);

  tree.addEventListener("keydown", (e) => {
    if (!selected || e.target !== tree) return;
    if (e.key === "F2") { e.preventDefault(); void renameEntry(selected); }
    else if (e.key === "Delete") { e.preventDefault(); void deleteEntry(selected); }
  });

  // Arrastrar para mover archivos o abrirlos en un grupo del editor.
  tree.addEventListener("dragstart", (e) => {
    const node = nodeOf(e.target);
    if (!node || !e.dataTransfer) return;
    e.dataTransfer.setData(FILE_MIME, node.dataset.path!);
    e.dataTransfer.effectAllowed = "copyMove";
  });
  let over: HTMLElement | null = null;
  const clearOver = () => { over?.classList.remove("drop"); over = null; };
  tree.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(FILE_MIME)) return;
    e.preventDefault();
    const node = nodeOf(e.target);
    const target = node?.classList.contains("dir") ? node : null;
    if (target !== over) { clearOver(); over = target; over?.classList.add("drop"); }
  });
  tree.addEventListener("dragleave", (e) => { if (e.target === tree) clearOver(); });
  tree.addEventListener("drop", (e) => {
    const src = e.dataTransfer?.getData(FILE_MIME);
    if (!src || !ws.root) return;
    e.preventDefault();
    const node = nodeOf(e.target);
    let dest = ws.root;
    if (node) dest = node.classList.contains("dir") ? node.dataset.path! : dirName(node.dataset.path!);
    clearOver();
    void moveEntry(src, dest);
  });
  tree.addEventListener("dragend", clearOver);

  $("folder-name").onclick = () => {
    const collapsed = $("tree").classList.toggle("collapsed");
    $("folder-name").classList.toggle("closed", collapsed);
  };
  $("ex-new-file").onclick = () => void newEntry("file");
  $("ex-new-folder").onclick = () => void newEntry("folder");
  $("ex-refresh").onclick = () => void refreshTree();
  $("ex-collapse").onclick = collapseAll;
  $("open-folder").onclick = hooks.onOpenFolder;
  $("open-folder-2").onclick = hooks.onOpenFolder;
}
