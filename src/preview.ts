import { t as tr } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { linkTarget, parseInline, parseMarkdown } from "./aiMarkdown";
import { docs } from "./docs";
import { openExternal } from "./external";
import { setStatus } from "./ui";
import { $, baseName, h } from "./util";
import { rel } from "./workspace";
import "./preview.css";

const BINARY_IMAGE_RE = /\.(png|jpe?g|webp|gif|ico|bmp)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg|ico|bmp)$/i;
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;

export const isBinaryImageFile = (path: string) => BINARY_IMAGE_RE.test(path);
export const isImageFile = (path: string) => IMAGE_RE.test(path);
export const isMarkdownFile = (path: string) => MARKDOWN_RE.test(path);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

let token = 0;

function rootEl(): HTMLElement {
  return $("preview-view");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !document.querySelector(".modal")) {
    e.preventDefault();
    e.stopPropagation();
    closePreview();
  }
}

export function closePreview() {
  token++;
  const root = document.getElementById("preview-view");
  if (root) {
    root.hidden = true;
    root.replaceChildren();
  }
  window.removeEventListener("keydown", onKey, true);
}

function makeHeader(title: string, sub: string, extra: HTMLElement[] = []): HTMLElement {
  const head = h("div", "prev-head");
  head.append(h("span", "prev-title", title), h("span", "prev-sub", sub), h("span", "grow"), ...extra);
  const close = h("button", "icon-btn prev-close");
  close.type = "button";
  close.title = tr("Cerrar (Esc)");
  close.setAttribute("aria-label", tr("Cerrar"));
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closePreview;
  head.append(close);
  return head;
}

export async function openImagePreview(path: string) {
  closePreview();
  const mine = ++token;
  const root = rootEl();
  root.hidden = false;
  window.addEventListener("keydown", onKey, true);

  let zoom = 1;
  const info = h("span", "prev-meta", "");
  const zoomOut = h("button", "diff-btn", "−");
  const zoomReset = h("button", "diff-btn", "100%");
  const zoomIn = h("button", "diff-btn", "+");
  zoomOut.type = zoomReset.type = zoomIn.type = "button";

  const head = makeHeader(baseName(path), rel(path), [info, zoomOut, zoomReset, zoomIn]);
  const body = h("div", "prev-body prev-img-body");
  body.append(h("div", "prev-msg", tr("Cargando imagen…")));
  root.replaceChildren(head, body);

  try {
    const res = await invoke<{ data_url: string; bytes: number; mime: string }>("read_image_file", { path });
    if (mine !== token) return;
    const img = document.createElement("img");
    img.className = "prev-img";
    img.src = res.data_url;
    img.alt = baseName(path);
    img.draggable = false;
    const applyZoom = () => {
      img.style.transform = `scale(${zoom})`;
      zoomReset.textContent = `${Math.round(zoom * 100)}%`;
    };
    zoomOut.onclick = () => {
      zoom = Math.max(0.25, +(zoom - 0.25).toFixed(2));
      applyZoom();
    };
    zoomIn.onclick = () => {
      zoom = Math.min(4, +(zoom + 0.25).toFixed(2));
      applyZoom();
    };
    zoomReset.onclick = () => {
      zoom = 1;
      applyZoom();
    };
    img.onload = () => {
      info.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${formatBytes(res.bytes)}`;
    };
    const stage = h("div", "prev-img-stage");
    stage.append(img);
    body.replaceChildren(stage);
  } catch (e) {
    if (mine !== token) return;
    body.replaceChildren(h("div", "prev-msg", tr("No se pudo cargar la imagen: {error}", { error: String(e) })));
  }
}

function renderInline(parent: HTMLElement, text: string) {
  for (const p of parseInline(text)) {
    if (p.kind === "code") parent.append(h("code", "prev-icode", p.text));
    else if (p.kind === "bold") parent.append(h("strong", "", p.text));
    else if (p.kind === "link") {
      const target = linkTarget(p.href ?? "");
      if (target?.kind === "web") {
        const a = h("a", "prev-link", p.text);
        a.href = target.url;
        a.rel = "noreferrer";
        a.onclick = (e) => {
          e.preventDefault();
          void openExternal(target.url);
        };
        parent.append(a);
      } else {
        parent.append(document.createTextNode(p.text));
      }
    } else {
      parent.append(document.createTextNode(p.text));
    }
  }
}

export async function openMarkdownPreview(path: string) {
  closePreview();
  const mine = ++token;
  const root = rootEl();
  root.hidden = false;
  window.addEventListener("keydown", onKey, true);

  const editBtn = h("button", "diff-btn", tr("Volver al editor"));
  editBtn.type = "button";
  editBtn.onclick = closePreview;
  const head = makeHeader(baseName(path), rel(path), [editBtn]);
  const body = h("div", "prev-body prev-md-body");
  root.replaceChildren(head, body);

  let text = docs.get(path)?.model.getValue();
  if (text === undefined) {
    try {
      const res = await invoke<{ contents: string }>("read_file", { path });
      if (mine !== token) return;
      text = res.contents;
    } catch (e) {
      if (mine !== token) return;
      body.replaceChildren(h("div", "prev-msg", tr("No se pudo leer el archivo: {error}", { error: String(e) })));
      return;
    }
  }

  const doc = h("article", "prev-md");
  for (const b of parseMarkdown(text)) {
    if (b.type === "code") {
      const pre = h("pre", "prev-code");
      if (b.lang) pre.append(h("div", "prev-code-lang", b.lang));
      pre.append(h("code", "", b.text));
      doc.append(pre);
    } else if (b.type === "h") {
      const el = h(`h${Math.min(4, Math.max(1, b.level))}` as "h1" | "h2" | "h3" | "h4", "prev-h");
      renderInline(el, b.text);
      doc.append(el);
    } else if (b.type === "li") {
      const row = h("div", "prev-li");
      row.append(h("span", "prev-li-mark", b.marker));
      const span = h("span", "");
      renderInline(span, b.text);
      row.append(span);
      doc.append(row);
    } else {
      const p = h("p", "prev-p");
      renderInline(p, b.text);
      doc.append(p);
    }
  }
  body.replaceChildren(doc);
}

export async function openPreviewFor(path: string | null) {
  if (!path) {
    setStatus(tr("Abre un archivo Markdown o una imagen para previsualizar"));
    return;
  }
  if (isImageFile(path)) {
    await openImagePreview(path);
    return;
  }
  if (isMarkdownFile(path)) {
    await openMarkdownPreview(path);
    return;
  }
  setStatus(tr("La vista previa solo está disponible para Markdown e imágenes"));
}
