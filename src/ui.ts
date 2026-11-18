import { $, h, inp } from "./util";

/** Funciones que otros módulos inyectan para evitar dependencias circulares. */
export const hooks = { focusEditor: () => {} };

let modals = 0;
/** True mientras haya un diálogo o la paleta abiertos (los atajos se pausan). */
export const overlayOpen = () => modals > 0 || !$("quickopen").hidden;

/** Marca que hay una superposición propia abierta (los atajos globales se pausan). */
export function trackOverlay(): () => void {
  modals++;
  let done = false;
  return () => { if (!done) { done = true; modals--; } };
}

// ---------- Barra de estado ----------
let defaultStatus = "Listo";
let statusTimer = 0;

export function setDefaultStatus(text: string) {
  defaultStatus = text;
  if (!statusTimer) $("status-left").textContent = text;
}

export function setStatus(text: string, ms = 5000) {
  $("status-left").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusTimer = 0;
    $("status-left").textContent = defaultStatus;
  }, ms);
}

// ---------- Diálogos ----------
export interface DialogButton { label: string; value: string; primary?: boolean; danger?: boolean }

function openModal(box: HTMLElement, onCancel: () => void): () => void {
  modals++;
  const back = h("div", "modal-back");
  back.append(box);
  document.body.append(back);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  document.addEventListener("keydown", onKey, true);
  return () => {
    modals--;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
}

/** Diálogo con botones; resuelve con el `value` del botón o "cancel" con Esc. */
export function showDialog(o: { title: string; message?: string; buttons: DialogButton[] }): Promise<string> {
  return new Promise((resolve) => {
    const box = h("div", "modal");
    box.append(h("div", "modal-title", o.title));
    if (o.message) box.append(h("div", "modal-msg", o.message));
    const row = h("div", "modal-btns");
    let close = () => {};
    const done = (v: string) => { close(); resolve(v); };
    for (const b of o.buttons) {
      const btn = h("button", "mbtn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""), b.label);
      btn.onclick = () => done(b.value);
      row.append(btn);
    }
    box.append(row);
    close = openModal(box, () => done("cancel"));
    (row.querySelector<HTMLElement>(".primary") ?? row.querySelector<HTMLElement>("button"))?.focus();
  });
}

/** Pide un texto; devuelve null si se cancela. */
export function promptText(o: {
  title: string;
  value?: string;
  placeholder?: string;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const box = h("div", "modal");
    box.append(h("div", "modal-title", o.title));
    const input = h("input", "modal-input");
    input.type = "text";
    input.value = o.value ?? "";
    input.placeholder = o.placeholder ?? "";
    input.spellcheck = false;
    const err = h("div", "modal-err");
    const row = h("div", "modal-btns");
    const cancel = h("button", "mbtn", "Cancelar");
    const ok = h("button", "mbtn primary", "Aceptar");
    row.append(cancel, ok);
    box.append(input, err, row);
    let close = () => {};
    const done = (v: string | null) => { close(); resolve(v); };
    const submit = () => {
      const v = input.value.trim();
      const msg = o.validate ? o.validate(v) : v ? null : "Escribe un nombre";
      if (msg) { err.textContent = msg; return; }
      done(v);
    };
    cancel.onclick = () => done(null);
    ok.onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    input.oninput = () => { err.textContent = ""; };
    close = openModal(box, () => done(null));
    input.focus();
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  });
}

export interface FormField { key: string; label: string; value?: string; multiline?: boolean; placeholder?: string; required?: boolean }

/** Formulario con varios campos; devuelve los valores (sin espacios en los extremos) o null si se cancela. */
export function showForm(o: { title: string; fields: FormField[]; submitLabel?: string; hint?: string }): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const box = h("div", "modal modal-form");
    box.append(h("div", "modal-title", o.title));
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    for (const f of o.fields) {
      const wrap = h("label", "form-field");
      wrap.append(h("span", "form-label", f.label + (f.required ? " *" : "")));
      const input = f.multiline ? h("textarea", "modal-input form-area") : h("input", "modal-input");
      if (input instanceof HTMLInputElement) input.type = "text";
      if (input instanceof HTMLTextAreaElement) input.rows = 6;
      input.value = f.value ?? "";
      input.placeholder = f.placeholder ?? "";
      input.spellcheck = false;
      wrap.append(input);
      box.append(wrap);
      inputs.set(f.key, input);
    }
    if (o.hint) box.append(h("div", "form-hint", o.hint));
    const err = h("div", "modal-err");
    const row = h("div", "modal-btns");
    const cancel = h("button", "mbtn", "Cancelar");
    const ok = h("button", "mbtn primary", o.submitLabel ?? "Aceptar");
    row.append(cancel, ok);
    box.append(err, row);
    let close = () => {};
    const done = (v: Record<string, string> | null) => { close(); resolve(v); };
    const submit = () => {
      const values: Record<string, string> = {};
      for (const f of o.fields) {
        const v = inputs.get(f.key)!.value.trim();
        if (f.required && !v) { err.textContent = `Escribe ${f.label.toLowerCase()}`; inputs.get(f.key)!.focus(); return; }
        values[f.key] = v;
      }
      done(values);
    };
    cancel.onclick = () => done(null);
    ok.onclick = submit;
    for (const input of inputs.values()) {
      input.oninput = () => { err.textContent = ""; };
      input.onkeydown = (e) => {
        const multiline = input instanceof HTMLTextAreaElement;
        if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      };
    }
    close = openModal(box, () => done(null));
    inputs.values().next().value?.focus();
  });
}

