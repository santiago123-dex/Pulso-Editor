// Ejecuta una copia aislada de Pulso con WebView2 y verifica hover y navegación reales.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join, sep, basename } from "node:path";
import assert from "node:assert/strict";

const parent = resolve("src-tauri/target");
const root = await mkdtemp(join(parent, "pulso-lsp-ui-"));
const workspace = join(root, "project");
const profile = join(root, "webview");
const port = 19337;
// PULSO_EXE permite probar la versión instalada: PULSO_EXE="%LOCALAPPDATA%\Pulso Editor\pulso-editor.exe" npm run test:lsp:ui
const executable = process.env.PULSO_EXE ? resolve(process.env.PULSO_EXE) : resolve("src-tauri/target/debug/pulso-editor.exe");
let app, socket;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (fn, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn().catch(() => null); if (value) return value; await sleep(150); }
  throw new Error(`Tiempo agotado: ${label}`);
};
try {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, baseUrl: ".", paths: { "@/*": ["./*"] } } }));
  await writeFile(join(workspace, "other.ts"), "export const saludo: string = 'hola';\n");
  await writeFile(join(workspace, "main.tsx"), "import { saludo } from '@/other';\nconst valor: number = \"texto\";\nsaludo;\n");
  app = spawn(executable, [], { windowsHide: true, env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
  const page = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === "page"), "WebView2 de prueba");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
  const send = (method, params = {}) => new Promise((done) => { const requestId = ++id; pending.set(requestId, done); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const run = async (code) => {
    const response = await send("Runtime.evaluate", { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
    return response.result?.result?.value;
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitFor(() => run(`return !!document.getElementById('app')`), "inicio de Pulso");
  const rootPath = workspace.replace(/\\/g, "/"), file = `${rootPath}/main.tsx`;
  const session = { root: rootPath, layout: { dir: "row", focus: 0, groups: [{ paths: [file], active: file, pinned: [] }] } };
  await run(`localStorage.setItem('pulso.session', ${JSON.stringify(JSON.stringify(session))}); location.reload();`);
  await waitFor(() => run(`return !!document.querySelector('.group.focused .view-line')`), "editor y archivo");
  await run(`window.__statusLog = []; const el = document.getElementById('status-left'); window.__statusLog.push(el.textContent); new MutationObserver(() => window.__statusLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });`);
  await waitFor(() => run(`return !document.getElementById('splash')`), "pantalla de inicio cerrada");
  const coordinates = async (line, word) => run(`
    const row = document.querySelectorAll('.group.focused .view-line')[${line - 1}];
    if (!row) return null;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, at = node.textContent.indexOf(${JSON.stringify(word)});
      if (at >= 0) { const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + ${word.length}); const r = range.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  `);
  const hoverAt = async (point) => { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }); };
  const ctrlClick = async (point) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers: 2 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, modifiers: 2 });
    await sleep(100);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  };
  const expectHover = async (point, pattern, label) => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await hoverAt({ x: 15, y: 400 });
      await sleep(600);
      await hoverAt(point);
      await sleep(900);
      const text = (await run(`return [...document.querySelectorAll('.monaco-hover')].map(e => e.textContent).join(' ')`)) || "";
      if (pattern.test(text)) return;
    }
    throw new Error(`No apareció ${label}; contenido: ${await run(`return [...document.querySelectorAll('.monaco-hover')].map(e => e.textContent).join(' ')`)}`);
  };
  let symbol = await waitFor(() => coordinates(3, "saludo"), "posición del símbolo");
  // No esperar a la inicialización: la primera acción debe terminar navegando.
  const coldClickAt = performance.now();
  await ctrlClick(symbol);
  try { await waitFor(() => run(`return [...document.querySelectorAll('.tab.active .tlabel')].some(e => e.textContent === 'other.ts')`), "primer Ctrl+clic durante el arranque", 30000); }
  catch (e) { console.error("Estado del primer clic:", await run(`return { log: window.__statusLog, active: document.querySelector('.tab.active')?.textContent, position: document.getElementById('status-pos')?.textContent }`)); throw e; }
  console.log(`Primera navegación en proyecto de prueba: ${Math.round(performance.now() - coldClickAt)} ms`);
  await run(`const tab = [...document.querySelectorAll('.tab')].find(e => e.querySelector('.tlabel')?.textContent === 'main.tsx'); tab.click();`);
  await waitFor(() => run(`return document.querySelector('.tab.active .tlabel')?.textContent === 'main.tsx'`), "volver al archivo de origen");
  try { await waitFor(() => run(`return window.__statusLog.some(t => t.includes('activada'))`), "servidor LSP activo"); }
  catch (e) { console.error("Estado de Pulso:", await run(`return window.__statusLog`)); throw e; }
  await waitFor(() => run(`const e = document.getElementById('status-lsp'); return !e.hidden && e.textContent === 'LSP: activo'`), "indicador LSP: activo en la barra de estado");
  symbol = await waitFor(() => coordinates(3, "saludo"), "posición del símbolo");
  await expectHover(symbol, /saludo/i, "hover del símbolo");
  await waitFor(() => run(`return !!document.querySelector('.squiggly-error')`), "diagnóstico del error", 30000);
  const error = await waitFor(() => coordinates(2, "valor"), "posición del error");
  await expectHover(error, /assignable|asignable/i, "mensaje del error");
  await hoverAt({ x: 15, y: 400 });
  await sleep(600);
  await hoverAt(symbol);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: symbol.x, y: symbol.y, modifiers: 2 });
  await waitFor(() => run(`const link = document.querySelector('.gcode.pulso-definition-ready .pulso-definition-link'); return !!link && getComputedStyle(link).cursor === 'pointer'`), "cursor pointer y subrayado de definición");
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  await waitFor(() => run(`return !document.querySelector('.gcode.pulso-definition-ready')`), "restauración del cursor");
  await run(`window.__clickLog = []; for (const kind of ['mousedown', 'mouseup']) document.addEventListener(kind, e => window.__clickLog.push({ kind, ctrl: e.ctrlKey, button: e.button, tag: e.target.outerHTML.slice(0, 150) }), true); const originalInvoke = window.__TAURI_INTERNALS__.invoke; window.__lspLog = []; window.__TAURI_INTERNALS__.invoke = (...args) => { if (args[0] === 'lsp_send') window.__lspLog.push(args[1]?.message?.method); return originalInvoke(...args); };`);
  await ctrlClick(symbol);
  try {
    await waitFor(() => run(`return [...document.querySelectorAll('.tab.active .tlabel')].some(e => e.textContent === 'other.ts')`), "Ctrl+clic abre la definición", 12000);
  } catch (e) {
    console.error("Pestañas y estado:", await run(`return { tabs: [...document.querySelectorAll('.tab')].map(e => e.textContent), status: document.getElementById('status-left').textContent, position: document.getElementById('status-pos').textContent, active: document.querySelector('.tab.active')?.textContent, target: document.elementFromPoint(${symbol.x}, ${symbol.y})?.outerHTML?.slice(0, 250), clicks: window.__clickLog, lsp: window.__lspLog }`));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "F12", code: "F12", windowsVirtualKeyCode: 123 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "F12", code: "F12", windowsVirtualKeyCode: 123 });
    await sleep(3000);
    console.error("Resultado F12:", await run(`return { tabs: [...document.querySelectorAll('.tab')].map(e => e.textContent), status: document.getElementById('status-left').textContent, position: document.getElementById('status-pos').textContent }`));
    throw e;
  }
  assert.ok(!String(await run(`return document.getElementById('status-left').textContent`)).includes('already exists'));
  await run(`const item = [...document.querySelectorAll('.node')].find(e => e.querySelector('.name')?.textContent === 'other.ts'); if (!item) throw new Error('No aparece other.ts en el explorador'); item.click();`);
  await sleep(800);
  assert.equal(await run(`return [...document.querySelectorAll('.tab .tlabel')].filter(e => e.textContent === 'other.ts').length`), 1, "el mismo archivo no debe duplicarse");
  assert.ok(!String(await run(`return document.getElementById('status-left').textContent`)).includes('already exists'));
  console.log("Pulso real: primer clic, cursor pointer, hover, error y reapertura sin duplicados: OK");
} finally {
  socket?.close();
  if (app && app.exitCode === null) { app.kill(); await Promise.race([new Promise((done) => app.once("exit", done)), sleep(3000)]); }
  // Solo limpiar el directorio único creado para esta prueba dentro de target.
  if (!resolve(root).startsWith(parent + sep) || !basename(root).startsWith("pulso-lsp-ui-")) throw new Error("Ruta temporal inesperada");
  for (let i = 0; i < 10; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { if (i === 9) console.warn(`No se pudo borrar ${root}`); else await sleep(500); } }
}
