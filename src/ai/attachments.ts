/** Lo que se adjunta al mensaje: contexto del editor, archivos, imágenes, cambios de Git, issues y pull requests. */

import { type ContextNote, type EditorContext, chipLabels } from "../aiContext";
import { type Turn } from "../aiModel";
import { loadChats } from "../aiStore";
import { currentRepo } from "../core/repo";
import { fetchIssues } from "../github";
import { activePath, focusedEditor } from "../groups";
import { relativeToTop } from "../historyModel";
import { t as tr } from "../i18n";
import { listPulls } from "../pulls";
import { Changes } from "../scmModel";
import { type PickItem, quickPick, setStatus } from "../ui";
import { baseName, dirName, h, norm } from "../util";
import { rel, ws } from "../workspace";
import { S, lives, q } from "./chatState";
import { ALLOWED_IMAGE_MIME, MAX_IMAGES, MAX_IMAGE_BYTES, makeThumbnail, readAsDataUrl } from "./images";
import { openImageLightbox } from "./lightbox";
import { fillScopeStrip } from "./quota";
import { invoke } from "@tauri-apps/api/core";

// ---------- Contexto del editor ----------
export function editorContext(): EditorContext {
  const ctx: EditorContext = {};
  const p = activePath();
  if (p && S.useFile) ctx.file = (ws.root && relativeToTop(norm(p), ws.root)) || norm(p);
  if (S.extraFiles.length) ctx.extraFiles = [...S.extraFiles];
  if (S.extraNotes.length) ctx.notes = [...S.extraNotes];
  if (S.attachedImages.length) ctx.images = S.attachedImages.map((i) => ({ path: i.path, name: i.name }));
  const ed = focusedEditor();
  const sel = ed?.getSelection();
  const edModel = ed?.getModel();
  if (S.useSel && ed && sel && edModel && !sel.isEmpty() && edModel.uri.scheme === "file") {
    ctx.selection = { text: edModel.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
  }
  return ctx;
}

export function renderChips() {
  const box = q(".ai-chips");
  if (!box) return;
  const ctx = editorContext();
  const labels = chipLabels(ctx);
  const chip = (text: string, title: string, off: () => void) => {
    const c = h("span", "ai-chip");
    c.title = title;
    c.append(h("span", "", text));
    const x = h("button", "ai-chip-x", "×");
    x.type = "button";
    x.title = tr("No adjuntar esto");
    x.setAttribute("aria-label", tr("Quitar {item}", { item: text }));
    x.onclick = () => {
      off();
      renderChips();
    };
    c.append(x);
    return c;
  };
  const nodes: HTMLElement[] = [];
  if (labels.file)
    nodes.push(
      chip(labels.file, tr("Archivo abierto: se le dice a la IA cuál es"), () => {
        S.useFile = false;
      }),
    );
  for (const extra of S.extraFiles) {
    if (extra === ctx.file) continue;
    nodes.push(
      chip(baseName(extra), tr("Archivo adjunto: {file}", { file: extra }), () => {
        S.extraFiles = S.extraFiles.filter((f) => f !== extra);
      }),
    );
  }
  for (const note of S.extraNotes) {
    nodes.push(
      chip(note.label, note.title, () => {
        S.extraNotes = S.extraNotes.filter((n) => n.id !== note.id);
      }),
    );
  }
  for (const img of S.attachedImages) {
    const c = h("span", "ai-chip ai-chip-img");
    c.title = tr("Imagen adjunta: {name}", { name: img.name });
    if (img.preview) {
      const thumb = document.createElement("img");
      thumb.className = "ai-chip-thumb";
      thumb.src = img.preview;
      thumb.alt = img.name;
      thumb.onclick = (e) => {
        e.stopPropagation();
        void openImageLightbox(img);
      };
      c.append(thumb);
    }
    c.append(h("span", "", img.name));
    const x = h("button", "ai-chip-x", "×");
    x.type = "button";
    x.title = tr("No adjuntar esto");
    x.setAttribute("aria-label", tr("Quitar {item}", { item: img.name }));
    x.onclick = () => {
      S.attachedImages = S.attachedImages.filter((i) => i !== img);
      renderChips();
    };
    c.append(x);
    nodes.push(c);
  }
  if (labels.selection)
    nodes.push(
      chip(labels.selection, tr("Tu selección se envía a la IA con el mensaje"), () => {
        S.useSel = false;
      }),
    );
  box.replaceChildren(...nodes);
  box.hidden = !nodes.length;
  const ctxWrap = q(".ai-dock-ctx");
  if (ctxWrap) ctxWrap.hidden = !nodes.length;
  const scopeBox = q(".ai-scope-strip");
  if (scopeBox) fillScopeStrip(scopeBox, ctx);
}

export function collectReferencedImagePaths(): string[] {
  const paths = new Set<string>();
  const scanTurns = (turns: readonly Turn[]) => {
    for (const turn of turns) {
      for (const b of turn.blocks) {
        if (b.kind === "image" && b.path) paths.add(b.path);
      }
    }
  };
  for (const c of loadChats()) scanTurns(c.messages);
  for (const l of lives.values()) scanTurns(l.convo.messages);
  for (const img of S.attachedImages) if (img.path) paths.add(img.path);
  return Array.from(paths);
}

export function pruneUnusedImages() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void invoke("ai_prune_images", { keepPaths: collectReferencedImagePaths() }).catch(() => {});
}

