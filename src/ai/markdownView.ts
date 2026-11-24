/** Pintado de las respuestas: Markdown, enlaces, copiar e insertar código en el editor. */
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { linkTarget, parseInline, parseMarkdown } from "../aiMarkdown";
import { focusedEditor, openFile } from "../groups";
import { setStatus } from "../ui";
import { h } from "../util";

let leaveFullscreen: () => void = () => {};
/** El panel registra aquí cómo salir de la pantalla completa, para no depender del estado del panel. */
export function setLeaveFullscreenHook(fn: () => void) { leaveFullscreen = fn; }

export function copy(text: string, btn?: HTMLButtonElement) {
  void navigator.clipboard.writeText(text).then(() => {
    setStatus(tr("Copiado"), 2000);
    if (!btn) return;
    const prev = btn.textContent ?? tr("Copiar");
    btn.textContent = tr("Copiado");
    btn.classList.add("copied");
    window.setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
  }, () => setStatus(tr("No se pudo copiar")));
}

export function insertCode(text: string) {
  const ed = focusedEditor();
  const sel = ed?.getSelection();
  if (!ed || !sel) { setStatus(tr("Abre un archivo en el editor para insertar el código")); return; }
  leaveFullscreen();
  ed.executeEdits("pulso-ai", [{ range: sel, text, forceMoveMarkers: true }]);
  ed.focus();
  setStatus(tr("Código insertado en el editor"), 2500);
}

/** Enlace de una respuesta: los archivos se abren en el editor en su línea; las páginas, en el navegador. */
export function linkNode(text: string, href: string): Node {
  const target = linkTarget(href);
  if (!target) return document.createTextNode(text);
  const b = h("button", "ai-link", text);
  b.type = "button";
  b.title = target.kind === "file" ? (target.line > 1 ? tr("Abrir {path} en la línea {line}", { path: target.path, line: target.line }) : tr("Abrir {path}", { path: target.path })) : target.url;
  b.onclick = () => {
    if (target.kind === "web") { void invoke("open_external", { url: target.url }).catch((e) => setStatus(String(e))); return; }
    leaveFullscreen();
    void openFile(target.path, { line: target.line, col: 1 });
  };
  return b;
}

export function inline(parent: HTMLElement, text: string) {
  for (const p of parseInline(text)) {
    if (p.kind === "code") parent.append(h("code", "ai-icode", p.text));
    else if (p.kind === "bold") parent.append(h("strong", "", p.text));
    else if (p.kind === "link") parent.append(linkNode(p.text, p.href ?? ""));
    else parent.append(document.createTextNode(p.text));
  }
}

export function markdown(text: string): HTMLElement[] {
  return parseMarkdown(text).map((b) => {
    if (b.type === "code") {
      const box = h("div", "ai-code");
      const head = h("div", "ai-code-head");
      head.append(h("span", "", b.lang || "código"));
      const acts = h("div", "ai-code-acts");
      if (focusedEditor()) {
        const ins = h("button", "ai-code-copy", tr("Insertar"));
        ins.type = "button";
        ins.title = tr("Insertar en la posición actual del editor");
        ins.onclick = () => insertCode(b.text);
        acts.append(ins);
      }
      const c = h("button", "ai-code-copy", tr("Copiar"));
      c.type = "button";
      c.onclick = () => copy(b.text, c);
      acts.append(c);
      head.append(acts);
      const pre = h("pre", "");
      pre.append(h("code", "", b.text));
      box.append(head, pre);
      return box;
    }
    if (b.type === "h") { const e = h("div", `ai-h ai-h${b.level}`); inline(e, b.text); return e; }
    if (b.type === "li") { const e = h("div", "ai-li"); e.append(h("span", "ai-li-m", b.marker)); const t = h("span", "ai-li-t"); inline(t, b.text); e.append(t); return e; }
    const p = h("p", "ai-p");
    inline(p, b.text);
    return p;
  });
}
