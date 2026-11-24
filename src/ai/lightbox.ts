/** Visor de una imagen adjunta a pantalla completa. */

import { type UserImage } from "../aiModel";
import { t as tr } from "../i18n";
import { h } from "../util";
import { invoke } from "@tauri-apps/api/core";

export async function openImageLightbox(img: UserImage) {
  document.querySelector(".ai-lightbox")?.remove();
  const backdrop = h("div", "ai-lightbox");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", img.name);
  const frame = h("div", "ai-lightbox-frame");
  const head = h("div", "ai-lightbox-head");
  head.append(h("span", "ai-lightbox-name", img.name));
  const closeBtn = h("button", "icon-btn ai-lightbox-close", "×");
  closeBtn.type = "button";
  closeBtn.title = tr("Cerrar (Esc)");
  closeBtn.setAttribute("aria-label", tr("Cerrar"));
  const close = () => {
    window.removeEventListener("keydown", onEsc, true);
    backdrop.remove();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  closeBtn.onclick = close;
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  window.addEventListener("keydown", onEsc, true);
  head.append(closeBtn);
  const pic = document.createElement("img");
  pic.className = "ai-lightbox-img";
  pic.alt = img.name;
  pic.draggable = false;
  if (img.preview) pic.src = img.preview;
  frame.append(head, pic);
  backdrop.append(frame);
  document.body.append(backdrop);
  if (img.path && "__TAURI_INTERNALS__" in window) {
    try {
      const full = await invoke<string>("ai_read_image_data_url", { path: img.path });
      if (document.body.contains(pic)) pic.src = full;
    } catch {
      /* se queda la miniatura */
    }
  }
}