export async function addImageFiles(files: Iterable<File>) {
  if (!ws.root) {
    setStatus(tr("Abre una carpeta primero"));
    return;
  }
  for (const file of files) {
    if (S.attachedImages.length >= MAX_IMAGES) {
      setStatus(tr("Puedes adjuntar como máximo {max} imágenes por mensaje", { max: MAX_IMAGES }), 4000);
      break;
    }
    const mime = file.type.toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      setStatus(tr("Formato no soportado ({name}). Usa PNG, JPG, WEBP o GIF.", { name: file.name || mime || "archivo" }), 4500);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus(tr("La imagen {name} supera el límite de 10 MB", { name: file.name || "imagen" }), 4500);
      continue;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) continue;
      const base64 = dataUrl.slice(comma + 1);
      const saved = await invoke<{ path: string; name: string }>("ai_save_image", {
        name: file.name || null,
        mime,
        dataBase64: base64,
      });
      const preview = await makeThumbnail(dataUrl);
      S.attachedImages.push({ path: saved.path, name: saved.name, ...(preview ? { preview } : {}) });
      renderChips();
    } catch (e) {
      setStatus(tr("No se pudo adjuntar la imagen: {error}", { error: String(e) }), 5000);
    }
  }
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

export function addContextNote(note: ContextNote) {
  S.extraNotes = [...S.extraNotes.filter((n) => n.id !== note.id), note];
  renderChips();
  q<HTMLTextAreaElement>(".ai-input")?.focus();
}

export function attachProjectFileOnly() {
  if (!ws.root) {
    setStatus(tr("Abre una carpeta primero"));
    return;
  }
  quickPick({
    placeholder: tr("Adjuntar archivo del proyecto al contexto…"),
    load: async () => {
      const files = await invoke<string[]>("list_files", { path: ws.root });
      return files
        .map((p) => ({ p, r: rel(p) }))
        .sort((a, b) => a.r.localeCompare(b.r))
        .map<PickItem>(({ p, r }) => ({
          label: baseName(p),
          detail: dirName(r),
          run: () => {
            if (!S.extraFiles.includes(r)) S.extraFiles.push(r);
            renderChips();
            q<HTMLTextAreaElement>(".ai-input")?.focus();
          },
        }));
    },
  });
}

