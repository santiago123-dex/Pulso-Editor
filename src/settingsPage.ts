import { commands } from "./commands";
import { t } from "./i18n";
import { disconnectGithub, getAccount, hasToken, refreshAccount, setToken } from "./github";
import { connectFlow } from "./githubConnect";
import { buildKeybindings } from "./keybindingsView";
import { ACCENTS, DEFAULTS, FONTS, commit, currentTheme, setTheme, state, syntaxOptionsFor, type Settings } from "./settings";
import { adaptToMyTerminal, listShells } from "./terminal";
import { detectPrefs, schemeOptions, type Detected } from "./terminalPrefs";
import { openThemeGallery } from "./themeGallery";
import { importFromFile, importInstalled } from "./themeImport";
import { setStatus, showDialog } from "./ui";
import { $, h } from "./util";

type BoolKey = "ligatures" | "minimap" | "wordWrap" | "lineNumbers" | "whitespace" | "smoothCaret" | "autoSave" | "formatOnSave" | "inlineAiEnabled";

interface Section { id: string; title: string; desc: string; icon: string; el: HTMLElement; rows: HTMLElement[] }

const ICONS: Record<string, string> = {
  appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.4-2.2-.6-1.2.2-2.3 1.5-2.3H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  editor: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  github: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

let page: HTMLElement;
let content: HTMLElement;
let search: HTMLInputElement;
let nav: HTMLElement;
const sections: Section[] = [];
const syncers: (() => void)[] = [];
let activeId = "appearance";
let detected: Detected | null = null;
let kb: ReturnType<typeof buildKeybindings>;

const sync = () => syncers.forEach((f) => f());
export const syncSettingsUI = () => { if (page) sync(); };

// ---------- Piezas ----------
function row(label: string, desc: string, control: HTMLElement | HTMLElement[], extra = ""): HTMLElement {
  const r = h("div", "sp-row");
  const left = h("div", "sp-info");
  left.append(h("div", "sp-label", label));
  if (desc) left.append(h("div", "sp-desc", desc));
  const right = h("div", "sp-ctl");
  right.append(...(Array.isArray(control) ? control : [control]));
  r.append(left, right);
  r.dataset.q = `${label} ${desc} ${extra}`.toLowerCase();
  return r;
}

function selectCtl(id: string, options: () => [string, string][], get: () => string, set: (v: string) => void): HTMLSelectElement {
  const s = h("select", "sp-select");
  s.id = id;
  const fill = () => {
    s.replaceChildren(...options().map(([v, l]) => new Option(l, v)));
    s.value = get();
    if (s.value !== get()) s.value = options()[0]?.[0] ?? "";
  };
  s.onchange = () => { set(s.value); commit(); };
  syncers.push(fill);
  return s;
}

function numberCtl(id: string, get: () => number, set: (n: number) => void, min: number, max: number): HTMLInputElement {
  const i = h("input", "sp-num");
  i.id = id;
  i.type = "number";
  i.min = String(min);
  i.max = String(max);
  i.onchange = () => {
    const n = Number(i.value);
    set(Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min);
    commit();
  };
  syncers.push(() => { i.value = String(get()); });
  return i;
}

function switchCtl(id: string, key: BoolKey): HTMLElement {
  const lab = h("label", "switch");
  const i = h("input");
  i.type = "checkbox";
  i.id = id;
  i.onchange = () => { state.settings[key] = i.checked; commit(); };
  lab.append(i, h("span", "track"));
  syncers.push(() => { i.checked = state.settings[key]; });
  return lab;
}

function button(id: string, text: string, onClick: () => void, cls = "mbtn"): HTMLButtonElement {
  const b = h("button", cls, text);
  b.id = id;
  b.onclick = onClick;
  return b;
}

function addSection(id: string, title: string, desc: string, rows: HTMLElement[]): Section {
  const el = h("section", "sp-section");
  el.dataset.sec = id;
  el.append(h("h2", "", title), h("p", "sp-sdesc", desc), ...rows);
  const s: Section = { id, title, desc, icon: ICONS[id] ?? "", el, rows };
  sections.push(s);
  content.append(el);
  return s;
}

// ---------- Secciones ----------
function buildAppearance() {
  const card = h("div", "sp-themecard");
  const dots = h("span", "sp-dots");
  const name = h("span", "sp-themename");
  card.append(dots, name);
  syncers.push(() => {
    const t = currentTheme();
    name.textContent = t.label + (t.custom ? " (importado)" : "");
    dots.replaceChildren(...[t.editor, t.sidebar, state.settings.accent, "#" + t.syntax.keyword].map((c) => {
      const d = h("i");
      d.style.background = c;
      return d;
    }));
  });
  const themeCtl = h("div", "sp-inline");
  themeCtl.append(card, button("st-theme-open", t("Explorar temas…"), () => openThemeGallery(), "mbtn primary"));

  const swatches = h("div", "swatches");
  for (const c of ACCENTS) {
    const b = h("button", "swatch");
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.onclick = () => { state.settings.accent = c; commit(); };
    swatches.append(b);
  }
  const custom = h("input");
  custom.type = "color";
  custom.title = t("Color personalizado");
  custom.oninput = () => { state.settings.accent = custom.value; commit(); };
  swatches.append(custom);
  syncers.push(() => {
    swatches.querySelectorAll<HTMLElement>(".swatch").forEach((b) => b.classList.toggle("on", b.dataset.color === state.settings.accent));
    custom.value = state.settings.accent;
  });

  const syntax = selectCtl("st-syntax",
    () => [["auto", t("Los del tema")], ...syntaxOptionsFor(state.settings.theme)],
    () => state.settings.syntaxTheme, (v) => { state.settings.syntaxTheme = v; });

  const imp = h("div", "sp-inline");
  imp.append(
    button("st-import", t("Importar de VS Code…"), () => importInstalled()),
    button("st-import-file", t("Archivo .json…"), () => void importFromFile()),
  );

  // El idioma se fija al cargar la ventana (los menús y comandos se construyen una vez): cambiarlo pide recargar.
  const language = selectCtl(
    "st-language",
    () => [["auto", t("Automático (el del sistema)")], ["es", "Español"], ["en", "English"]],
    () => state.settings.language,
    (v) => {
      state.settings.language = v as Settings["language"];
      void showDialog({
        title: t("Cambiar el idioma"),
        message: t("El idioma nuevo se aplica al recargar la ventana. Antes de recargar, guarda lo que tengas pendiente: las pestañas y las copias de recuperación se conservan."),
        buttons: [{ label: t("Más tarde"), value: "later" }, { label: t("Recargar ahora"), value: "reload", primary: true }],
      }).then((r) => { if (r === "reload") location.reload(); });
    },
  );

  addSection("appearance", t("Apariencia"), t("El tema cambia toda la vista: interfaz, editor, terminal y colores del código."), [
    row(t("Idioma"), t("Idioma de la interfaz. Lo que aún no está traducido se muestra en español."), language, "idioma language english español"),
    row(t("Tema"), t("Cambia la interfaz completa. Hay claros, oscuros y los que importes de VS Code."), themeCtl, "tema theme color"),
    row(t("Color de acento"), t("Botones, selección, barra de estado y detalles."), swatches, "acento color accent"),
    row(t("Colores del código"), t("Usa los del tema o los de otro de la misma clase (claro u oscuro)."), syntax, "sintaxis syntax resaltado"),
    row(t("Temas de VS Code"), t("Importa un tema que ya tengas instalado en VS Code o un archivo .json."), imp, "importar vscode theme"),
  ]);
}

function buildEditor() {
  const font = selectCtl("st-font", () => Object.keys(FONTS).map((n) => [n, n]),
    () => Object.keys(FONTS).find((n) => FONTS[n] === state.settings.fontFamily) ?? "Cascadia Code",
    (v) => { state.settings.fontFamily = FONTS[v]; });
  addSection("editor", t("Editor"), t("Cómo se ve y se comporta el texto."), [
    row(t("Fuente"), t("Tipografía del editor."), font, "fuente font"),
    row(t("Tamaño de fuente"), t("En píxeles (9 a 32)."), numberCtl("st-fontsize", () => state.settings.fontSize, (n) => { state.settings.fontSize = n; }, 9, 32), "tamaño size"),
    row(t("Tamaño de tabulación"), t("Espacios por nivel de sangría."), numberCtl("st-tabsize", () => state.settings.tabSize, (n) => { state.settings.tabSize = n; }, 1, 8), "tab sangría indent"),
    row(t("Ligaduras de fuente"), t("Une símbolos como => o !== en uno solo (si la fuente lo permite)."), switchCtl("st-ligatures", "ligatures")),
    row(t("Minimapa"), t("Vista en miniatura del archivo a la derecha."), switchCtl("st-minimap", "minimap")),
    row(t("Ajuste de línea"), t("Parte las líneas largas en vez de desplazarse en horizontal."), switchCtl("st-wrap", "wordWrap"), "wrap"),
    row(t("Números de línea"), t("Muestra la numeración a la izquierda."), switchCtl("st-lines", "lineNumbers")),
    row(t("Mostrar espacios"), t("Dibuja los espacios y tabulaciones."), switchCtl("st-whitespace", "whitespace"), "whitespace"),
    row(t("Cursor suave"), t("Anima el movimiento del cursor."), switchCtl("st-caret", "smoothCaret")),
    row(t("Autoguardado"), t("Guarda solo, poco después de dejar de escribir."), switchCtl("st-autosave", "autoSave"), "autosave guardar"),
    row(t("Formatear al guardar"), t("Da formato al documento con el servidor de lenguaje (TypeScript y JavaScript) al guardar con Ctrl+S."), switchCtl("st-formatsave", "formatOnSave"), "formatear format guardar"),
    row(t("Autocompletado de IA en línea (Ollama)"), t("Muestra sugerencias fantasma mientras escribes usando Ollama local; pulsa Tab para aceptar."), switchCtl("st-inline-ai", "inlineAiEnabled"), "ia ollama autocompletado fantasma tab inline"),
    (() => {
      const modelInput = document.createElement("input");
      modelInput.id = "st-inline-ai-model";
      modelInput.type = "text";
      modelInput.placeholder = t("Automático (p. ej. qwen2.5-coder:7b)");
      modelInput.spellcheck = false;
      modelInput.onchange = () => { state.settings.inlineAiModel = modelInput.value.trim(); commit(); };
      syncers.push(() => { modelInput.value = state.settings.inlineAiModel || ""; });
      return row(t("Modelo de Ollama para autocompletado"), t("Déjalo vacío para elegir automáticamente el mejor modelo de código instalado en Ollama."), modelInput, "ollama modelo autocompletado ia");
    })(),
  ]);
}

function buildTerminal() {
  const shell = h("select", "sp-select");
  shell.id = "st-termshell";
  shell.onchange = () => { state.settings.terminalShell = shell.value; commit(); };
  const fillShells = async () => {
    const list = await listShells();
    shell.replaceChildren(new Option(list.length ? t("Automática ({shell})", { shell: list[0].label }) : t("Automática"), ""), ...list.map((s) => new Option(s.label, s.id)));
    shell.value = list.some((s) => s.id === state.settings.terminalShell) ? state.settings.terminalShell : "";
  };
  syncers.push(() => { void fillShells(); });

  const font = h("input", "sp-text");
  font.id = "st-termfont";
  font.type = "text";
  font.placeholder = t("Automática (Nerd Fonts y la del editor)");
  font.spellcheck = false;
  font.setAttribute("list", "st-fonts");
  const dl = h("datalist");
  dl.id = "st-fonts";
  font.onchange = () => { state.settings.terminalFont = font.value.trim(); commit(); };
  syncers.push(() => { font.value = state.settings.terminalFont; });

  const scheme = selectCtl("st-termscheme", () => schemeOptions(detected).map((o) => [o.value, o.label]),
    () => state.settings.terminalScheme, (v) => { state.settings.terminalScheme = v; });
  const cursor = selectCtl("st-termcursor", () => [["block", t("Bloque")], ["bar", t("Barra")], ["underline", t("Subrayado")]],
    () => state.settings.terminalCursor, (v) => { state.settings.terminalCursor = v as Settings["terminalCursor"]; });

  void detectPrefs().then((d) => {
    detected = d;
    dl.replaceChildren(...[...d.nerd, ...d.fonts.filter((f) => !d.nerd.includes(f))].map((f) => new Option(f)));
    sync();
  });

  const adapt = button("st-adapt", t("Adaptar a mi terminal…"), () => { void adaptToMyTerminal().then(sync); }, "mbtn primary");
  const rows = [
    row(t("Adaptar a mi terminal"), t("Usa la fuente, los colores y la shell que ya tienes en VS Code o Windows Terminal."), adapt, "adaptar vscode windows terminal"),
    row(t("Shell"), t("Programa que se abre en cada terminal nueva."), shell, "shell powershell cmd bash"),
    row(t("Fuente"), t("Escribe el nombre de una fuente instalada. Para ver los iconos de prompts como oh-my-posh o Starship hace falta una Nerd Font (nerdfonts.com)."), [font, dl], "fuente font nerd"),
    row(t("Tamaño de fuente"), t("En píxeles. 0 = automático (el del editor menos uno)."), numberCtl("st-termsize", () => state.settings.terminalFontSize, (n) => { state.settings.terminalFontSize = n; }, 0, 32), "tamaño size"),
    row(t("Colores"), t("Esquema de colores de la terminal."), scheme, "esquema colores scheme"),
    row(t("Cursor"), t("Forma del cursor."), cursor, "cursor"),
  ];
  addSection("terminal", t("Terminal"), t("Se abre con Ctrl+J. Las terminales ya abiertas toman los cambios al instante."), rows);
}

function buildKeys() {
  kb = buildKeybindings();
  const holder = h("div", "sp-keys");
  holder.append(kb.el);
  const s = addSection("keys", t("Atajos de teclado"), t("Haz clic en un atajo y pulsa la nueva combinación. Esc cancela, Retroceso lo quita."), []);
  s.el.append(holder);
  syncers.push(() => kb.sync());
}

function buildGithub() {
  const token = h("input", "sp-text");
  token.id = "st-token";
  token.type = "password";
  token.placeholder = "ghp_… (opcional)";
  token.autocomplete = "off";
  token.onchange = async () => {
    const val = token.value;
    const saved = await setToken(val);
    token.value = "";
    setStatus(saved ? t("Token guardado en el almacén de credenciales del sistema") : t("No se pudo guardar el token de forma segura: solo se usará en esta sesión"));
    onTokenChange();
    sync();
  };
  syncers.push(() => {
    token.value = "";
    token.placeholder = hasToken() ? t("•••••••• (guardado en el almacén del sistema)") : "ghp_… (opcional)";
  });
  const who = h("span", "sp-ver", "");
  const connect = button("st-gh-connect", t("Conectar con GitHub"), async () => {
    if (await connectFlow()) { onTokenChange(); sync(); }
  });
  const disconnect = button("st-gh-disconnect", t("Desconectar"), async () => {
    await disconnectGithub();
    onTokenChange();
    setStatus(t("Se quitó el token de GitHub de este equipo"));
    sync();
  }, "mbtn danger");
  const account = h("div", "sp-account");
  account.append(who, connect, disconnect);
  const paintAccount = () => {
    const has = hasToken();
    who.textContent = has ? (getAccount() ? t("Conectado como {login}", { login: getAccount()! }) : t("Conectado (token guardado)")) : t("Sin conectar");
    connect.textContent = has ? t("Volver a conectar") : t("Conectar con GitHub");
    disconnect.hidden = !has;
  };
  syncers.push(() => { paintAccount(); void refreshAccount().then(paintAccount); });
  const label = h("input", "sp-text");
  label.id = "st-board-label";
  label.type = "text";
  label.placeholder = "in progress";
  label.spellcheck = false;
  label.onchange = () => { state.settings.boardProgressLabel = label.value.trim() || "in progress"; commit(); };
  syncers.push(() => { label.value = state.settings.boardProgressLabel; });
  addSection("github", "GitHub", t("Conexión con tus repositorios para ver issues y moverlas en el tablero."), [
    row(t("Cuenta de GitHub"), t("Pulsa «Conectar» y autoriza el acceso en el navegador; Pulso usa la sesión de GitHub que Git ya tiene en este equipo si existe. Es lo único necesario para repos privados y para mover tarjetas del tablero."), account, "cuenta github conectar iniciar sesión login autorizar"),
    row(t("Token manual (avanzado)"), t("Alternativa si no puedes usar el botón: un token personal. Necesario para repos privados y para mover tarjetas del tablero (permiso de escritura en issues). Se guarda en el Administrador de credenciales del sistema, no en un archivo."), token, "token github"),
    row(t("Etiqueta de «En curso»"), t("Una issue abierta con esta etiqueta aparece en la columna «En curso» del tablero. Sin ella está «Por hacer»; cerrada, «Hecho»."), label, "tablero kanban etiqueta in progress en curso"),
  ]);
}

function buildAbout() {
  const reset = button("st-reset", t("Restablecer todo…"), async () => {
    const r = await showDialog({
      title: t("Restablecer la configuración"),
      message: t("Se restaurarán los valores por defecto, incluidos los atajos y los temas importados."),
      buttons: [{ label: t("Cancelar"), value: "cancel" }, { label: t("Restablecer"), value: "ok", danger: true }],
    });
    if (r !== "ok") return;
    state.settings = { ...DEFAULTS, keybindings: {}, customThemes: {} } as Settings;
    setTheme(state.settings.theme);
    sync();
  }, "mbtn danger");
  addSection("about", t("Acerca de"), "Pulso Editor", [
    row(t("Versión"), t("Editor de código con issues, tableros y repos integrados. Hecho con Tauri 2 y Monaco."), h("span", "sp-ver", "0.1.0")),
    row(t("Restablecer"), t("Vuelve a los valores de fábrica."), reset, "restablecer reset"),
  ]);
}

// ---------- Navegación, búsqueda y apertura ----------
function showSection(id: string) {
  activeId = id;
  search.value = "";
  applyFilter("");
}

function applyFilter(raw: string) {
  const q = raw.trim().toLowerCase();
  nav.querySelectorAll<HTMLElement>(".sp-nav-btn").forEach((b) => b.classList.toggle("on", !q && b.dataset.sec === activeId));
  for (const s of sections) {
    if (s.id === "keys") {
      s.el.hidden = q ? !!q && !commands.some((c) => c.label.toLowerCase().includes(q) || c.id.includes(q)) : activeId !== "keys";
      kb.setFilter(q);
      continue;
    }
    let any = false;
    for (const r of s.rows) {
      const show = !q || (r.dataset.q ?? "").includes(q);
      r.hidden = !show;
      any ||= show;
    }
    s.el.hidden = q ? !any : s.id !== activeId;
  }
  content.querySelector(".sp-none")?.remove();
  if (q && sections.every((s) => s.el.hidden)) content.append(h("div", "sp-none", t("No hay ajustes que coincidan con la búsqueda.")));
}

let onTokenChange: () => void = () => {};

export function initSettingsPage(onToken: () => void) {
  onTokenChange = onToken;
  page = $("settings-page");

  const head = h("div", "sp-head");
  search = h("input", "sp-search");
  search.id = "sp-search";
  search.type = "text";
  search.placeholder = t("Buscar en la configuración…");
  search.spellcheck = false;
  const close = h("button", "icon-btn sp-close");
  close.title = t("Cerrar (Esc)");
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = closeSettings;
  head.append(h("div", "sp-title", t("Configuración")), search, close);

  const body = h("div", "sp-body");
  nav = h("nav", "sp-nav");
  content = h("div", "sp-content");
  body.append(nav, content);
  page.replaceChildren(head, body);

  buildAppearance();
  buildEditor();
  buildTerminal();
  buildKeys();
  buildGithub();
  buildAbout();

  for (const s of sections) {
    const b = h("button", "sp-nav-btn");
    b.dataset.sec = s.id;
    b.innerHTML = `<svg viewBox="0 0 24 24">${s.icon}</svg>`;
    b.append(h("span", "", s.title));
    b.onclick = () => showSection(s.id);
    nav.append(b);
  }

  search.oninput = () => applyFilter(search.value);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || page.hidden || kb.isRecording()) return;
    if (document.querySelector(".modal-back, .ctxmenu, .hmenu") || !$("quickopen").hidden) return;
    e.preventDefault();
    if (search.value) { search.value = ""; applyFilter(""); } else closeSettings();
  });
  applyFilter("");
}

export const isSettingsOpen = () => !!page && !page.hidden;

export function openSettings(section?: string) {
  if (section) activeId = section;
  page.hidden = false;
  document.querySelector('.act[data-view="settings"]')?.classList.add("active");
  sync();
  showSection(activeId);
}

export function closeSettings() {
  if (!page || page.hidden) return;
  page.hidden = true;
  document.querySelector('.act[data-view="settings"]')?.classList.remove("active");
}

export function toggleSettings() {
  if (isSettingsOpen()) closeSettings(); else openSettings();
}