// ---------- Menú contextual ----------
export type MenuItem =
  | { label: string; hint?: string; run: () => void; danger?: boolean; disabled?: boolean }
  | "sep";

let closeMenu = () => {};

/** Cierra el menú contextual abierto, si hay alguno. */
export const closeContextMenu = () => closeMenu();

export function showMenu(x: number, y: number, items: MenuItem[], opts: { onClose?: () => void } = {}) {
  closeMenu();
  const menu = h("div", "ctxmenu");
  for (const it of items) {
    if (it === "sep") { menu.append(h("div", "ctx-sep")); continue; }
    const row = h("div", "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : ""));
    row.append(h("span", "", it.label));
    if (it.hint) row.append(h("kbd", "", it.hint));
    if (!it.disabled) {
      row.onclick = () => { closeMenu(); it.run(); };
    }
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  const onDown = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) closeMenu(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
  closeMenu = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", closeMenu);
    closeMenu = () => {};
    opts.onClose?.();
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu);
}

// ---------- Selector rápido (archivos, comandos, temas…) ----------
export interface PickItem {
  label: string;
  detail?: string;
  hint?: string;
  icon?: HTMLElement;
  /** Se ejecuta al resaltar la opción (vista previa) sin confirmarla. */
  preview?: () => void;
  /** La opción que está en uso: la lista empieza resaltándola. */
  current?: boolean;
  /** Palabras extra para encontrarla (la primera pesa más), p. ej. "theme tema color". */
  keywords?: string;
  run: () => void | Promise<void>;
}

export function score(q: string, it: PickItem): number {
  const label = it.label.toLowerCase();
  const kw = (it.keywords ?? "").toLowerCase();
  const text = ((it.detail ? it.detail + "/" : "") + it.label + (kw ? " " + kw : "")).toLowerCase();
  let s = 0, pos = -1, prev = -2;
  for (const ch of q) {
    const idx = text.indexOf(ch, pos + 1);
    if (idx < 0) return -1;
    s += idx === prev + 1 ? 5 : 1;
    pos = prev = idx;
  }
  if (label.includes(q)) s += 40;
  if (label.startsWith(q)) s += 20;
  if (kw && kw.split(" ")[0].startsWith(q)) s += 45;
  return s - text.length * 0.05;
}

export function quickPick(o: {
  placeholder: string;
  load: () => Promise<PickItem[]> | PickItem[];
  empty?: string;
  /** Se llama si se cierra sin elegir (para deshacer la vista previa). */
  onCancel?: () => void;
}) {
  const root = $("quickopen");
  const input = inp("qo-input");
  const list = $("qo-list");
  root.hidden = false;
  input.value = "";
  input.placeholder = o.placeholder;
  input.focus();
  list.replaceChildren(h("li", "none", "Cargando…"));

  let items: PickItem[] = [];
  let shown: PickItem[] = [];
  let index = 0;
  let closed = false;

  const close = (refocus: boolean) => {
    if (closed) return;
    closed = true;
    root.hidden = true;
    input.oninput = null;
    input.onkeydown = null;
    root.onmousedown = null;
    if (refocus) { o.onCancel?.(); hooks.focusEditor(); }
  };

  const paint = (preview = false) => {
    list.replaceChildren();
    if (!shown.length) { list.append(h("li", "none", items.length ? "Sin resultados" : o.empty ?? "Sin resultados")); return; }
    shown.forEach((it, i) => {
      const li = h("li", i === index ? "on" : "");
      if (it.icon) li.append(it.icon);
      li.append(h("span", "qo-label", it.label));
      if (it.detail) li.append(h("span", "qo-dir", it.detail));
      if (it.hint) li.append(h("kbd", "qo-hint", it.hint));
      li.onclick = () => pickAt(i);
      list.append(li);
    });
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    if (preview) shown[index]?.preview?.();
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    shown = (q
      ? items.map((it) => ({ it, s: score(q, it) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.it)
      : items
    ).slice(0, 60);
    index = q ? 0 : Math.max(0, shown.findIndex((it) => it.current));
    paint(!!q);
  };

  const pickAt = (i: number) => {
    const it = shown[i];
    if (!it) return;
    close(false);
    void it.run();
  };

  input.oninput = filter;
  input.onkeydown = (e) => {
    if (e.key === "Escape") close(true);
    else if (e.key === "ArrowDown") { e.preventDefault(); index = Math.min(shown.length - 1, index + 1); paint(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); index = Math.max(0, index - 1); paint(true); }
    else if (e.key === "Enter") { e.preventDefault(); pickAt(index); }
  };
  root.onmousedown = (e) => { if (e.target === root) close(true); };

  void Promise.resolve(o.load()).then((loaded) => {
    if (closed) return;
    items = loaded;
    filter();
  });
}
