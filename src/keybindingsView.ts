import { t } from "./i18n";
import { captureKey, commands, keyOf, type Command } from "./commands";
import {
  RESERVED, assignKey, duplicatedKeys, findConflicts, groupByCategory, isCustom, keyParts, matches, reservedFor, resetKey, splitLabel,
} from "./keybindings";
import { commit, state } from "./settings";
import { showDialog } from "./ui";
import { h } from "./util";

const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
const ICON_CLEAR = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_RESET = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5"/></svg>';

const chips = (key: string) => {
  const box = h("span", "kb-chips");
  for (const p of keyParts(key)) box.append(h("kbd", "", p));
  return box;
};

function iconBtn(svg: string, title: string, onClick: () => void) {
  const b = h("button", "icon-btn kb-btn");
  b.innerHTML = svg;
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

/** Módulo de atajos de teclado: tabla con búsqueda, grabación de combinaciones y avisos de conflicto. */
export function buildKeybindings() {
  const root = h("div", "kb");
  let query = "";
  let onlyCustom = false;
  let byKey: string | null = null;
  let recording: string | null = null;
  let waitingFilterKey = false;

  // ---------- Barra superior ----------
  const bar = h("div", "kb-bar");
  const search = h("input", "kb-search");
  search.id = "kb-search";
  search.type = "text";
  search.placeholder = t("Buscar un comando o una tecla…");
  search.spellcheck = false;
  const byKeyBtn = h("button", "kb-chip", t("Buscar por tecla"));
  byKeyBtn.id = "kb-bykey";
  byKeyBtn.title = t("Pulsa una combinación para ver qué comando la usa");
  const customBtn = h("button", "kb-chip", t("Solo personalizados"));
  customBtn.id = "kb-custom";
  const resetAll = h("button", "mbtn danger kb-resetall", t("Restablecer todos"));
  resetAll.id = "kb-resetall";
  bar.append(search, byKeyBtn, customBtn, resetAll);

  const count = h("div", "kb-count");
  const list = h("div", "kb-list");
  root.append(bar, count, list);

  // ---------- Asignar ----------
  async function apply(cmd: Command, key: string) {
    const name = splitLabel(cmd.label).name;
    if (key) {
      const reserved = reservedFor(key);
      if (reserved) {
        const r = await showDialog({
          title: t("Tecla reservada del editor"),
          message: t("{key} sirve en el editor para {action}. Si se la asignas a «{command}», dejará de funcionar para eso dentro del editor.", { key, action: reserved, command: name }),
          buttons: [{ label: t("Cancelar"), value: "cancel" }, { label: t("Asignar de todos modos"), value: "ok", danger: true }],
        });
        if (r !== "ok") return;
      }
      const conflicts = findConflicts(commands, state.settings.keybindings, cmd.id, key);
      if (conflicts.length) {
        const names = conflicts.map((c) => `«${splitLabel(c.label).name}»`).join(", ");
        const r = await showDialog({
          title: t("Atajo en uso"),
          message: t("{key} ya lo usa {commands}. Si lo reasignas a «{command}», ese comando se quedará sin atajo.", { key, commands: names, command: name }),
          buttons: [{ label: t("Cancelar"), value: "cancel" }, { label: t("Reasignar"), value: "ok", primary: true }],
        });
        if (r !== "ok") return;
      }
    }
    state.settings.keybindings = assignKey(commands, state.settings.keybindings, cmd.id, key);
    commit();
  }

  function record(cmd: Command) {
    recording = cmd.id;
    render();
    captureKey((k) => {
      recording = null;
      if (k === null) { render(); return; }
      void apply(cmd, k).then(render);
    });
  }

  // ---------- Dibujo ----------
  function row(cmd: Command, dup: Set<string>): HTMLElement {
    const key = keyOf(cmd);
    const custom = isCustom(state.settings.keybindings, cmd.id);
    const r = h("div", "kb-row" + (custom ? " custom" : "") + (recording === cmd.id ? " rec" : "") + (key && dup.has(key) ? " dup" : ""));
    r.dataset.cmd = cmd.id;
    const name = h("div", "kb-name");
    name.append(h("span", "kb-label", splitLabel(cmd.label).name));
    if (custom) name.append(h("span", "kb-tag", "personalizado"));
    if (key && dup.has(key)) name.append(h("span", "kb-warn", "repetido"));
    const cell = h("div", "kb-key");
    if (recording === cmd.id) cell.append(h("span", "kb-rec", t("Pulsa la combinación…  (Esc cancela, ⌫ quita)")));
    else if (key) cell.append(chips(key));
    else cell.append(h("span", "kb-none", t("Sin atajo")));
    cell.title = t("Clic para cambiar el atajo");
    cell.onclick = () => record(cmd);
    const actions = h("div", "kb-actions");
    actions.append(iconBtn(ICON_EDIT, t("Cambiar el atajo"), () => record(cmd)));
    if (key) actions.append(iconBtn(ICON_CLEAR, t("Quitar el atajo"), () => { void apply(cmd, "").then(render); }));
    if (custom) actions.append(iconBtn(ICON_RESET, t("Volver al atajo de fábrica"), () => { state.settings.keybindings = resetKey(state.settings.keybindings, cmd.id); commit(); render(); }));
    r.append(name, cell, actions);
    return r;
  }

  function render() {
    const o = state.settings.keybindings;
    list.replaceChildren();
    const shown = commands.filter((c) => (!onlyCustom || isCustom(o, c.id)) && (byKey ? keyOf(c) === byKey : matches(c, o, query)));
    const dup = new Set(duplicatedKeys(commands, o).keys());
    for (const g of groupByCategory(shown)) {
      list.append(h("div", "kb-cat", g.category));
      for (const c of g.items) list.append(row(c, dup));
    }
    if (!shown.length) list.append(h("div", "kb-empty", byKey ? t("Ningún comando usa {key}", { key: byKey }) : t("No hay comandos que coincidan")));

    // Teclas fijas del editor, solo de consulta.
    if (!onlyCustom && !byKey && !query.trim()) {
      list.append(h("div", "kb-cat", t("Del editor (fijas)")));
      for (const [key, what] of Object.entries(RESERVED)) {
        const r = h("div", "kb-row fixed");
        r.append(h("div", "kb-name", what[0].toUpperCase() + what.slice(1)), h("div", "kb-key"), h("div", "kb-actions"));
        r.children[1].append(chips(key));
        list.append(r);
      }
    }

    count.textContent = t("{shown} de {total} comandos", { shown: shown.length, total: commands.length }) + (Object.keys(o).length ? " · " + t("{count} personalizado(s)", { count: Object.keys(o).length }) : "");
    customBtn.classList.toggle("on", onlyCustom);
    byKeyBtn.classList.toggle("on", byKey !== null || waitingFilterKey);
    byKeyBtn.textContent = waitingFilterKey ? t("Pulsa una combinación…") : byKey ? t("Tecla: {key}", { key: byKey }) + "  ×" : t("Buscar por tecla");
    resetAll.disabled = Object.keys(o).length === 0;
  }

  // ---------- Eventos ----------
  search.oninput = () => { query = search.value; byKey = null; render(); };
  customBtn.onclick = () => { onlyCustom = !onlyCustom; render(); };
  byKeyBtn.onclick = () => {
    if (byKey !== null) { byKey = null; render(); return; }
    waitingFilterKey = true;
    render();
    captureKey((k) => { waitingFilterKey = false; if (k) byKey = k; render(); });
  };
  resetAll.onclick = async () => {
    const r = await showDialog({
      title: t("Restablecer los atajos"),
      message: t("Todos los comandos volverán a su atajo de fábrica."),
      buttons: [{ label: t("Cancelar"), value: "cancel" }, { label: t("Restablecer"), value: "ok", danger: true }],
    });
    if (r !== "ok") return;
    state.settings.keybindings = {};
    commit();
    render();
  };

  return {
    el: root,
    sync: render,
    /** Filtra desde el buscador general de la configuración. */
    setFilter(q: string) { query = q; search.value = q; byKey = null; render(); },
    isRecording: () => recording !== null || waitingFilterKey,
  };
}
