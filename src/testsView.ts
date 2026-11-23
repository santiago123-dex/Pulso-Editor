import { invoke } from "@tauri-apps/api/core";
import { openFile } from "./groups";
import { t } from "./i18n";
import { fileIcon } from "./icons";
import { groupTestsByFile, testSummaryLine, type DetectedRunner, type TestRunResult } from "./testsModel";
import { setStatus } from "./ui";
import { $, baseName, dirName, h } from "./util";
import { rel, ws } from "./workspace";

let runners: DetectedRunner[] = [];
let selectedRunner = "";
let lastResult: TestRunResult | null = null;
let onlyFailed = false;
let running = false;
let visible = false;
let runToken = 0;
const collapsed = new Set<string>();

export function resetTestsView() {
  runToken++;
  runners = [];
  selectedRunner = "";
  lastResult = null;
  running = false;
  collapsed.clear();
  updateBadge();
  if (visible) paint();
}

function updateBadge() {
  const badge = document.getElementById("tests-badge");
  if (!badge) return;
  const n = lastResult?.failed ?? 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
}

export async function detectTests() {
  if (!ws.root) {
    runners = [];
    selectedRunner = "";
    if (visible) paint();
    return;
  }
  try {
    runners = await invoke<DetectedRunner[]>("test_detect", { root: ws.root });
    if (!runners.some((r) => r.id === selectedRunner)) {
      selectedRunner = runners[0]?.id ?? "";
    }
  } catch {
    runners = [];
    selectedRunner = "";
  }
  if (visible) paint();
}

export async function runAllTests(file?: string) {
  if (!ws.root) {
    setStatus(t("Abre una carpeta para ejecutar pruebas"), 3000);
    return;
  }
  if (!runners.length) await detectTests();
  const runner = selectedRunner || runners[0]?.id;
  if (!runner) {
    setStatus(t("No se detectó ningún ejecutor de pruebas (vitest, jest, cargo o pytest)"), 3500);
    if (visible) paint();
    return;
  }
  const mine = ++runToken;
  running = true;
  if (visible) paint();
  setStatus(file ? t("Ejecutando pruebas de {file}…", { file: baseName(file) }) : t("Ejecutando pruebas ({runner})…", { runner }));
  try {
    const res = await invoke<TestRunResult>("test_run", { root: ws.root, runner, file: file ?? null });
    if (mine !== runToken) return;
    lastResult = res;
    updateBadge();
    setStatus(
      res.ok
        ? t("Pruebas completadas: {summary}", { summary: testSummaryLine(res) })
        : t("Pruebas con fallos: {summary}", { summary: testSummaryLine(res) }),
      4000
    );
  } catch (e) {
    if (mine !== runToken) return;
    lastResult = {
      runner,
      ok: false,
      cases: [],
      passed: 0,
      failed: 1,
      skipped: 0,
      duration_ms: 0,
      output: e instanceof Error ? e.message : String(e),
    };
    updateBadge();
    setStatus(t("Error al ejecutar las pruebas"), 3500);
  } finally {
    if (mine === runToken) {
      running = false;
      if (visible) paint();
    }
  }
}

