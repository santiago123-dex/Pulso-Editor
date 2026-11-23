import * as monaco from "monaco-editor";
import { focusedEditor, onGroupsChange } from "./groups";
import { parseConflicts, resolveConflictText, type ConflictBlock, type ConflictChoice } from "./gitHunksModel";
import { t } from "./i18n";
import { setStatus } from "./ui";
import { h } from "./util";

/**
 * Ayuda visual en conflictos de Git: resalta bloques `<<<<<<< / ======= / >>>>>>>`
 * en el editor enfocado y muestra una barra flotante para resolverlos con un clic (deshacible con Ctrl+Z).
 */
let bar: HTMLElement | null = null;
let currentEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let decoIds: string[] = [];
let activeIdx = 0;
let blocks: ConflictBlock[] = [];
let disposables: monaco.IDisposable[] = [];

function ensureBar(): HTMLElement {
  if (bar) return bar;
  const el = h("div", "conflict-bar");
  el.hidden = true;
  document.querySelector("main")?.append(el);
  bar = el;
  return el;
}

function clearDecorations() {
  if (currentEditor && decoIds.length) {
    decoIds = currentEditor.deltaDecorations(decoIds, []);
  }
  decoIds = [];
}

function applyChoice(choice: ConflictChoice) {
  const ed = focusedEditor();
  const model = ed?.getModel();
  const block = blocks[activeIdx];
  if (!ed || !model || !block) return;

  const endMaxCol = model.getLineMaxColumn(block.endLine);
  const replacement = resolveConflictText(block, choice);
  ed.executeEdits("pulso-conflict-resolve", [
    {
      range: new monaco.Range(block.startLine, 1, block.endLine, endMaxCol),
      text: replacement,
      forceMoveMarkers: true,
    },
  ]);
  ed.focus();
  setStatus(t("Conflicto resuelto (Ctrl+Z para deshacer)"), 2500);
  refresh();
}

function jumpTo(index: number) {
  const ed = focusedEditor();
  if (!ed || !blocks.length) return;
  activeIdx = ((index % blocks.length) + blocks.length) % blocks.length;
  const b = blocks[activeIdx];
  ed.revealLineInCenter(b.startLine);
  ed.setPosition({ lineNumber: b.startLine, column: 1 });
  ed.focus();
  paintBar();
}

function paintBar() {
  const el = ensureBar();
  if (!blocks.length) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  if (activeIdx >= blocks.length) activeIdx = 0;
  const b = blocks[activeIdx];
  el.hidden = false;

  const label = h("span", "conflict-label", t("Conflicto {n}/{total} (línea {line})", {
    n: activeIdx + 1,
    total: blocks.length,
    line: b.startLine,
  }));
  const btnCur = h("button", "diff-btn primary", t("Aceptar actual ({name})", { name: b.currentLabel }));
  btnCur.onclick = () => applyChoice("current");
  const btnInc = h("button", "diff-btn", t("Aceptar entrante ({name})", { name: b.incomingLabel }));
  btnInc.onclick = () => applyChoice("incoming");
  const btnBoth = h("button", "diff-btn", t("Aceptar ambos"));
  btnBoth.onclick = () => applyChoice("both");

  el.replaceChildren(label, btnCur, btnInc, btnBoth);
  if (blocks.length > 1) {
    const next = h("button", "diff-btn", t("Siguiente →"));
    next.onclick = () => jumpTo(activeIdx + 1);
    el.append(next);
  }
}

function refresh() {
  const ed = focusedEditor();
  if (ed !== currentEditor) {
    clearDecorations();
    disposables.forEach((d) => d.dispose());
    disposables = [];
    currentEditor = ed;
    if (ed) {
      disposables.push(
        ed.onDidChangeModelContent(refresh),
        ed.onDidChangeModel(refresh),
        ed.onDidChangeCursorPosition((e) => {
          const line = e.position.lineNumber;
          const idx = blocks.findIndex((b) => line >= b.startLine && line <= b.endLine);
          if (idx >= 0 && idx !== activeIdx) {
            activeIdx = idx;
            paintBar();
          }
        })
      );
    }
  }

  const model = ed?.getModel();
  if (!ed || !model) {
    blocks = [];
    clearDecorations();
    paintBar();
    return;
  }

  blocks = parseConflicts(model.getValue());
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  for (const b of blocks) {
    decos.push({
      range: new monaco.Range(b.startLine, 1, b.sepLine - 1, 1),
      options: { isWholeLine: true, className: "conflict-current-line" },
    });
    decos.push({
      range: new monaco.Range(b.sepLine, 1, b.sepLine, 1),
      options: { isWholeLine: true, className: "conflict-sep-line" },
    });
    decos.push({
      range: new monaco.Range(b.sepLine + 1, 1, b.endLine, 1),
      options: { isWholeLine: true, className: "conflict-incoming-line" },
    });
  }
  decoIds = ed.deltaDecorations(decoIds, decos);
  paintBar();
}

export function initConflictHelper() {
  onGroupsChange(refresh);
  refresh();
}
