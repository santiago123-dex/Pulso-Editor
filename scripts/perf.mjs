// Mide arranque, apertura de archivos, escritura, búsqueda y memoria en la app real de Pulso.
//
// Requisitos: la app en ejecución con el puerto de depuración de WebView2 abierto (igual que `npm run e2e`):
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"; npx tauri dev
//   Después:  npm run perf
//
// Crea un proyecto sintético en una carpeta temporal, no toca tus proyectos y restaura el estado al terminar.
// Solo mide y muestra números: no falla por ningún umbral. Usa `--json` para una salida legible por máquina.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.PULSO_CDP_PORT ?? "9222";
const FILES = Number(process.env.PERF_FILES ?? 3000);
const JSON_OUT = process.argv.includes("--json");
const fwd = (p) => p.split(path.sep).join("/");
const ROOT = fwd(path.join(os.tmpdir(), `pulso-perf-${process.pid}`));

let targets;
try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }
catch { console.error(`No se pudo conectar con la app en el puerto ${PORT}. Inicia la app con depuración.`); process.exit(2); }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const run = async (code) => {
  const r = (await send("Runtime.evaluate", { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })).result;
  if (r.exceptionDetails) throw new Error("Error en la página: " + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
  return r.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (code, what, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await run(code).catch(() => false)) return; await wait(25); }
  throw new Error(`Tiempo agotado esperando: ${what}`);
};
const invoke = (cmd, args = {}) => run(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const ms = (n) => Math.round(n * 10) / 10;

/** Memoria (MB) del proceso de Pulso y de todos sus procesos hijos (WebView2, servidor de lenguaje…), por nombre. */
function processMemory() {
  try {
    const script = `
      $all = Get-CimInstance Win32_Process
      $root = $all | Where-Object { $_.Name -eq 'pulso-editor.exe' } | Select-Object -First 1
      if (-not $root) { '{}'; exit }
      $ids = @($root.ProcessId); $grew = $true
      while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and $ids -notcontains $p.ProcessId) { $ids += $p.ProcessId; $grew = $true } } }
      $all | Where-Object { $ids -contains $_.ProcessId } | Group-Object Name | ForEach-Object { [pscustomobject]@{ n = $_.Name; c = $_.Count; mb = [math]::Round(($_.Group | Measure-Object WorkingSetSize -Sum).Sum / 1MB) } } | ConvertTo-Json -Compress`;
    const rows = JSON.parse(execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim() || "[]");
    const list = Array.isArray(rows) ? rows : [rows];
    return { total_mb: list.reduce((n, x) => n + (x.mb ?? 0), 0), por_proceso: Object.fromEntries(list.map((x) => [`${x.n} (${x.c})`, x.mb])) };
  } catch { return null; }
}
const jsHeapMb = async () => {
  const m = (await send("Performance.getMetrics")).result.metrics.find((x) => x.name === "JSHeapUsedSize");
  return Math.round((m?.value ?? 0) / 1048576);
};

// ---------- Proyecto sintético ----------
function makeProject() {
  fs.mkdirSync(ROOT, { recursive: true });
  const line = (i) => `export function fn${i}(a: number, b: string): string { return b.repeat(a) + "valor-${i}"; } // comentario ${i}\n`;
  for (let i = 0; i < FILES; i++) {
    const dir = path.join(ROOT, "src", `mod${i % 60}`);
    fs.mkdirSync(dir, { recursive: true });
    let body = "";
    for (let j = 0; j < 40; j++) body += line(i * 40 + j);
    fs.writeFileSync(path.join(dir, `archivo${i}.ts`), body);
  }
  fs.writeFileSync(path.join(ROOT, "small.ts"), line(1));
  let medium = "", big = "";
  for (let i = 0; medium.length < 500_000; i++) medium += line(i);
  for (let i = 0; big.length < 5_000_000; i++) big += line(i);
  fs.writeFileSync(path.join(ROOT, "medium.ts"), medium);
  fs.writeFileSync(path.join(ROOT, "big.ts"), big);
  fs.writeFileSync(path.join(ROOT, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  try { execFileSync("git", ["init", "-q"], { cwd: ROOT }); } catch { /* sin git: se omite la medición de estado */ }
}

const r = { meta: { archivos: FILES + 4, maquina: `${os.cpus()[0].model.trim()} · ${Math.round(os.totalmem() / 2 ** 30)} GB`, fecha: new Date().toISOString() }, resultados: {} };
const log = (k, v) => { r.resultados[k] = v; if (!JSON_OUT) console.log(`${k.padEnd(46)} ${typeof v === "object" ? JSON.stringify(v) : v}`); };

const saved = await run(`return Object.fromEntries(["pulso.session","pulso.settings","pulso.recent","pulso.lastRoot"].map(k => [k, localStorage.getItem(k)]))`);
const restore = () => run(`${Object.entries(saved).map(([k, v]) => v == null ? `localStorage.removeItem(${JSON.stringify(k)})` : `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(";")}; location.reload(); return 1`).catch(() => {});

try {
  await send("Performance.enable");
  if (!JSON_OUT) console.log(`Creando proyecto sintético (${FILES} archivos + 3 grandes)…`);
  makeProject();
  const session = { root: ROOT, layout: { dir: "row", focus: 0, groups: [{ paths: [], active: null, pinned: [] }] } };
  await run(`localStorage.setItem("pulso.session", ${JSON.stringify(JSON.stringify(session))}); localStorage.setItem("pulso.lastRoot", ${JSON.stringify(ROOT)}); return 1`);

  // 1) Arranque: desde pedir la recarga hasta ver el explorador con la carpeta cargada.
  const starts = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await run(`location.reload(); return 1`);
    await wait(200);
    await waitFor(`return document.body.classList.contains("ready") && !document.getElementById("splash") && document.querySelectorAll("#tree .node").length > 0`, "el arranque");
    starts.push(performance.now() - t0);
  }
  log("Arranque hasta explorador listo (ms, 3 veces)", starts.map(ms));
  await wait(1500);

  // 2) Apertura de archivos: clic en el explorador hasta ver líneas pintadas.
  const openFile = async (name) => {
    const t0 = performance.now();
    await run(`const n=[...document.querySelectorAll("#tree .node")].find(n=>n.querySelector(".name")?.textContent===${JSON.stringify(name)}); if(!n) throw new Error("sin nodo ${name}"); n.click(); return 1`);
    await waitFor(`return document.querySelector(".tab.active .tlabel")?.textContent===${JSON.stringify(name)} && document.querySelectorAll(".group.focused .view-line").length>0`, `abrir ${name}`);
    return performance.now() - t0;
  };
  log("Abrir archivo pequeño (ms)", ms(await openFile("small.ts")));
  log("Abrir archivo de 0,5 MB (ms)", ms(await openFile("medium.ts")));
  log("Abrir archivo de 5 MB (ms)", ms(await openFile("big.ts")));
  await wait(2500);

  // 3) Escritura en el archivo de 5 MB: tiempo desde insertar un carácter hasta que se pinta.
  await run(`document.querySelector(".group.focused textarea").focus(); return 1`);
  const lat = [];
  for (let i = 0; i < 120; i++) {
    const t0 = performance.now();
    await send("Input.insertText", { text: "x" });
    await run(`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return 1`);
    lat.push(performance.now() - t0);
    await wait(15);
  }
  log("Escribir en archivo de 5 MB (ms: mediana / p95 / peor)", [ms(pct(lat, 0.5)), ms(pct(lat, 0.95)), ms(Math.max(...lat))]);
  await run(`document.querySelector(".group.focused textarea").focus(); return 1`);
  // Pegar un bloque grande de una vez con un evento de pegado real. (No se usa Input.insertText: ese camino
  // de CDP simula escritura carácter a carácter y congela Monaco con bloques grandes, lo que no es un pegado.)
  // Si la interfaz se congela, se informa en vez de esperar sin fin.
  const block = "const z = 1;" + String.fromCharCode(10);
  const pasted = block.repeat(20000);
  const t1 = performance.now();
  const outcome = await Promise.race([
    run(`const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(pasted)}); document.querySelector(".group.focused textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return 1`).then(() => "ok"),
    wait(180000).then(() => "timeout"),
  ]);
  log("Pegar 20.000 líneas en archivo de 5 MB (ms)", outcome === "ok" ? ms(performance.now() - t1) : "la interfaz no respondió en 180 s");
  if (outcome !== "ok") throw new Error("La interfaz quedó congelada tras el pegado; se detiene la medición.");

  // 4) Búsqueda y listado en todo el proyecto (comandos nativos).
  const timeInvoke = async (cmd, args) => { const t0 = performance.now(); const out = await invoke(cmd, args); return { ms: ms(performance.now() - t0), n: Array.isArray(out) ? out.length : out }; };
  log("Buscar en el proyecto, 1 resultado raro (ms)", await timeInvoke("search_files", { root: ROOT, query: "valor-77777", caseSensitive: true, useRegex: false, wholeWord: false, include: [], unsaved: {} }));
  log("Buscar en el proyecto, muchos resultados (ms)", await timeInvoke("search_files", { root: ROOT, query: "return", caseSensitive: true, useRegex: false, wholeWord: false, include: [], unsaved: {} }));
  log("Listar archivos para abrir rápido (ms)", await timeInvoke("list_files", { path: ROOT }));
  { const g = await timeInvoke("git_status", { path: ROOT }).catch((e) => String(e)); log("Estado de Git (ms)", typeof g === "object" ? { ms: g.ms, archivos: g.n?.files?.length } : g); }

  // 5) Memoria con el proyecto cargado y los archivos grandes abiertos.
  await wait(1000);
  log("Memoria del JavaScript (MB)", await jsHeapMb());
  log("Memoria de Pulso y sus procesos hijos (MB)", processMemory());
} finally {
  // Primero se borran las copias de recuperación de la prueba y después se recarga: si no, la próxima
  // ejecución de la app (o de las pruebas e2e) encuentra un aviso de recuperación de archivos que ya no existen.
  const dropBackups = async () => { for (const b of (await invoke("backup_list").catch(() => [])) ?? []) if (b.path.startsWith(ROOT)) await invoke("backup_remove", { path: b.path }).catch(() => {}); };
  await dropBackups();
  await restore();
  await wait(300);
  // Las ediciones de la prueba dejan copias de recuperación de archivos temporales: se borran.
  for (const b of (await invoke("backup_list").catch(() => [])) ?? []) if (b.path.startsWith(ROOT)) await invoke("backup_remove", { path: b.path }).catch(() => {});
  ws.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(ROOT, { recursive: true, force: true }); break; } catch { await wait(500); } }
  if (JSON_OUT) console.log(JSON.stringify(r, null, 2));
}