function paint() {
  const sel = document.getElementById("tests-runner") as HTMLSelectElement | null;
  if (sel) {
    sel.replaceChildren();
    for (const r of runners) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.label;
      opt.selected = r.id === selectedRunner;
      sel.append(opt);
    }
    sel.hidden = runners.length <= 1;
  }

  const summary = $("tests-summary");
  if (running) {
    summary.textContent = t("Ejecutando pruebas…");
  } else if (lastResult) {
    summary.textContent = `${lastResult.runner} · ${testSummaryLine(lastResult)}`;
  } else if (runners.length) {
    summary.textContent = t("Detectado: {list}", { list: runners.map((r) => r.label).join(", ") });
  } else {
    summary.textContent = t("Sin ejecutor de pruebas detectado");
  }

  const box = $("tests-list");
  box.replaceChildren();
  if (running) {
    box.append(h("div", "problems-empty", t("Ejecutando pruebas del proyecto…")));
    return;
  }
  if (!ws.root) {
    box.append(h("div", "problems-empty", t("Abre una carpeta para detectar y ejecutar pruebas.")));
    return;
  }
  if (!runners.length) {
    box.append(h("div", "problems-empty", t("No se encontró Vitest, Jest, Cargo test ni Pytest en este proyecto.")));
    return;
  }
  if (!lastResult) {
    box.append(h("div", "problems-empty", t("Pulsa ▶ para ejecutar las pruebas del proyecto.")));
    return;
  }

  const groups = groupTestsByFile(lastResult.cases, onlyFailed);
  if (!groups.length) {
    const emptyMsg = onlyFailed && lastResult.failed === 0
      ? t("No hay pruebas fallidas.")
      : lastResult.ok
        ? t("Todas las pruebas pasaron.")
        : t("Las pruebas terminaron con errores. Revisa la salida.");
    box.append(h("div", "problems-empty", emptyMsg));
  } else {
    for (const g of groups) {
      const closed = collapsed.has(g.file);
      const head = h("div", "sfile" + (closed ? " closed" : ""));
      const statusDot = h("span", `pdot ${g.failed ? "error" : "info"}`, g.failed ? "✖" : "✓");
      const name = h("span", "name", baseName(g.file));
      head.append(h("span", "chev"), statusDot, fileIcon(baseName(g.file)), name);
      const dir = rel(dirName(g.file));
      if (dir) head.append(h("span", "sdir", dir));
      const runFileBtn = h("button", "icon-btn test-run-file", "▶");
      runFileBtn.title = t("Ejecutar este archivo");
      runFileBtn.onclick = (e) => { e.stopPropagation(); void runAllTests(g.file); };
      head.append(h("span", "scount", `${g.passed}/${g.cases.length}`), runFileBtn);
      head.onclick = () => { if (collapsed.has(g.file)) collapsed.delete(g.file); else collapsed.add(g.file); paint(); };
      head.ondblclick = () => void openFile(g.file);
      box.append(head);
      if (closed) continue;
      for (const c of g.cases) {
        const row = h("div", "problem");
        const dot = h("span", `pdot ${c.status === "failed" ? "error" : c.status === "skipped" ? "warning" : "info"}`);
        dot.textContent = c.status === "failed" ? "✖" : c.status === "skipped" ? "○" : "✓";
        const msg = h("span", "pmsg", c.name);
        const dur = h("span", "pwhere", c.duration_ms != null ? `${c.duration_ms} ms` : "");
        row.append(dot, msg, dur);
        row.title = c.name;
        row.onclick = () => void openFile(c.file);
        box.append(row);
      }
    }
  }

  if (lastResult.output.trim()) {
    const details = document.createElement("details");
    details.className = "test-output-box";
    if (!lastResult.ok) details.open = true;
    const sum = document.createElement("summary");
    sum.textContent = t("Salida completa");
    const pre = document.createElement("pre");
    pre.textContent = lastResult.output;
    details.append(sum, pre);
    box.append(details);
  }
}

export function setTestsVisible(v: boolean) {
  visible = v;
  if (v) {
    if (!runners.length && ws.root) void detectTests();
    else paint();
  }
}

export function initTestsView() {
  const runBtn = document.getElementById("tests-run");
  if (runBtn) runBtn.onclick = () => void runAllTests();
  const onlyBtn = document.getElementById("tests-only-failed");
  if (onlyBtn) {
    onlyBtn.onclick = () => {
      onlyFailed = !onlyFailed;
      onlyBtn.classList.toggle("on", onlyFailed);
      paint();
    };
  }
  const sel = document.getElementById("tests-runner") as HTMLSelectElement | null;
  if (sel) {
    sel.onchange = () => {
      selectedRunner = sel.value;
      lastResult = null;
      updateBadge();
      paint();
    };
  }
}
