// Solo para una compilación con identificador propio creada por perf-prepare-isolated.mjs.
// La edición ocurre en memoria: no se guarda ni se escribe en el proyecto medido.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(process.argv[2] || ""), file = resolve(root, process.argv[3] || "");
if (!process.argv[2] || !process.argv[3] || !process.env.PULSO_ISOLATED_EXE) throw new Error("Indica carpeta, archivo y PULSO_ISOLATED_EXE; no uses la aplicación habitual.");
if (resolve(process.env.PULSO_ISOLATED_EXE).toLowerCase() !== resolve("src-tauri/target/release/pulso-editor.exe").toLowerCase()) throw new Error("El ejecutable debe pertenecer a esta copia aislada.");
const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
if (!/^dev\.pulso\.perftest\d+$/.test(config.identifier)) throw new Error("La copia no tiene identificador aislado.");
const profile = resolve("src-tauri/target/perf-webview"), port = 19541;
await mkdir(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, max = 45000) => { const end = Date.now() + max; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await sleep(150); } throw new Error(`Tiempo agotado: ${label}`); };
const listProcesses = () => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process node,msedgewebview2,pulso-editor -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  try { const p = JSON.parse(r.stdout || "[]"); return Array.isArray(p) ? p : [p]; } catch { return []; }
};
const before = new Set(listProcesses().map(p => p.Id));
const started = performance.now();
const app = spawn(resolve(process.env.PULSO_ISOLATED_EXE), [], { windowsHide: true, env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let ws;
try {
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === "page"), "WebView2");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const data = JSON.parse(e.data); const callback = pending.get(data.id); if (callback) { pending.delete(data.id); callback(data); } };
  const send = (method, params = {}) => new Promise(ok => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async code => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${code}})()`, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result?.result?.value; };
  await send("Performance.enable");
  await until(() => run("return !!document.getElementById('app')"), "arranque");
  const rootPath = root.replace(/\\/g, "/"), filePath = file.replace(/\\/g, "/");
  const session = { root: rootPath, layout: { dir: "row", focus: 0, groups: [{ paths: [filePath], active: filePath, pinned: [] }] } };
  await run(`const settings=JSON.parse(localStorage.getItem('pulso.settings')||'{}'); settings.autoSave=false; localStorage.setItem('pulso.settings', JSON.stringify(settings)); localStorage.setItem('pulso.session', ${JSON.stringify(JSON.stringify(session))}); localStorage.setItem('pulso.lastRoot', ${JSON.stringify(rootPath)}); location.reload();`);
  const openAt = performance.now();
  await until(() => run("return !!document.querySelector('.group.focused .view-line') && !document.getElementById('splash')"), "archivo abierto");
  const opened = performance.now();
  await until(() => run("return document.getElementById('status-lsp')?.textContent?.includes('activo')"), "LSP activo");
  await run("document.querySelector('.group.focused textarea')?.focus(); return 1");
  const typing = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await send("Input.insertText", { text: " " });
    await run("await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return 1");
    typing.push(Math.round(performance.now() - t));
  }
  typing.sort((a, b) => a - b);
  await sleep(5000);
  const metrics = (await send("Performance.getMetrics")).result.metrics;
  const processes = listProcesses().filter(p => !before.has(p.Id) || p.Id === app.pid);
  console.log(JSON.stringify({ archivo: process.argv[3], arranque_hasta_webview_ms: Math.round(openAt - started), restaurar_proyecto_y_archivo_ms: Math.round(opened - openAt), escritura_ms_mediana_p95_max: [typing[Math.floor(typing.length / 2)], typing[Math.floor(typing.length * .95)], typing.at(-1)], heap_js_mb: Math.round((metrics.find(x => x.name === "JSHeapUsedSize")?.value ?? 0) / 1048576), procesos_nuevos: processes.map(p => ({ nombre: p.ProcessName, pid: p.Id, mb: Math.round(p.WorkingSet64 / 1048576) })), nota: "Procesos nuevos observados, no se garantiza que todos pertenezcan a Pulso. La edición no se guardó en el proyecto." }, null, 2));
  await run("await window.__TAURI_INTERNALS__.invoke('lsp_stop'); return 1");
} finally { ws?.close(); app.kill(); }
