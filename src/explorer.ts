import { invoke } from "@tauri-apps/api/core";
import "./explorer-a11y.css";
import { dirtyDocs, findOpenDoc, isDirty, onDocsChange } from "./docs";
import { decorate, refreshGit } from "./git";
import { explorerKey } from "./explorerNavigation";
import { FILE_MIME, openFile, removePaths, renamePaths, splitGroup } from "./groups";
import { fileIcon, folderIcon } from "./icons";
import { promptText, setStatus, showDialog, showMenu, type MenuItem } from "./ui";
import { $, baseName, dirName, fileKey, h } from "./util";
import { rel, ws } from "./workspace";

interface Entry { name: string; path: string; is_dir: boolean }

const expanded = new Set<string>();
let selected: string | null = null;
let treeGeneration = 0;
let nextNodeId = 0;
const dirGeneration = new WeakMap<HTMLElement, number>();

const gitLabels: Record<string, string> = { "git-M": "modificado en Git", "git-R": "renombrado en Git", "git-U": "sin seguimiento en Git", "git-A": "añadido en Git", "git-D": "eliminado en Git", "git-C": "conflicto de Git", "git-I": "ignorado por Git" };

function updateNodeLabel(node: HTMLElement, dirtyKeys?: Set<string>) {
  const path = node.dataset.path!;
  const doc = dirtyKeys ? undefined : findOpenDoc(path);
  const label = [node.classList.contains("dir") ? "Carpeta" : "Archivo", baseName(path)].join(" ");
  const dirty = dirtyKeys ? dirtyKeys.has(fileKey(path)) : !!doc && isDirty(doc);
  const suffix = [dirty ? "cambios sin guardar" : "", gitLabels[decorate(path, node.classList.contains("dir"))?.cls ?? ""] ?? ""].filter(Boolean);
  const text = suffix.length ? `${label}, ${suffix.join(", ")}` : label;
  if (node.getAttribute("aria-label") !== text) node.setAttribute("aria-label", text);
}

function findNode(tree: HTMLElement, path: string | null): HTMLElement | null {
  return path ? tree.querySelector<HTMLElement>(`.node[data-path="${CSS.escape(path)}"]`) : null;
}

/** Mantiene el foco en el árbol y señala el elemento activo para tecnologías de asistencia. */
function selectNode(tree: HTMLElement, node: HTMLElement | null, scroll = false) {
  tree.querySelectorAll<HTMLElement>(".node.sel").forEach((old) => { old.classList.remove("sel"); old.setAttribute("aria-selected", "false"); });
  if (!node) { tree.removeAttribute("aria-activedescendant"); return; }
  selected = node.dataset.path ?? null;
  node.classList.add("sel");
  node.setAttribute("aria-selected", "true");
  updateNodeLabel(node);
  tree.setAttribute("aria-activedescendant", node.id);
  if (scroll) node.scrollIntoView({ block: "nearest" });
}

function syncSelection(tree: HTMLElement, chooseVisible: boolean) {
  let path = selected;
  let node = findNode(tree, path);
  while (!node && chooseVisible && path && ws.root && path !== ws.root) {
    path = dirName(path);
    node = findNode(tree, path);
  }
  if (!node && chooseVisible) node = tree.querySelector<HTMLElement>(".node");
  selectNode(tree, node);
}

export function resetExplorer() {
  treeGeneration++;
  expanded.clear();
  selected = null;
  $("tree").removeAttribute("aria-activedescendant");
}

// ---------- Dibujo del árbol ----------
async function renderDir(path: string, into: HTMLElement) {
  const entries = await invoke<Entry[]>("list_dir", { path });
  const dirtyKeys = new Set(dirtyDocs().map((doc) => fileKey(doc.path)));
  const children: Promise<void>[] = [];
  for (const e of entries) {
    const open = e.is_dir && expanded.has(e.path);
    const node = h("div", "node" + (e.is_dir ? " dir" : "") + (open ? " open" : "") + (e.path === selected ? " sel" : ""));
    node.dataset.path = e.path;
    node.id = `explorer-item-${++nextNodeId}`;
    node.setAttribute("role", "treeitem");
    node.setAttribute("aria-level", String(Math.max(1, rel(e.path).split("/").filter(Boolean).length)));
    node.setAttribute("aria-selected", String(e.path === selected));
    if (e.is_dir) node.setAttribute("aria-expanded", String(open));
    node.draggable = true;
    node.append(h("span", "chev"), e.is_dir ? folderIcon(e.name, open) : fileIcon(e.name), h("span", "name", e.name));
    const dec = decorate(e.path, e.is_dir);
    if (dec) {
      node.classList.add(dec.cls);
      if (dec.badge) node.append(h("span", "gitdec", dec.badge));
    }
    updateNodeLabel(node, dirtyKeys);
    into.append(node);
    if (e.is_dir) {
      const kids = h("div", "children");
      kids.id = `${node.id}-children`;
      kids.setAttribute("role", "group");
      node.setAttribute("aria-owns", kids.id);
      into.append(kids);
      if (open) children.push(renderDir(e.path, kids));
    }
  }
  await Promise.all(children);
}

