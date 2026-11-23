import { t } from "./i18n";
import { readStorage, writeStorage } from "./core/storage";
import { getAccount, hasToken } from "./github";
import { connectFlow } from "./githubConnect";
import { allThemes, commit, setTheme, state } from "./settings";
import { h } from "./util";
import "./onboarding.css";

const ONBOARD_KEY = "pulso.onboarded";

export const isOnboardingDone = () => readStorage(ONBOARD_KEY) === "1";
export const markOnboardingDone = () => { writeStorage(ONBOARD_KEY, "1"); };

/** Solo se abre automáticamente la primera vez que no hay carpeta abierta ni recientes. */
export function shouldShowOnboarding(opts: { done: boolean; hasRecent: boolean; hasRoot: boolean }): boolean {
  return !opts.done && !opts.hasRecent && !opts.hasRoot;
}

const FEATURED_THEMES = ["pulso-dark", "pulso-light", "dracula", "github-dark"];

export function openOnboarding(opts: { onOpenFolder: () => Promise<void> }) {
  document.querySelector(".onb-backdrop")?.remove();

  const backdrop = h("div", "onb-backdrop");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", t("Bienvenido a Pulso Editor"));

  const card = h("div", "onb-card");
  const close = () => {
    markOnboardingDone();
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".modal")) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  window.addEventListener("keydown", onKey, true);

  // Cabecera
  const head = h("div", "onb-head");
  const logo = document.createElement("img");
  logo.className = "onb-logo";
  logo.src = "/logo.png";
  logo.alt = "Pulso";
  logo.draggable = false;
  const titles = h("div", "onb-titles");
  titles.append(
    h("h2", "onb-title", t("Bienvenido a Pulso Editor")),
    h("p", "onb-sub", t("Configura lo básico en unos segundos; podrás cambiar todo después en Configuración.")),
  );
  head.append(logo, titles);

  // 1. Tema
  const themeSec = h("div", "onb-sec");
  themeSec.append(h("div", "onb-label", t("Elige un tema")));
  const themesGrid = h("div", "onb-themes");
  const catalog = allThemes();
  const themeBtns: { id: string; el: HTMLButtonElement }[] = [];
  for (const id of FEATURED_THEMES) {
    const th = catalog[id];
    if (!th) continue;
    const btn = h("button", `onb-theme${state.settings.theme === id ? " active" : ""}`);
    btn.type = "button";
    const sw = h("span", "onb-swatch");
    sw.style.background = th.bg;
    sw.style.borderColor = th.border;
    const dot = h("span", "onb-swatch-dot");
    dot.style.background = th.accent;
    sw.append(dot);
    btn.append(sw, h("span", "onb-theme-name", th.label));
    btn.onclick = () => {
      setTheme(id);
      for (const b of themeBtns) b.el.classList.toggle("active", b.id === id);
    };
    themeBtns.push({ id, el: btn });
    themesGrid.append(btn);
  }
  themeSec.append(themesGrid);

  // 2. Idioma
  const langSec = h("div", "onb-sec");
  langSec.append(h("div", "onb-label", t("Idioma de la interfaz")));
  const langRow = h("div", "seg onb-lang");
  const langNote = h("div", "onb-hint", "");
  const langs: readonly ["auto" | "es" | "en", string][] = [
    ["auto", t("Automático")],
    ["es", "Español"],
    ["en", "English"],
  ];
  const langBtns: { val: "auto" | "es" | "en"; el: HTMLButtonElement }[] = [];
  for (const [val, label] of langs) {
    const b = h("button", "", label);
    b.type = "button";
    b.setAttribute("aria-selected", String(state.settings.language === val));
    b.onclick = () => {
      state.settings.language = val;
      commit();
      for (const item of langBtns) item.el.setAttribute("aria-selected", String(item.val === val));
      langNote.textContent = t("El cambio de idioma se aplica al reiniciar Pulso.");
    };
    langBtns.push({ val, el: b });
    langRow.append(b);
  }
  langSec.append(langRow, langNote);

  // 3. GitHub
  const ghSec = h("div", "onb-sec");
  ghSec.append(h("div", "onb-label", t("GitHub (issues, tablero y pull requests)")));
  const ghRow = h("div", "onb-gh");
  const renderGh = () => {
    ghRow.replaceChildren();
    if (hasToken()) {
      const login = getAccount();
      ghRow.append(h("span", "onb-gh-ok", login ? t("Conectado como @{login}", { login }) : t("Cuenta de GitHub conectada")));
    } else {
      const btn = h("button", "diff-btn", t("Conectar con GitHub"));
      btn.type = "button";
      btn.onclick = async () => {
        const ok = await connectFlow();
        if (ok) renderGh();
      };
      ghRow.append(btn, h("span", "onb-hint", t("Opcional: puedes conectarlo más tarde.")));
    }
  };
  renderGh();
  ghSec.append(ghRow);

  // Pie
  const foot = h("div", "onb-foot");
  const folderBtn = h("button", "diff-btn", t("Abrir una carpeta…"));
  folderBtn.type = "button";
  folderBtn.onclick = () => { close(); void opts.onOpenFolder(); };
  const doneBtn = h("button", "diff-btn primary", t("Empezar"));
  doneBtn.type = "button";
  doneBtn.onclick = close;
  foot.append(folderBtn, doneBtn);

  card.append(head, themeSec, langSec, ghSec, foot);
  backdrop.append(card);
  document.body.append(backdrop);
  doneBtn.focus();
}