export async function attachGitChanges() {
  if (!ws.root) {
    setStatus(tr("Abre una carpeta primero"));
    return;
  }
  try {
    const c = await invoke<Changes>("git_changes", { root: ws.root });
    const lines: string[] = [`Rama: ${c.branch}`];
    if (c.conflicted.length) lines.push("Conflictos:\n" + c.conflicted.map((x) => `  ! ${x.path}`).join("\n"));
    if (c.staged.length) lines.push("Preparados:\n" + c.staged.map((x) => `  ${x.status} ${x.path}`).join("\n"));
    if (c.unstaged.length) lines.push("Sin preparar:\n" + c.unstaged.map((x) => `  ${x.status} ${x.path}`).join("\n"));
    const total = c.conflicted.length + c.staged.length + c.unstaged.length;
    if (!total) {
      setStatus(tr("No hay cambios de Git pendientes para adjuntar"));
      return;
    }
    addContextNote({
      id: "git:changes",
      label: tr("Git · {count} cambios", { count: total }),
      title: tr("Cambios de Git en rama «{branch}»", { branch: c.branch }),
      body: lines.join("\n\n"),
    });
  } catch (e) {
    setStatus(String(e));
  }
}

export async function attachGithubIssue() {
  const repo = await currentRepo();
  if (!repo) {
    setStatus(tr("Esta carpeta no tiene un remoto de GitHub."));
    return;
  }
  quickPick({
    placeholder: tr("Adjuntar issue de GitHub al contexto…"),
    empty: tr("No hay issues abiertas"),
    load: async () => {
      const issues = await fetchIssues(repo.owner, repo.repo, "open");
      return issues.map<PickItem>((i) => ({
        label: `#${i.number} ${i.title}`,
        detail: i.labels.map((l) => l.name).join(", "),
        run: () =>
          addContextNote({
            id: `issue:${i.number}`,
            label: `Issue #${i.number}`,
            title: `Issue #${i.number}: ${i.title}`,
            body: (i.body?.trim() || i.title) + `\n\nURL: ${i.html_url}`,
          }),
      }));
    },
  });
}

export async function attachGithubPr() {
  const repo = await currentRepo();
  if (!repo) {
    setStatus(tr("Esta carpeta no tiene un remoto de GitHub."));
    return;
  }
  quickPick({
    placeholder: tr("Adjuntar pull request de GitHub al contexto…"),
    empty: tr("No hay pull requests abiertas"),
    load: async () => {
      const prs = await listPulls(repo.owner, repo.repo, "open");
      return prs.map<PickItem>((p) => ({
        label: `PR #${p.number} ${p.title}`,
        detail: `${p.head.ref} → ${p.base.ref}`,
        run: () =>
          addContextNote({
            id: `pr:${p.number}`,
            label: `PR #${p.number}`,
            title: `Pull Request #${p.number}: ${p.title} (${p.head.ref} → ${p.base.ref})`,
            body: (p.body?.trim() || p.title) + `\n\nURL: ${p.html_url}`,
          }),
      }));
    },
  });
}

export function attachProjectFile() {
  if (!ws.root) {
    setStatus(tr("Abre una carpeta primero"));
    return;
  }
  quickPick({
    placeholder: tr("¿Qué quieres adjuntar al contexto?"),
    load: () => [
      {
        label: tr("Archivo del proyecto…"),
        detail: tr("Añade una ruta del proyecto (también puedes escribir @archivo)"),
        run: attachProjectFileOnly,
      },
      {
        label: tr("Cambios de Git actuales"),
        detail: tr("Rama activa y archivos modificados/preparados"),
        run: () => void attachGitChanges(),
      },
      {
        label: tr("Issue de GitHub…"),
        detail: tr("Adjunta título y descripción de una issue abierta"),
        run: () => void attachGithubIssue(),
      },
      {
        label: tr("Pull request de GitHub…"),
        detail: tr("Adjunta título, ramas y descripción de una PR abierta"),
        run: () => void attachGithubPr(),
      },
    ],
  });
}