function repaintGit(tree: HTMLElement) {
  const dirtyKeys = new Set(dirtyDocs().map((doc) => fileKey(doc.path)));
  tree.querySelectorAll<HTMLElement>(".node").forEach((node) => {
    for (const cls of Array.from(node.classList)) if (cls.startsWith("git-")) node.classList.remove(cls);
    node.querySelector(".gitdec")?.remove();
    const dec = decorate(node.dataset.path!, node.classList.contains("dir"));
    if (dec) { node.classList.add(dec.cls); if (dec.badge) node.append(h("span", "gitdec", dec.badge)); }
    updateNodeLabel(node, dirtyKeys);
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
  syncSelection(tree, document.activeElement === tree);
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
  selectNode(tree, findNode(tree, selected));
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
  node.setAttribute("aria-expanded", String(open));
  node.querySelector(".ficon")?.replaceWith(folderIcon(baseName(path), open));
  kids.replaceChildren();
  if (open) {
    node.setAttribute("aria-busy", "true");
    try {
      const next = h("div");
      await renderDir(path, next);
      if (dirGeneration.get(node) === id && expanded.has(path)) kids.replaceChildren(...Array.from(next.childNodes));
    } catch (e) { if (dirGeneration.get(node) === id) setStatus(`No se pudo leer la carpeta: ${e}`); }
    finally { if (dirGeneration.get(node) === id) node.removeAttribute("aria-busy"); }
  } else {
    node.removeAttribute("aria-busy");
  }
}

let onSearchIn: (path: string) => void = () => {};
let onOpenTerminal: (dir: string) => void = () => {};

export function initExplorer(hooks: { onOpenFolder: () => void; onSearchIn: (path: string) => void; onOpenTerminal: (dir: string) => void }) {
  onSearchIn = hooks.onSearchIn;
  onOpenTerminal = hooks.onOpenTerminal;
  const tree = $("tree");
  tree.tabIndex = 0;
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Explorador de archivos");
  for (const [id, label] of [
    ["ex-new-file", "Nuevo archivo"], ["ex-new-folder", "Nueva carpeta"],
    ["ex-refresh", "Actualizar explorador"], ["ex-collapse", "Contraer todas las carpetas"],
    ["open-folder", "Abrir carpeta"],
  ]) $(id).setAttribute("aria-label", label);
  tree.addEventListener("focus", () => syncSelection(tree, true));
  onDocsChange(() => { const node = findNode(tree, selected); if (node) updateNodeLabel(node); });
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
    if (e.target !== tree || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (selected && e.key === "F2") { e.preventDefault(); void renameEntry(selected); return; }
    if (selected && e.key === "Delete") { e.preventDefault(); void deleteEntry(selected); return; }
    const nodes = Array.from(tree.querySelectorAll<HTMLElement>(".node"));
    const action = explorerKey(nodes.map((node) => ({ path: node.dataset.path!, isDir: node.classList.contains("dir"), expanded: node.classList.contains("open") })), selected, e.key);
    if (!action) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", " "].includes(e.key)) e.preventDefault();
      return;
    }
    e.preventDefault();
    const node = findNode(tree, action.path);
    if (!node) return;
    if (action.kind === "select") selectNode(tree, node, true);
    else if (action.kind === "open") void openFile(action.path);
    else void toggleDir(node);
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

  const folderName = $("folder-name");
  folderName.tabIndex = 0;
  folderName.setAttribute("role", "button");
  folderName.setAttribute("aria-controls", "tree");
  folderName.setAttribute("aria-expanded", "true");
  const toggleRoot = () => {
    const collapsed = $("tree").classList.toggle("collapsed");
    folderName.classList.toggle("closed", collapsed);
    folderName.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed && document.activeElement === tree) folderName.focus();
  };
  folderName.onclick = toggleRoot;
  folderName.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRoot(); } };
  $("ex-new-file").onclick = () => void newEntry("file");
  $("ex-new-folder").onclick = () => void newEntry("folder");
  $("ex-refresh").onclick = () => void refreshTree();
  $("ex-collapse").onclick = collapseAll;
  $("open-folder").onclick = hooks.onOpenFolder;
  $("open-folder-2").onclick = hooks.onOpenFolder;
}
