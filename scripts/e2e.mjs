// Pruebas de extremo a extremo sobre la app real de Pulso.
//
// Requisitos: la app debe estar en ejecución con el puerto de depuración de WebView2 abierto:
//   PowerShell:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"; npx tauri dev
//   Después:     npm run e2e
//
// El script usa una carpeta temporal, no toca tus proyectos y restaura la sesión y la configuración al terminar.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = process.env.PULSO_CDP_PORT ?? "9222";
const ROOT = path.join(os.tmpdir(), `pulso-e2e-${process.pid}`).replace(/\\/g, "/");

let targets;
try {
  targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
} catch {
  console.error(`No se pudo conectar con la app en el puerto ${PORT}.\nInicia la app con WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=${PORT}" y vuelve a intentarlo.`);
  process.exit(2);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

/** Ejecuta código dentro de la página. Se envuelve en una función para que no choquen las variables. */
const run = async (code) => {
  const r = (await send("Runtime.evaluate", { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })).result;
  if (r.exceptionDetails) throw new Error("Error en la página: " + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
  return r.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (code, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await run(code).catch(() => false)) return;
    await wait(120);
  }
  throw new Error(`Tiempo agotado esperando: ${what}`);
};
const key = (k, m = {}) => run(`(${m.target ? "document.querySelector(" + JSON.stringify(m.target) + ")" : "window"}).dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(k)},code:${JSON.stringify(m.code ?? "")},ctrlKey:${!!m.ctrl},shiftKey:${!!m.shift},altKey:${!!m.alt},bubbles:true,cancelable:true})); return 1`);
const invoke = (cmd, args = {}) => run(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const tabs = () => run(`return [...document.querySelectorAll(".group")].map(g=>[...g.querySelectorAll(".tab")].map(t=>t.querySelector(".tlabel").textContent+(t.classList.contains("dirty")?"*":"")))`);
const dialog = () => run(`const m=document.querySelector(".modal"); return m && {title:m.querySelector(".modal-title")?.textContent, buttons:[...m.querySelectorAll(".mbtn")].map(b=>b.textContent)}`);
const clickBtn = (label) => run(`const b=[...document.querySelectorAll(".mbtn")].find(b=>b.textContent===${JSON.stringify(label)}); if(!b) throw new Error("no hay botón ${label}"); b.click(); return 1`);
const typeInEditor = async (text) => {
  await run(`document.querySelector(".group.focused textarea").focus(); return 1`);
  await send("Input.insertText", { text });
};
const bootApp = async (session) => {
  await run(`localStorage.setItem("pulso.session", JSON.stringify(${JSON.stringify(session)})); location.reload(); return 1`);
  await wait(1500);
  await waitFor(`return !!document.getElementById("tree") && document.querySelectorAll("#tree .node").length > 0`, "que cargue el explorador", 20000);
  await wait(600);
};
const session = (groups, focus = 0) => ({ root: ROOT, layout: { dir: "row", focus, groups: groups.map((paths) => ({ paths: paths.map((p) => `${ROOT}/${p}`), active: `${ROOT}/${paths[0]}`, pinned: [] })) } });
const nodeNames = () => run(`return [...document.querySelectorAll("#tree .node")].map(n=>n.querySelector(".name").textContent)`);
const ctxMenu = (name, item) => run(`
  const n=[...document.querySelectorAll("#tree .node")].find(n=>n.querySelector(".name").textContent===${JSON.stringify(name)});
  n.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:100,clientY:100}));
  const it=[...document.querySelectorAll(".ctx-item")].find(i=>i.firstChild.textContent===${JSON.stringify(item)});
  it.click(); return 1`);
const answerPrompt = (value) => run(`const i=document.querySelector(".modal-input"); i.value=${JSON.stringify(value)}; i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})); return 1`);

// ---------- Mini marco de pruebas ----------
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what ?? "valor"}: se esperaba ${b} y salió ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const read = (rel) => fs.readFileSync(`${ROOT}/${rel}`, "utf8");
const exists = (rel) => fs.existsSync(`${ROOT}/${rel}`);
const write = (rel, text) => { fs.mkdirSync(path.dirname(`${ROOT}/${rel}`), { recursive: true }); fs.writeFileSync(`${ROOT}/${rel}`, text); };
const leftoverTmp = () => fs.readdirSync(ROOT, { recursive: true }).filter((f) => String(f).endsWith(".tmp"));

// ---------- Preparación ----------
// El token real del usuario se conserva: algunas pruebas lo reemplazan y siempre se restaura al terminar.
const savedToken = await run(`return await window.__TAURI_INTERNALS__.invoke("secret_get", { name: "github-token" })`).catch(() => null);
const saved = await run(`return { session: localStorage.getItem("pulso.session"), settings: localStorage.getItem("pulso.settings"), recent: localStorage.getItem("pulso.recent"), lastRoot: localStorage.getItem("pulso.lastRoot") }`);
await run(`localStorage.setItem("pulso.noAutoConnect", "1"); return 1`);
fs.rmSync(ROOT, { recursive: true, force: true });
write("a.txt", "hola mundo\nsegunda hola linea\n");
write("sub/b.ts", "export const x = 1;\n// hola\n");
write("notas.md", "# notas\n");
await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
for (const b of (await invoke("backup_list")) ?? []) if (b.path.startsWith(ROOT)) await invoke("backup_remove", { path: b.path });

console.log(`\nPruebas e2e de Pulso (carpeta temporal: ${ROOT})\n`);

try {
  console.log("Sesión y archivos");
  await test("restaura la sesión con dos grupos y sus pestañas", async () => {
    await bootApp(session([["a.txt"], ["sub/b.ts"]]));
    eq(await tabs(), [["a.txt"], ["b.ts"]]);
    eq((await nodeNames()).sort(), ["a.txt", "notas.md", "sub"]);
  });

  await test("crea un archivo dentro de carpetas nuevas y lo abre", async () => {
    await run(`document.getElementById("ex-new-file").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal-input")`, "el diálogo de nombre");
    await answerPrompt("c/d/nuevo.js");
    await waitFor(`return [...document.querySelectorAll(".tab")].some(t=>t.textContent.includes("nuevo.js"))`, "la pestaña nueva");
    ok(exists("c/d/nuevo.js"), "el archivo debe existir en disco");
  });

  await test("renombra un archivo abierto: disco y pestaña cambian", async () => {
    await ctxMenu("a.txt", "Renombrar…");
    await waitFor(`return !!document.querySelector(".modal-input")`, "el diálogo de renombrar");
    await answerPrompt("renombrado.txt");
    await waitFor(`return [...document.querySelectorAll(".tab")].some(t=>t.textContent.includes("renombrado.txt"))`, "la pestaña renombrada");
    ok(exists("renombrado.txt") && !exists("a.txt"), "debe haberse renombrado en disco");
    eq(read("renombrado.txt"), "hola mundo\nsegunda hola linea\n");
  });

  console.log("\nGuardado seguro");
  await test("editar marca la pestaña, cerrar pide confirmar y Cancelar la conserva", async () => {
    await run(`document.querySelector(".tab .close").click(); return 1`).catch(() => {});
    await bootApp(session([["renombrado.txt"]]));
    await typeInEditor("// cambio\n");
    await waitFor(`return !!document.querySelector(".tab.dirty")`, "la marca de sin guardar");
    await run(`document.querySelector(".group.focused .tab.active .close").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal")`, "el aviso de cambios sin guardar");
    eq((await dialog()).buttons, ["Guardar", "No guardar", "Cancelar"]);
    await clickBtn("Cancelar");
    eq(await tabs(), [["renombrado.txt*"]]);
  });

  await test("Ctrl+S guarda de forma atómica: contenido exacto y sin archivos temporales", async () => {
    await key("s", { ctrl: true });
    await waitFor(`return !document.querySelector(".tab.dirty")`, "que termine de guardar");
    ok(read("renombrado.txt").startsWith("// cambio\n"), "el disco debe tener lo escrito");
    eq(leftoverTmp(), [], "archivos .tmp sobrantes");
  });

  await test("un cambio externo en un archivo limpio se recarga solo", async () => {
    write("renombrado.txt", "escrito por otro programa\n");
    await run(`window.dispatchEvent(new Event("focus")); return 1`);
    await waitFor(`return document.getElementById("status-left").textContent.includes("recargó")`, "el aviso de recarga");
  });

  await test("conflicto al guardar: Cancelar no toca el disco ni pierde lo escrito", async () => {
    await typeInEditor("MI TRABAJO ");
    await waitFor(`return !!document.querySelector(".tab.dirty")`, "la marca de sin guardar");
    write("renombrado.txt", "versión externa 2\n");
    // Se evita la recarga automática del foco para probar el choque al guardar.
    await key("s", { ctrl: true });
    await waitFor(`return !!document.querySelector(".modal")`, "el diálogo de conflicto");
    eq((await dialog()).title, "El archivo cambió en el disco");
    await clickBtn("Cancelar");
    await wait(300);
    eq(read("renombrado.txt"), "versión externa 2\n");
    eq((await tabs())[0][0].endsWith("*"), true, "la pestaña sigue sucia");
  });

  await test("conflicto al guardar: Sobrescribir guarda lo del editor", async () => {
    await key("s", { ctrl: true });
    await waitFor(`return !!document.querySelector(".modal")`, "el diálogo de conflicto");
    await clickBtn("Sobrescribir con la mía");
    await waitFor(`return !document.querySelector(".tab.dirty")`, "que termine de guardar");
    ok(read("renombrado.txt").includes("MI TRABAJO"), "el disco debe tener mi texto");
  });

  console.log("\nRecuperación tras un cierre inesperado");
  await test("se crea una copia de lo no guardado sin que el usuario haga nada", async () => {
    await typeInEditor("TEXTO SIN GUARDAR");
    await wait(2600);
    const list = await invoke("backup_list");
    const mine = list.find((b) => b.path === `${ROOT}/renombrado.txt`);
    ok(mine, "debe existir una copia");
    ok(mine.contents.includes("TEXTO SIN GUARDAR"), "la copia debe traer el texto");
    eq(read("renombrado.txt").includes("TEXTO SIN GUARDAR"), false, "el disco no debe cambiar");
  });

  await test("tras un cierre inesperado ofrece restaurar y deja el archivo sin guardar", async () => {
    // Recargar la página equivale a un cierre brusco: no pasa por el flujo normal de cierre.
    await run(`location.reload(); return 1`);
    await wait(1500);
    await waitFor(`return document.querySelector(".modal-title")?.textContent === "Recuperar cambios sin guardar"`, "el aviso de recuperación", 20000);
    eq((await dialog()).buttons, ["Descartar", "Más tarde", "Restaurar"]);
    eq(await run(`return document.body.classList.contains("ready")`), true, "la pantalla de carga no debe tapar el aviso de recuperación");
    await clickBtn("Restaurar");
    await waitFor(`return !!document.querySelector(".tab.dirty")`, "la pestaña sucia");
    // Monaco pinta las líneas en el siguiente fotograma: se espera al texto en vez de leerlo al instante.
    await waitFor(`return (document.querySelector(".group.focused .view-lines")?.textContent ?? "").includes("TEXTO SIN GUARDAR")`, "el texto recuperado en el editor", 5000).catch(() => {});
    const text = (await run(`return document.querySelector(".group.focused .view-lines").textContent`)).replace(/ /g, " ");
    ok(text.includes("TEXTO SIN GUARDAR"), `el editor debe mostrar el texto recuperado; muestra: ${JSON.stringify(text.slice(0, 120))}`);
    eq(read("renombrado.txt").includes("TEXTO SIN GUARDAR"), false, "el disco sigue igual hasta guardar");
  });

  await test("cerrar sin guardar a propósito elimina la copia", async () => {
    await run(`document.querySelector(".group.focused .tab.active .close").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal")`, "el aviso");
    await clickBtn("No guardar");
    await wait(600);
    const list = await invoke("backup_list");
    eq(list.some((b) => b.path === `${ROOT}/renombrado.txt`), false, "no debe quedar copia");
  });

  await test("'Descartar' en el aviso borra las copias", async () => {
    await run(`localStorage.setItem("pulso.session", JSON.stringify(${JSON.stringify(session([["notas.md"]]))})); return 1`);
    await invoke("backup_write", { path: `${ROOT}/notas.md`, contents: "# perdido", baseMtime: 1 });
    await run(`location.reload(); return 1`);
    await wait(1500);
    await waitFor(`return document.querySelector(".modal-title")?.textContent === "Recuperar cambios sin guardar"`, "el aviso de recuperación", 20000);
    await clickBtn("Descartar");
    await wait(500);
    eq((await invoke("backup_list")).some((b) => b.path.startsWith(ROOT)), false, "copias restantes");
    eq(read("notas.md"), "# notas\n");
  });

  console.log("\nBuscar y reemplazar, y eliminar");
  await test("reemplaza en todos los archivos y recarga los abiertos", async () => {
    await bootApp(session([["notas.md"], ["sub/b.ts"]]));
    await key("F", { ctrl: true, shift: true });
    await wait(400);
    await run(`const q=document.getElementById("sq"); q.value="hola"; q.dispatchEvent(new Event("input"));
               const r=document.getElementById("sr"); r.value="ADIÓS"; r.dispatchEvent(new Event("input")); return 1`);
    await waitFor(`return document.querySelectorAll(".smatch").length > 0`, "los resultados");
    await run(`document.getElementById("sr-all").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal")`, "la confirmación");
    await clickBtn("Reemplazar");
    await wait(1500);
    ok(read("sub/b.ts").includes("// ADIÓS"), "b.ts debe estar reemplazado");
    ok(read("renombrado.txt").includes("ADIÓS") || !read("renombrado.txt").includes("hola"), "no deben quedar 'hola' en renombrado.txt");
    const shown = await run(`return [...document.querySelectorAll(".group")].map(g=>g.querySelector(".view-lines")?.textContent ?? "")`);
    ok(shown.join("").includes("ADIÓS"), "el editor abierto debe mostrar el reemplazo");
  });

  await test("elimina a la papelera: desaparece del disco y su pestaña se cierra", async () => {
    await run(`document.querySelector('.act[data-view="explorer"]').click(); return 1`);
    await ctxMenu("notas.md", "Eliminar");
    await waitFor(`return !!document.querySelector(".modal")`, "la confirmación");
    await clickBtn("Mover a la papelera");
    await waitFor(`return ![...document.querySelectorAll("#tree .node")].some(n=>n.textContent.includes("notas.md"))`, "que desaparezca del árbol");
    eq(exists("notas.md"), false, "debe estar fuera de la carpeta");
    eq((await tabs()).flat().some((t) => t.startsWith("notas.md")), false, "su pestaña debe cerrarse");
  });

  console.log("\nToken de GitHub");
  await test("el token se guarda en el almacén del sistema y no en localStorage", async () => {
    const marker = "ghp_e2e_" + Date.now();
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await wait(300);
    await run(`document.querySelector('.sp-nav-btn[data-sec="github"]').click(); return 1`);
    await wait(200);
    await run(`const i=document.getElementById("st-token"); i.value=${JSON.stringify(marker)}; i.dispatchEvent(new Event("change")); return 1`);
    await wait(800);
    eq(await invoke("secret_get", { name: "github-token" }), marker, "valor en el almacén");
    const inStorage = await run(`return Object.values(localStorage).join("|")`);
    eq(inStorage.includes(marker), false, "el token no debe estar en localStorage");
    await run(`const i=document.getElementById("st-token"); i.value=""; i.dispatchEvent(new Event("change")); return 1`);
    await wait(600);
    eq(await invoke("secret_get", { name: "github-token" }), null, "tras vaciar");
  });

  console.log("\nConfiguración y atajos");
  await test("la configuración es una página con secciones y se cierra con Esc", async () => {
    await bootApp(session([["sub/b.ts"]]));
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await waitFor(`return !document.getElementById("settings-page").hidden`, "la página");
    eq(await run(`return [...document.querySelectorAll(".sp-nav-btn")].map(b=>b.textContent)`), ["Apariencia", "Editor", "Terminal", "Atajos de teclado", "GitHub", "Acerca de"]);
    await run(`document.querySelector('.sp-nav-btn[data-sec="editor"]').click(); return 1`);
    eq(await run(`return document.querySelector(".sp-section:not([hidden]) h2").textContent`), "Editor");
    await run(`const s=document.getElementById("sp-search"); s.value="minimapa"; s.dispatchEvent(new Event("input")); return 1`);
    eq(await run(`return [...document.querySelectorAll(".sp-row:not([hidden]) .sp-label")].map(l=>l.textContent)`), ["Minimapa"], "la búsqueda filtra los ajustes");
    await run(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return 1`);
    eq(await run(`return document.getElementById("sp-search").value`), "", "el primer Esc limpia la búsqueda");
    await run(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return 1`);
    await waitFor(`return document.getElementById("settings-page").hidden`, "que se cierre");
  });

  await test("un ajuste se aplica al instante y se guarda", async () => {
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await run(`document.querySelector('.sp-nav-btn[data-sec="editor"]').click(); return 1`);
    const before = await run(`return document.getElementById("st-wrap").checked`);
    await run(`document.getElementById("st-wrap").click(); return 1`);
    eq(await run(`return JSON.parse(localStorage.getItem("pulso.settings")).wordWrap`), !before);
    await run(`document.getElementById("st-wrap").click(); return 1`);
    eq(await run(`return JSON.parse(localStorage.getItem("pulso.settings")).wordWrap`), before);
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
  });

  await test("módulo de atajos: se graba una combinación, funciona de verdad y se restablece", async () => {
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await run(`document.querySelector('.sp-nav-btn[data-sec="keys"]').click(); return 1`);
    await waitFor(`return document.querySelectorAll(".kb-row:not(.fixed)").length > 20`, "la lista de comandos");
    eq(await run(`return document.querySelector('.kb-row[data-cmd="terminal.toggle"] .kb-chips').textContent`), "CtrlJ", "la terminal usa Ctrl+J");
    await run(`document.querySelector('.kb-row[data-cmd="file.save"] .kb-key').click(); return 1`);
    await waitFor(`return !!document.querySelector('.kb-row[data-cmd="file.save"] .kb-rec')`, "el modo de grabación");
    await key("k", { ctrl: true, alt: true });
    await waitFor(`return document.querySelector('.kb-row[data-cmd="file.save"] .kb-chips')?.textContent === "CtrlAltK"`, "la nueva combinación");
    eq(await run(`return JSON.parse(localStorage.getItem("pulso.settings")).keybindings`), { "file.save": "Ctrl+Alt+K" });
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    // La combinación nueva guarda de verdad y la vieja ya no.
    await typeInEditor("// atajo nuevo\n");
    await waitFor(`return !!document.querySelector(".tab.dirty")`, "que quede sin guardar");
    await key("s", { ctrl: true });
    await wait(500);
    eq(await run(`return !!document.querySelector(".tab.dirty")`), true, "Ctrl+S ya no guarda");
    await key("k", { ctrl: true, alt: true });
    await waitFor(`return !document.querySelector(".tab.dirty")`, "que Ctrl+Alt+K guarde");
    ok(read("sub/b.ts").includes("// atajo nuevo"), "el disco debe tener el cambio");
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await run(`document.querySelector('.kb-row[data-cmd="file.save"]').dispatchEvent(new MouseEvent("mouseenter")); document.querySelector('.kb-row[data-cmd="file.save"] .kb-actions button[title="Volver al atajo de fábrica"]').click(); return 1`);
    eq(await run(`return JSON.parse(localStorage.getItem("pulso.settings")).keybindings`), {}, "vuelve al valor de fábrica");
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
  });

  await test("módulo de atajos: avisa de los conflictos y de las teclas del editor", async () => {
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await run(`document.querySelector('.sp-nav-btn[data-sec="keys"]').click(); return 1`);
    await run(`document.querySelector('.kb-row[data-cmd="file.save"] .kb-key').click(); return 1`);
    await key("o", { ctrl: true });
    await waitFor(`return document.querySelector(".modal-title")?.textContent === "Atajo en uso"`, "el aviso de conflicto");
    ok((await run(`return document.querySelector(".modal-msg").textContent`)).includes("Abrir carpeta"), "nombra al comando afectado");
    await clickBtn("Cancelar");
    eq(await run(`return JSON.parse(localStorage.getItem("pulso.settings")).keybindings`), {}, "cancelar no cambia nada");
    await run(`document.querySelector('.kb-row[data-cmd="file.save"] .kb-key').click(); return 1`);
    await key("z", { ctrl: true });
    await waitFor(`return document.querySelector(".modal-title")?.textContent === "Tecla reservada del editor"`, "el aviso de tecla reservada");
    await clickBtn("Cancelar");
    await run(`document.getElementById("kb-bykey").click(); return 1`);
    await key("j", { ctrl: true });
    await waitFor(`return [...document.querySelectorAll(".kb-row:not(.fixed) .kb-label")].length === 1`, "el filtro por tecla");
    eq(await run(`return document.querySelector(".kb-row:not(.fixed) .kb-label").textContent`), "Mostrar u ocultar");
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
  });

  await test("la sección Terminal lista las shells y los esquemas de colores", async () => {
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await run(`document.querySelector('.sp-nav-btn[data-sec="terminal"]').click(); return 1`);
    await waitFor(`return document.querySelectorAll("#st-termshell option").length > 1 && document.querySelectorAll("#st-termscheme option").length > 3`, "las listas", 10000);
    ok((await run(`return document.querySelectorAll("#st-fonts option").length`)) > 5, "debe ofrecer las fuentes instaladas");
    ok((await run(`return [...document.querySelectorAll("#st-termscheme option")].map(o=>o.text)`)).includes("Campbell (Windows)"));
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
  });

  console.log("\nArranque");
  await test("al abrir sin sesión guardada reabre la última carpeta usada", async () => {
    await run(`localStorage.removeItem("pulso.session"); localStorage.setItem("pulso.lastRoot", ${JSON.stringify(ROOT)}); location.reload(); return 1`);
    await wait(1500);
    await waitFor(`return document.querySelectorAll("#tree .node").length > 0`, "que cargue la carpeta", 20000);
    eq(await run(`return document.getElementById("folder-name").textContent`), path.basename(ROOT));
  });

  await test("la pantalla de carga desaparece cuando la app está lista y no queda a medias", async () => {
    await waitFor(`return document.body.classList.contains("ready") && !document.getElementById("splash")`, "que se retire la pantalla de carga", 8000);
    eq(await run(`return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase() !== "#ff5a3c"`), true, "no debe verse el naranja antiguo");
    eq(await run(`return document.querySelectorAll(".group").length >= 1 && !!document.querySelector(".tabs")`), true, "el editor está construido");
  });

  await test("un arranque lento no borra la sesión guardada", async () => {
    // Se guarda una sesión, se recarga y se comprueba que sigue intacta aunque el editor haya avisado de cambios al crearse.
    await run(`localStorage.setItem("pulso.session", JSON.stringify(${JSON.stringify(session([["sub/b.ts"]]))})); location.reload(); return 1`);
    await wait(1500);
    await waitFor(`return !!document.querySelector(".tab")`, "que se restauren las pestañas", 20000);
    await wait(1500); // más que el retraso del guardado de sesión
    const saved = JSON.parse(await run(`return localStorage.getItem("pulso.session")`));
    eq(saved.root, ROOT, "la carpeta no se perdió");
    eq(saved.layout.groups[0].paths.length, 1, "las pestañas no se perdieron");
  });

  console.log("\nTerminal: adaptación a la del usuario");
  await test("la primera vez adopta la terminal de la persona sin preguntar nada", async () => {
    await run(`const s=JSON.parse(localStorage.getItem("pulso.settings")); s.terminalAdapted=false; s.terminalScheme=""; s.terminalFont=""; s.terminalShell=""; s.terminalFontSize=0; localStorage.setItem("pulso.settings", JSON.stringify(s)); localStorage.removeItem("pulso.terminalAutoAdapt"); location.reload(); return 1`);
    await wait(1500);
    await waitFor(`return document.body.classList.contains("ready")`, "el arranque", 20000);
    await key("j", { ctrl: true });
    await waitFor(`return !document.getElementById("panel").hidden`, "el panel de la terminal", 20000);
    eq(await run(`return !!document.querySelector(".modal")`), false, "no hay ninguna pregunta");
    eq(await run(`return localStorage.getItem("pulso.terminalAutoAdapt")`), "1", "queda hecho para no repetirlo");
    await invoke("term_kill_all");
    await run(`document.getElementById("term-hide").click(); return 1`);
  });

  await test("'Adaptar a mi terminal' aplica los colores de Windows Terminal a la terminal", async () => {
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
    await run(`document.querySelector('.sp-nav-btn[data-sec="terminal"]').click(); return 1`);
    await run(`document.getElementById("st-adapt").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal-title") || document.getElementById("status-left").textContent.includes("No encontré")`, "la respuesta", 10000);
    if (await run(`return !!document.querySelector(".modal-title")`)) {
      await clickBtn("Usar la mía");
      await waitFor(`return JSON.parse(localStorage.getItem("pulso.settings")).terminalAdapted === true`, "que se guarde");
      const s = JSON.parse(await run(`return localStorage.getItem("pulso.settings")`));
      ok(s.terminalScheme === "wt" || s.terminalFont || s.terminalShell, "debe haber aplicado algo de lo detectado");
    }
    await run(`document.querySelector('.act[data-view="settings"]').click(); return 1`);
  });

  console.log("\nBarra de título");
  const activeTab = () => run(`return document.querySelector(".group.focused .tab.active .tlabel")?.textContent`);

  await test("tiene hamburguesa, logo, nombre del proyecto con flechas y botones redondos", async () => {
    await bootApp(session([["sub/b.ts"]]));
    eq(await run(`return [!!document.getElementById("tb-burger"), !!document.getElementById("tb-logo"), document.getElementById("tb-label").textContent]`), [true, true, path.basename(ROOT)]);
    eq(await run(`return [!!document.getElementById("nav-back"), !!document.getElementById("nav-fwd"), document.querySelectorAll(".win-dot").length, !document.getElementById("win-controls").hidden]`), [true, true, 3, true]);
    eq(await run(`return document.querySelectorAll(".tb-menu").length`), 0, "ya no hay menús sueltos como en VS Code");
    // Con el marco nativo de Windows el alto exterior supera al interior en ~39 px; sin marco, a lo sumo 1-2 px de sombra.
    eq(await run(`return Math.abs(outerHeight - innerHeight) <= 3 && Math.abs(outerWidth - innerWidth) <= 3`), true, "la ventana no debe tener el marco blanco de Windows");
  });

  await test("la hamburguesa lista las categorías, muestra sus opciones y ejecuta comandos", async () => {
    await run(`document.getElementById("tb-burger").click(); return 1`);
    await waitFor(`return document.querySelectorAll(".hm-cat").length === 7`, "las siete categorías");
    eq(await run(`return [...document.querySelectorAll(".hm-cat")].map(c=>c.firstChild.textContent)`), ["Archivo", "Editar", "Selección", "Ver", "Ir a", "Terminal", "Ayuda"]);
    const first = await run(`return [...document.querySelectorAll(".hm-fly .ctx-item")].map(i=>i.firstChild.textContent)`);
    ok(first.includes("Abrir carpeta…") && first.includes("Guardar todo"), "Archivo se muestra por defecto");
    await run(`[...document.querySelectorAll(".hm-cat")].find(c=>c.textContent.startsWith("Ver")).dispatchEvent(new MouseEvent("mouseenter")); return 1`);
    const ver = await run(`return [...document.querySelectorAll(".hm-fly .ctx-item")].map(i=>i.firstChild.textContent)`);
    ok(ver.includes("Configuración") && ver.includes("Pantalla completa"), "pasar el ratón cambia el panel");
    await run(`[...document.querySelectorAll(".hm-fly .ctx-item")].find(i=>i.firstChild.textContent==="Configuración").click(); return 1`);
    await waitFor(`return !document.getElementById("settings-page").hidden`, "que abra Configuración");
    eq(await run(`return document.querySelectorAll(".hmenu").length`), 0, "el menú se cierra al elegir");
    await run(`document.querySelector('.act[data-view="explorer"]').click(); return 1`);
  });

  await test("la hamburguesa se cierra con Esc, con un segundo clic y al pulsar fuera", async () => {
    await run(`document.getElementById("tb-burger").click(); return 1`);
    await waitFor(`return document.querySelectorAll(".hmenu").length === 1`, "que abra");
    await run(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return 1`);
    eq(await run(`return document.querySelectorAll(".hmenu").length`), 0, "Esc");
    await run(`document.getElementById("tb-burger").click(); return 1`);
    await run(`document.getElementById("tb-burger").click(); return 1`);
    eq(await run(`return document.querySelectorAll(".hmenu").length`), 0, "segundo clic");
    await run(`document.getElementById("tb-burger").click(); return 1`);
    await run(`document.getElementById("groups").dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); return 1`);
    eq(await run(`return document.querySelectorAll(".hmenu").length`), 0, "clic fuera");
  });

  await test("el nombre del proyecto abre la búsqueda de archivos y Esc la cierra", async () => {
    await run(`document.getElementById("tb-title").click(); return 1`);
    await waitFor(`return !document.getElementById("quickopen").hidden`, "el selector");
    eq(await run(`return document.getElementById("qo-input").placeholder`), "Buscar archivo por nombre…");
    await run(`document.getElementById("qo-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return 1`);
  });

  await test("las flechas recorren el historial de archivos (botones y Alt+←/→)", async () => {
    await bootApp(session([["sub/b.ts"]]));
    eq(await run(`return [document.getElementById("nav-back").disabled, document.getElementById("nav-fwd").disabled]`), [true, true], "sin historial al empezar");
    await run(`[...document.querySelectorAll("#tree .node")].find(n=>n.querySelector(".name").textContent==="renombrado.txt").click(); return 1`);
    await waitFor(`return document.querySelector(".group.focused .tab.active .tlabel")?.textContent === "renombrado.txt"`, "que abra renombrado.txt");
    eq(await run(`return [document.getElementById("nav-back").disabled, document.getElementById("nav-fwd").disabled]`), [false, true]);
    await run(`document.getElementById("nav-back").click(); return 1`);
    await waitFor(`return document.querySelector(".group.focused .tab.active .tlabel")?.textContent === "b.ts"`, "volver a b.ts");
    eq(await run(`return [document.getElementById("nav-back").disabled, document.getElementById("nav-fwd").disabled]`), [true, false]);
    await run(`document.getElementById("nav-fwd").click(); return 1`);
    await waitFor(`return document.querySelector(".group.focused .tab.active .tlabel")?.textContent === "renombrado.txt"`, "avanzar a renombrado.txt");
    await wait(300);
    await key("ArrowLeft", { alt: true });
    await waitFor(`return document.querySelector(".group.focused .tab.active .tlabel")?.textContent === "b.ts"`, "Alt+← vuelve a b.ts");
    await key("ArrowRight", { alt: true });
    await waitFor(`return document.querySelector(".group.focused .tab.active .tlabel")?.textContent === "renombrado.txt"`, "Alt+→ avanza");
    eq(await activeTab(), "renombrado.txt");
  });

  await test("un punto junto al nombre avisa de lo no guardado y al guardar la barra late", async () => {
    eq(await run(`return document.getElementById("tb-dirty").hidden`), true, "limpio al empezar");
    await typeInEditor("x");
    await waitFor(`return !document.getElementById("tb-dirty").hidden`, "el punto de sin guardar");
    ok((await run(`return document.getElementById("tb-dirty").title`)).includes("1 archivo"), "el punto dice cuántos hay");
    await key("s", { ctrl: true });
    await waitFor(`return document.getElementById("titlebar").classList.contains("beat")`, "el latido al guardar", 4000);
    await waitFor(`return document.getElementById("tb-dirty").hidden`, "que desaparezca el punto");
  });

  await test("Ctrl+B oculta la barra lateral y maximizar/restaurar responden", async () => {
    const hidden = await run(`return document.getElementById("app").classList.contains("no-sidebar")`);
    await key("b", { ctrl: true });
    eq(await run(`return document.getElementById("app").classList.contains("no-sidebar")`), !hidden);
    await key("b", { ctrl: true });
    const before = await run(`return document.getElementById("win-max").classList.contains("restored")`);
    await run(`document.getElementById("win-max").click(); return 1`);
    await waitFor(`return document.getElementById("win-max").classList.contains("restored") === ${!before}`, "que cambie el estado de la ventana");
    await run(`document.getElementById("win-max").click(); return 1`);
    await waitFor(`return document.getElementById("win-max").classList.contains("restored") === ${before}`, "que vuelva a su tamaño");
  });

  console.log("\nTerminal integrada");
  const termText = () => run(`return [...document.querySelectorAll("#term-body .term-pane:not([hidden]) .xterm-rows")].map(r=>r.textContent.replace(/\\u00a0/g," ")).join("")`);
  const countIn = (text, needle) => text.split(needle).length - 1;
  const typeLine = async (text) => {
    await run(`document.querySelector("#term-body .term-pane:not([hidden]) .xterm-helper-textarea").focus(); return 1`);
    await send("Input.insertText", { text });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };

  await test("Ctrl+J abre el panel con una terminal real que arranca en la carpeta del proyecto", async () => {
    await bootApp(session([["sub/b.ts"]]));
    eq(await run(`return document.getElementById("panel").hidden`), true, "el panel empieza oculto");
    await key("j", { ctrl: true });
    await waitFor(`return !document.getElementById("panel").hidden && document.querySelectorAll(".term-tab").length === 1`, "el panel y su pestaña", 15000);
    await waitFor(`return document.querySelector("#term-body .xterm-rows")?.textContent.trim().length > 0`, "el primer prompt de la shell", 25000);
    const text = await termText();
    ok(text.includes(path.basename(ROOT)), `el prompt debe mostrar la carpeta del proyecto; muestra: ${JSON.stringify(text.slice(0, 160))}`);
  });

  await test("lo que se escribe llega a la shell y su salida se ve", async () => {
    await typeLine("echo pulso-e2e-ok");
    await waitFor(`return (document.querySelector("#term-body .term-pane:not([hidden]) .xterm-rows").textContent.replace(/\\u00a0/g," ").split("pulso-e2e-ok").length - 1) >= 2`, "el comando y su salida", 15000);
  });

  await test("con el foco en la terminal Ctrl+P es del shell y Ctrl+Shift+P sigue abriendo la paleta", async () => {
    await run(`document.querySelector("#term-body .term-pane:not([hidden]) .xterm-helper-textarea").focus(); return 1`);
    await key("p", { ctrl: true, target: "#term-body .xterm-helper-textarea" });
    await wait(300);
    eq(await run(`return document.getElementById("quickopen").hidden`), true, "Ctrl+P no debe abrir el selector de archivos");
    await key("P", { ctrl: true, shift: true, target: "#term-body .xterm-helper-textarea" });
    await waitFor(`return !document.getElementById("quickopen").hidden`, "la paleta de comandos");
    await run(`document.getElementById("qo-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return 1`);
    // Ctrl+P llegó a PowerShell (historial anterior): Esc limpia la línea para no ensuciar las pruebas siguientes.
    await run(`document.querySelector("#term-body .term-pane:not([hidden]) .xterm-helper-textarea").focus(); return 1`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  });

  await test("se pueden abrir varias terminales y elegir el tipo desde el menú", async () => {
    await run(`document.getElementById("term-shells").click(); return 1`);
    await waitFor(`return document.querySelectorAll(".ctx-item").length > 0`, "la lista de shells");
    const shells = await run(`return [...document.querySelectorAll(".ctx-item")].map(i=>i.firstChild.textContent.trim())`);
    ok(shells.length >= 1, "debe listar al menos una shell: " + JSON.stringify(shells));
    await run(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return 1`);
    await run(`document.getElementById("term-new").click(); return 1`);
    await waitFor(`return document.querySelectorAll(".term-tab").length === 2`, "la segunda pestaña", 15000);
    await waitFor(`return document.querySelector("#term-body .term-pane:not([hidden]) .xterm-rows")?.textContent.trim().length > 0`, "el prompt de la segunda terminal", 25000);
    eq(await run(`return document.querySelectorAll(".term-pane:not([hidden])").length`), 1, "solo una terminal visible a la vez");
  });

  await test("Ctrl+J oculta y vuelve a mostrar el panel sin perder las terminales", async () => {
    await key("j", { ctrl: true });
    await waitFor(`return document.getElementById("panel").hidden`, "que se oculte");
    eq(await run(`return document.querySelectorAll(".term-tab").length`), 2, "siguen vivas");
    await key("j", { ctrl: true });
    await waitFor(`return !document.getElementById("panel").hidden`, "que se muestre");
    await wait(500);
    const text = await termText();
    ok(text.trim().length > 0, "la terminal debe seguir mostrando su contenido");
  });

  await test("al escribir exit la terminal se cierra, y con la última se oculta el panel", async () => {
    await typeLine("exit");
    await waitFor(`return document.querySelectorAll(".term-tab").length === 1`, "que se cierre la pestaña", 15000);
    await typeLine("exit");
    await waitFor(`return document.querySelectorAll(".term-tab").length === 0 && document.getElementById("panel").hidden`, "que se oculte el panel", 15000);
  });

  await test("el panel de la terminal cambia de altura al arrastrar su borde", async () => {
    await key("j", { ctrl: true });
    await waitFor(`return !document.getElementById("panel").hidden && document.querySelectorAll(".term-tab").length === 1`, "una terminal nueva", 15000);
    await waitFor(`return document.querySelector("#term-body .term-pane:not([hidden]) .xterm-rows")?.textContent.trim().length > 0`, "su prompt", 25000);
    const before = await run(`return document.getElementById("panel").getBoundingClientRect().height`);
    await run(`document.getElementById("term-max").click(); return 1`);
    await wait(300);
    const after = await run(`return document.getElementById("panel").getBoundingClientRect().height`);
    ok(after > before + 100, `agrandar debe subir la altura (${before} → ${after})`);
    await run(`document.getElementById("term-max").click(); return 1`);
    await run(`document.getElementById("term-hide").click(); return 1`);
    await waitFor(`return document.getElementById("panel").hidden`, "ocultar con el botón");
    await run(`return document.querySelectorAll(".term-tab").length`);
    // Deja todo cerrado para no dejar procesos vivos.
    await key("j", { ctrl: true });
    await waitFor(`return !document.getElementById("panel").hidden`, "mostrar de nuevo");
    await run(`document.querySelector(".term-close").click(); return 1`);
    await waitFor(`return document.querySelectorAll(".term-tab").length === 0`, "cerrar la pestaña con ×", 15000);
  });

  console.log("\nGit: preparar, diferencias y commit");
  const GROOT = `${ROOT}-git`;
  const git = (...args) => execFileSync("git", ["-C", GROOT, ...args], { encoding: "utf8" });
  const gitSession = () => ({ root: GROOT, layout: { dir: "row", focus: 0, groups: [{ paths: [], active: null, pinned: [] }] } });
  const scmRows = () => run(`return [...document.querySelectorAll("#scm-list .scm-section")].map(s => ({ title: s.querySelector(".scm-title").textContent, files: [...s.querySelectorAll(".scm-row .scm-name")].map(n => n.textContent) }))`);
  const clickRowAct = (name) => run(`const r=[...document.querySelectorAll("#scm-list .scm-row")].find(r=>r.querySelector(".scm-name").textContent===${JSON.stringify(name)}); r.querySelector(".scm-act:not(.scm-drop)").click(); return 1`);

  await test("el panel lista cambios sin preparar y sin seguimiento, y la insignia los cuenta", async () => {
    fs.mkdirSync(GROOT, { recursive: true });
    git("init", "-q");
    git("config", "user.email", "e2e@example.com");
    git("config", "user.name", "E2E");
    git("config", "commit.gpgsign", "false");
    fs.writeFileSync(`${GROOT}/a.txt`, "linea 1\nlinea 2\n");
    fs.writeFileSync(`${GROOT}/b.txt`, "bbb\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    fs.writeFileSync(`${GROOT}/a.txt`, "linea 1\nlinea DOS\n");
    fs.writeFileSync(`${GROOT}/nuevo.txt`, "hola\n");
    await bootApp(gitSession());
    await key("g", { ctrl: true, shift: true });
    await waitFor(`return !document.getElementById("view-git").hidden && document.querySelectorAll("#scm-list .scm-row").length === 2`, "los dos cambios");
    const rows = await scmRows();
    eq(rows.map((r) => r.title), ["Cambios"]);
    eq(rows[0].files.sort(), ["a.txt", "nuevo.txt"]);
    eq(await run(`return document.getElementById("scm-badge").textContent`), "2");
    eq(await run(`return document.getElementById("scm-commit").disabled`), true, "sin nada preparado no se puede confirmar");
  });

  await test("preparar mueve el archivo a 'Cambios preparados' y quitarlo lo devuelve", async () => {
    await clickRowAct("nuevo.txt");
    await waitFor(`return [...document.querySelectorAll("#scm-list .scm-title")].some(t => t.textContent === "Cambios preparados")`, "la sección de preparados");
    eq((await scmRows()).find((r) => r.title === "Cambios preparados").files, ["nuevo.txt"]);
    ok(git("diff", "--cached", "--name-only").includes("nuevo.txt"), "git debe verlo preparado");
    await clickRowAct("nuevo.txt");
    await waitFor(`return ![...document.querySelectorAll("#scm-list .scm-title")].some(t => t.textContent === "Cambios preparados")`, "que vuelva a sin preparar");
    eq(git("diff", "--cached", "--name-only").trim(), "", "nada preparado en git");
  });

  await test("un clic en un archivo abre la vista de diferencias con las dos versiones y Esc la cierra", async () => {
    await run(`[...document.querySelectorAll("#scm-list .scm-row")].find(r=>r.querySelector(".scm-name").textContent==="a.txt").click(); return 1`);
    await waitFor(`return !document.getElementById("diff-view").hidden && !!document.querySelector("#diff-view .monaco-diff-editor")`, "el editor de diferencias", 15000);
    await waitFor(`const t = document.getElementById("diff-view").textContent.replace(/ /g, " "); return t.includes("linea 2") && t.includes("linea DOS")`, "ambas versiones en pantalla");
    await key("Escape");
    await waitFor(`return document.getElementById("diff-view").hidden && !document.querySelector("#diff-view .monaco-diff-editor")`, "cerrar con Esc");
  });

  await test("confirmar exige mensaje y crea el commit con lo preparado", async () => {
    await run(`document.getElementById("scm-list").querySelector(".scm-bulk").click(); return 1`);
    await waitFor(`return [...document.querySelectorAll("#scm-list .scm-title")].some(t => t.textContent === "Cambios preparados")`, "preparar todo");
    eq(await run(`return document.getElementById("scm-commit").disabled`), true, "sin mensaje sigue desactivado");
    await run(`const m=document.getElementById("scm-msg"); m.value="añade cambios de e2e"; m.dispatchEvent(new Event("input")); return 1`);
    await waitFor(`return !document.getElementById("scm-commit").disabled`, "botón activo con mensaje");
    await run(`document.getElementById("scm-commit").click(); return 1`);
    await waitFor(`return document.querySelectorAll("#scm-list .scm-row").length === 0`, "lista vacía tras confirmar");
    eq(git("log", "-1", "--format=%s").trim(), "añade cambios de e2e");
    eq(git("status", "--porcelain").trim(), "", "el árbol queda limpio");
    eq(await run(`return document.getElementById("scm-msg").value`), "", "el mensaje se limpia");
    eq(await run(`return document.getElementById("scm-badge").hidden`), true);
  });


  console.log("\nGit: ramas, descartar y sincronizar (remoto local, sin red)");
  const refreshPanel = () => run(`window.dispatchEvent(new Event("focus")); return 1`);
  const BARE = `${ROOT}-bare`;
  const branchNow = () => git("rev-parse", "--abbrev-ref", "HEAD").trim();
  const pickLabels = () => run(`return [...document.querySelectorAll("#qo-list li .qo-label")].map(l => l.textContent)`);
  const clickPick = (label) => run(`const li=[...document.querySelectorAll("#qo-list li")].find(l=>l.querySelector(".qo-label")?.textContent===${JSON.stringify(label)}); if(!li) throw new Error("sin opción ${label}"); li.click(); return 1`);

  await test("el botón de rama lista las ramas y permite crear una nueva y volver", async () => {
    await bootApp(gitSession());
    await key("g", { ctrl: true, shift: true });
    await waitFor(`return !document.getElementById("scm-bar").hidden`, "la barra de ramas");
    const original = branchNow();
    eq(await run(`return document.getElementById("scm-branch-btn").textContent`), `⎇ ${original}`);
    await run(`document.getElementById("scm-branch-btn").click(); return 1`);
    await waitFor(`return !document.getElementById("quickopen").hidden && document.querySelectorAll("#qo-list li").length > 1`, "el selector de ramas");
    const labels = await pickLabels();
    ok(labels.some((l) => l.includes("Crear rama nueva")) && labels.includes(original), `opciones: ${labels}`);
    await clickPick("＋ Crear rama nueva…");
    await waitFor(`return !!document.querySelector(".modal-input")`, "el nombre de la rama");
    await answerPrompt("feature/e2e");
    await waitFor(`return document.getElementById("scm-branch-btn").textContent === "⎇ feature/e2e"`, "la rama nueva activa");
    eq(branchNow(), "feature/e2e");
    await run(`document.getElementById("scm-branch-btn").click(); return 1`);
    await waitFor(`return document.querySelectorAll("#qo-list li").length > 2`, "el selector otra vez");
    await clickPick(original);
    await waitFor(`return document.getElementById("scm-branch-btn").textContent === ${JSON.stringify(`⎇ ${original}`)}`, "volver a la rama original");
    eq(branchNow(), original);
  });

  await test("descartar pide confirmación, restaura el archivo y no toca lo demás", async () => {
    fs.writeFileSync(`${GROOT}/a.txt`, "TRABAJO QUE SE VA A DESCARTAR\n");
    await refreshPanel();
    await waitFor(`return !![...document.querySelectorAll("#scm-list .scm-row")].find(r=>r.querySelector(".scm-name").textContent==="a.txt")`, "a.txt en Cambios");
    await run(`[...document.querySelectorAll("#scm-list .scm-row")].find(r=>r.querySelector(".scm-name").textContent==="a.txt").querySelector(".scm-drop").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal")`, "la confirmación");
    const d = await dialog();
    ok(d.title.includes("a.txt"), d.title);
    eq(d.buttons, ["Cancelar", "Descartar"]);
    await clickBtn("Cancelar");
    await wait(300);
    eq(fs.readFileSync(`${GROOT}/a.txt`, "utf8"), "TRABAJO QUE SE VA A DESCARTAR\n", "Cancelar no toca nada");
    await run(`[...document.querySelectorAll("#scm-list .scm-row")].find(r=>r.querySelector(".scm-name").textContent==="a.txt").querySelector(".scm-drop").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal")`, "la confirmación otra vez");
    await clickBtn("Descartar");
    await waitFor(`return document.querySelectorAll("#scm-list .scm-row").length === 0`, "lista vacía tras descartar");
    eq(git("status", "--porcelain").trim(), "");
    ok(!fs.readFileSync(`${GROOT}/a.txt`, "utf8").includes("DESCARTAR"), "el archivo volvió a su versión");
  });

  await test("push crea la rama en el remoto local y pull trae lo que otro clon subió", async () => {
    execFileSync("git", ["init", "-q", "--bare", BARE]);
    git("remote", "add", "origin", BARE);
    await refreshPanel();
    await run(`document.getElementById("scm-push").click(); return 1`);
    await waitFor(`return /origin|branch|rama|up-to-date|new branch|set up/i.test(document.getElementById("status-left").textContent)`, "el resultado del push", 20000);
    const original = branchNow();
    eq(execFileSync("git", ["--git-dir", BARE, "log", "-1", "--format=%s", original], { encoding: "utf8" }).trim(), "añade cambios de e2e");
    eq(git("rev-parse", "--abbrev-ref", "@{u}").trim(), `origin/${original}`, "quedó con rama remota asociada");
    // Un commit local pendiente de subir se refleja en el botón.
    fs.writeFileSync(`${GROOT}/local.txt`, "x\n");
    git("add", "-A"); git("commit", "-q", "-m", "local pendiente");
    await refreshPanel();
    await waitFor(`return document.getElementById("scm-push-n").textContent === "1"`, "el contador de push");
    await run(`document.getElementById("scm-push").click(); return 1`);
    await waitFor(`return document.getElementById("scm-push-n").textContent === ""`, "contador de push a cero", 20000);
    // Otro clon sube un cambio; pull lo trae sin mezclar.
    const CLONE = `${ROOT}-clone`;
    execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", BARE, CLONE]);
    const cg = (...a) => execFileSync("git", ["-C", CLONE, ...a], { encoding: "utf8" });
    cg("config", "user.email", "o@e.c"); cg("config", "user.name", "Otro"); cg("config", "commit.gpgsign", "false");
    fs.writeFileSync(`${CLONE}/del-otro.txt`, "hola\n");
    cg("add", "-A"); cg("commit", "-q", "-m", "del otro clon"); cg("push", "-q");
    fs.rmSync(CLONE, { recursive: true, force: true });
    git("fetch", "-q");
    await refreshPanel();
    await waitFor(`return document.getElementById("scm-pull-n").textContent === "1"`, "el contador de pull");
    await run(`document.getElementById("scm-pull").click(); return 1`);
    await waitFor(`return document.getElementById("scm-pull-n").textContent === ""`, "contador de pull a cero", 20000);
    ok(fs.existsSync(`${GROOT}/del-otro.txt`), "el archivo del otro clon llegó");
  });

  await test("un fallo de git se muestra con su mensaje en vez de pasar en silencio", async () => {
    git("remote", "set-url", "origin", `${ROOT}-no-existe`);
    await run(`document.getElementById("scm-push").click(); return 1`);
    await waitFor(`return !!document.querySelector(".modal")`, "el diálogo de error", 20000);
    const d = await dialog();
    eq(d.title, "No se pudo subir los commits");
    const msg = await run(`return document.querySelector(".modal-msg")?.textContent`);
    ok(msg && msg.trim().length > 5, `mensaje de git: ${msg}`);
    await clickBtn("Entendido");
  });


  console.log("\nGit: historial y culpa");
  const palette = async (text) => {
    await key("P", { ctrl: true, shift: true });
    await waitFor(`return !document.getElementById("quickopen").hidden`, "la paleta de comandos");
    await run(`const i = document.getElementById("qo-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1`);
    await wait(250);
    await run(`document.getElementById("qo-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return 1`);
  };
  await test("la pestaña Historial lista los commits y uno se abre para ver sus archivos y sus diferencias", async () => {
    git("remote", "set-url", "origin", BARE);
    await run(`localStorage.setItem("pulso.blame", "0"); return 1`);
    await bootApp(gitSession());
    await key("g", { ctrl: true, shift: true });
    await run(`document.querySelector('#scm-tabs [data-tab="history"]').click(); return 1`);
    await waitFor(`return document.querySelectorAll("#scm-history .hist-row").length >= 2`, "los commits", 15000);
    const last = git("log", "-1", "--format=%s").trim();
    eq(await run(`return document.querySelector("#scm-history .hist-subject").textContent`), last, "el más reciente va primero");
    ok((await run(`return document.querySelector("#scm-history .hist-meta").textContent`)).includes(git("log", "-1", "--format=%an").trim()), "muestra el autor");
    eq(await run(`return getComputedStyle(document.getElementById("scm-list")).display`), "none", "la lista de cambios se oculta");
    await run(`document.querySelector("#scm-history .hist-head").click(); return 1`);
    await waitFor(`return document.querySelectorAll("#scm-history .hist-file").length > 0`, "los archivos del commit");
    await run(`document.querySelector("#scm-history .hist-file").click(); return 1`);
    await waitFor(`return !document.getElementById("diff-view").hidden && !!document.querySelector("#diff-view .monaco-diff-editor, #diff-view .diff-msg")`, "la comparación del commit", 15000);
    await key("Escape");
    await waitFor(`return document.getElementById("diff-view").hidden`, "cerrar con Esc");
    await run(`document.querySelector('#scm-tabs [data-tab="changes"]').click(); return 1`);
    eq(await run(`return getComputedStyle(document.getElementById("scm-list")).display !== "none"`), true, "vuelve la lista de cambios");
  });

  await test("«Historial del archivo activo» filtra por ese archivo y sigue sus renombrados", async () => {
    await run(`document.querySelector('.act[data-view="explorer"]').click(); return 1`);
    await waitFor(`return [...document.querySelectorAll("#tree .node .name")].some(n => n.textContent === "a.txt")`, "a.txt en el explorador");
    await run(`[...document.querySelectorAll("#tree .node")].find(n => n.querySelector(".name")?.textContent === "a.txt").click(); return 1`);
    await waitFor(`return !!document.querySelector(".tab.active")`, "a.txt abierto");
    await palette("historial del archivo");
    await waitFor(`return !!document.querySelector("#scm-history .hist-filter")`, "el filtro del archivo", 15000);
    ok((await run(`return document.querySelector("#scm-history .hist-filter").textContent`)).includes("a.txt"));
    const expected = git("log", "--oneline", "--follow", "--", "a.txt").trim().split("\n").length;
    await waitFor(`return document.querySelectorAll("#scm-history .hist-row").length === ${expected}`, `${expected} commits de a.txt`, 15000);
    await run(`document.querySelector("#scm-history .hist-filter .icon-btn").click(); return 1`);
    await waitFor(`return !document.querySelector("#scm-history .hist-filter")`, "quitar el filtro");
  });

  await test("la culpa en línea muestra quién cambió la línea del cursor y se puede apagar", async () => {
    await palette("alternar culpa");
    await waitFor(`return document.getElementById("status-left").textContent.includes("Culpa en línea: activada")`, "activar la culpa");
    await run(`document.querySelector('.act[data-view="explorer"]').click(); return 1`);
    await run(`const ed = document.querySelector(".group.focused textarea.inputarea"); ed?.focus(); return 1`);
    await run(`document.querySelector(".group.focused .view-line")?.click(); return 1`);
    await waitFor(`return !!document.querySelector(".group.focused .blame-inline")`, "la anotación de culpa", 15000);
    ok((await run(`return document.querySelector(".group.focused .blame-inline").textContent`)).trim().length > 3, "con texto");
    await palette("alternar culpa");
    await waitFor(`return !document.querySelector(".blame-inline")`, "apagar la culpa");
    await run(`localStorage.removeItem("pulso.blame"); return 1`);
  });

  console.log("\nTablero kanban de issues (servidor de GitHub falso, sin red)");
  const mockIssues = [
    { number: 1, title: "Primera tarea", state: "open", labels: [], user: { login: "ana" }, comments: 2, html_url: "https://example.test/1", assignees: [] },
    { number: 2, title: "En marcha", state: "open", labels: [{ name: "in progress", color: "fbca04" }, { name: "bug", color: "d73a4a" }], user: { login: "bo" }, comments: 0, html_url: "https://example.test/2", assignees: [{ login: "carla" }] },
    { number: 3, title: "Ya hecha", state: "closed", labels: [], user: { login: "ana" }, comments: 1, html_url: "https://example.test/3", assignees: [] },
    { number: 4, title: "Una PR que no debe salir", state: "open", labels: [], user: { login: "bo" }, comments: 0, html_url: "https://example.test/4", pull_request: {} },
  ];
  for (const i of mockIssues) i.node_id = `I_${i.number}`;
  const writes = [];
  let failNext = null;
  // Pull requests: dos abiertas (una borrador) y una fusionada.
  const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
  const mockPulls = [
    { number: 31, title: "Añade el panel de IA", state: "open", draft: false, merged_at: null, html_url: "https://example.test/pr/31", user: { login: "ana" }, head: { ref: "feature/ia", sha: "HEAD31" }, base: { ref: "trunk", sha: "BASE31" }, created_at: iso(300), updated_at: iso(20), body: "Primera línea de la descripción.", additions: 12, deletions: 3 },
    { number: 30, title: "Corrige el tablero", state: "open", draft: true, merged_at: null, html_url: "https://example.test/pr/30", user: { login: "bruno" }, head: { ref: "fix/tablero", sha: "HEAD30" }, base: { ref: "trunk", sha: "BASE30" }, created_at: iso(900), updated_at: iso(600), body: "", additions: 1, deletions: 1 },
    { number: 29, title: "Historial de Git", state: "closed", draft: false, merged_at: iso(4000), html_url: "https://example.test/pr/29", user: { login: "ana" }, head: { ref: "feature/historial", sha: "HEAD29" }, base: { ref: "trunk", sha: "BASE29" }, created_at: iso(9000), updated_at: iso(4000), body: "Hecho.", additions: 5, deletions: 0 },
  ];
  const prFiles = [
    { filename: "src/ia/proveedores.ts", status: "added", additions: 8, deletions: 0 },
    { filename: "src/ia/chat.ts", status: "modified", additions: 3, deletions: 2 },
    { filename: "docs/IA.md", status: "renamed", previous_filename: "docs/AI.md", additions: 1, deletions: 1 },
  ];
  const prTexts = { "MB31:src/ia/chat.ts": "uno\ndos\n", "HEAD31:src/ia/chat.ts": "uno\ndos\ntres\n", "HEAD31:src/ia/proveedores.ts": "export const p = [];\n", "MB31:docs/AI.md": "a\n", "HEAD31:docs/IA.md": "b\n" };
  // Chat: comentarios de la issue-sala, personas del repositorio y si la etiqueta ya existe.
  const chatComments = [];
  const people = [{ login: "yo", avatar_url: "" }, { login: "ana", avatar_url: "" }, { login: "bruno", avatar_url: "" }];
  let chatLabel = false;
  const say = (login, body, minutesAgo = 0) => chatComments.push({ id: 100 + chatComments.length, body, user: { login, avatar_url: "" }, created_at: new Date(Date.now() - minutesAgo * 60000).toISOString() });
  const server = http.createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, x-github-api-version, accept, if-none-match", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Expose-Headers": "etag, link" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (code, data) => { res.writeHead(code, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(data ?? {})); };
      if (req.headers.authorization !== "Bearer e2e-token") { send(401, { message: "Bad credentials" }); return; }
      let m;
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/labels\/(.+)$/))) {
        const name = decodeURIComponent(m[1]);
        if (["in progress", "pulso: in review"].includes(name)) send(200, { name }); else send(404, {});
        return;
      }
      if (req.method === "POST" && url.pathname === "/graphql") {
        writes.push(`POST /graphql ${body}`);
        const id = JSON.parse(body).variables?.id;
        const at = mockIssues.findIndex((x) => x.node_id === id);
        if (at < 0) { send(200, { errors: [{ message: "Could not resolve to a node" }] }); return; }
        mockIssues.splice(at, 1); send(200, { data: { deleteIssue: { clientMutationId: null } } }); return;
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/issues\/(\d+)$/))) {
        const found = mockIssues.find((x) => x.number === Number(m[1]));
        if (!found) { send(404, {}); return; }
        send(200, found); return;
      }
      if (req.method === "GET" && url.pathname === "/repos/e2e/demo") { send(200, { default_branch: "trunk" }); return; }
      if (req.method === "GET" && url.pathname === "/repos/e2e/demo/pulls") {
        const st = url.searchParams.get("state");
        send(200, mockPulls.filter((x) => st === "all" || (st === "open" ? x.state === "open" : x.state === "closed"))); return;
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/pulls\/(\d+)\/files$/))) { send(200, prFiles); return; }
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/pulls\/(\d+)$/))) {
        const found = mockPulls.find((x) => x.number === Number(m[1]));
        if (!found) { send(404, {}); return; }
        send(200, found); return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/repos/e2e/demo/compare/")) { send(200, { merge_base_commit: { sha: "MB31" } }); return; }
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/contents\/(.+)$/))) {
        const text = prTexts[`${url.searchParams.get("ref")}:${decodeURIComponent(m[1])}`];
        res.writeHead(text === undefined ? 404 : 200, { ...cors, "Content-Type": "text/plain" }); res.end(text ?? ""); return;
      }
      if (req.method === "GET" && url.pathname === "/user") { send(200, { login: "yo", avatar_url: "" }); return; }
      if (req.method === "GET" && url.pathname === "/repos/e2e/demo/collaborators") { send(200, people); return; }
      if (req.method === "GET" && url.pathname === "/repos/e2e/demo/labels/pulso-chat") { send(chatLabel ? 200 : 404, { name: "pulso-chat" }); return; }
      if (req.method === "GET" && url.pathname === "/repos/e2e/demo/issues" && url.searchParams.get("labels") === "pulso-chat") {
        send(200, mockIssues.filter((i) => i.state === "open" && i.labels.some((l) => l.name === "pulso-chat"))); return;
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/issues\/(\d+)\/comments$/))) {
        const since = url.searchParams.get("since");
        const list = chatComments.filter((c) => !since || Date.parse(c.created_at) >= Date.parse(since));
        const etag = `"c${chatComments.length}-${since ?? ""}"`;
        if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ...cors, ETag: etag }); res.end(); return; }
        res.writeHead(200, { ...cors, ETag: etag, "Content-Type": "application/json" }); res.end(JSON.stringify(list)); return;
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/issues$/))) {
        const state = url.searchParams.get("state");
        send(200, mockIssues.filter((i) => i.state === state));
        return;
      }
      if (req.method !== "GET") {
        writes.push(`${req.method} ${url.pathname}${body ? " " + body : ""}`);
        if (failNext) { const code = failNext; failNext = null; send(code, { message: "falló a propósito" }); return; }
      }
      if (req.method === "POST" && url.pathname === "/repos/e2e/demo/pulls") {
        const d = JSON.parse(body);
        if (mockPulls.some((x) => x.state === "open" && x.head.ref === d.head)) { send(422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for e2e:${d.head}.` }] }); return; }
        const made = { number: 40 + mockPulls.length, title: d.title, state: "open", draft: false, merged_at: null, html_url: "https://example.test/pr/new", user: { login: "yo" }, head: { ref: d.head, sha: "HEADNEW" }, base: { ref: d.base, sha: "BASENEW" }, created_at: iso(0), updated_at: iso(0), body: d.body, additions: 0, deletions: 0 };
        mockPulls.unshift(made); send(201, made); return;
      }
      if (req.method === "POST" && url.pathname === "/repos/e2e/demo/labels") { chatLabel = true; send(201, JSON.parse(body)); return; }
      if (req.method === "POST" && (m = url.pathname.match(/^\/repos\/e2e\/demo\/issues\/(\d+)\/comments$/))) {
        const made = { id: 100 + chatComments.length, body: JSON.parse(body).body, user: { login: "yo", avatar_url: "" }, created_at: new Date().toISOString() };
        chatComments.push(made); send(201, made); return;
      }
      if (req.method === "POST" && url.pathname === "/repos/e2e/demo/issues") {
        const d = JSON.parse(body);
        const n = 10 + mockIssues.length;
        const created = { node_id: `I_${n}`, number: n, title: d.title, body: d.body, state: "open", labels: (d.labels || []).map((name) => ({ name, color: "ededed" })), user: { login: "yo" }, comments: 0, html_url: "https://example.test/" + n, assignees: [] };
        mockIssues.push(created);
        send(201, created); return;
      }
      if ((m = url.pathname.match(/^\/repos\/e2e\/demo\/issues\/(\d+)\/labels$/)) && req.method === "POST") {
        const i = mockIssues.find((x) => x.number === Number(m[1]));
        for (const name of JSON.parse(body).labels) if (!i.labels.some((l) => l.name === name)) i.labels.push({ name, color: "ededed" });
        send(200, i.labels); return;
      }
      if ((m = url.pathname.match(/^\/repos\/e2e\/demo\/issues\/(\d+)\/labels\/(.+)$/)) && req.method === "DELETE") {
        const i = mockIssues.find((x) => x.number === Number(m[1]));
        const name = decodeURIComponent(m[2]);
        if (!i.labels.some((l) => l.name === name)) { send(404, {}); return; }
        i.labels = i.labels.filter((l) => l.name !== name);
        send(200, i.labels); return;
      }
      if ((m = url.pathname.match(/^\/repos\/e2e\/demo\/issues\/(\d+)$/)) && req.method === "PATCH") {
        const i = mockIssues.find((x) => x.number === Number(m[1]));
        const patch = JSON.parse(body);
        if (patch.state) i.state = patch.state;
        if (patch.title !== undefined) i.title = patch.title;
        if (patch.body !== undefined) i.body = patch.body;
        if (patch.labels) i.labels = patch.labels.map((name) => ({ name, color: "ededed" }));
        send(200, i); return;
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const API = `http://127.0.0.1:${server.address().port}`;
  const colOf = (n) => run(`return document.querySelector('.board-card[data-number="${n}"]')?.closest(".board-col")?.dataset.col ?? null`);
  // Arrastre real con el ratón (el tablero usa eventos de puntero, no arrastrar y soltar de HTML5).
  const dropOn = async (n, col) => {
    const p = await run(`const c = document.querySelector('.board-card[data-number="${n}"]'); const r = c.getBoundingClientRect(); const d = document.querySelector('.board-col[data-col="${col}"]').getBoundingClientRect(); return { f: [r.x + r.width / 2, r.y + 15], t: [d.x + d.width / 2, d.y + Math.min(d.height - 10, 140)] }`);
    const [fx, fy] = p.f, [tx, ty] = p.t;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 8; k++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx + ((tx - fx) * k) / 8, y: fy + ((ty - fy) * k) / 8, buttons: 1 }); await wait(15); }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 0, clickCount: 1 });
    return 1;
  };
  const openBoard = async () => {
    await run(`document.getElementById("open-board").click(); return 1`);
    await waitFor(`return !document.getElementById("board-view").hidden && document.querySelectorAll("#board-view .board-card").length > 0`, "las tarjetas del tablero");
  };

  try {
    await test("el tablero agrupa las issues en Por hacer / En curso / En revisión / Hecho y ignora las PR", async () => {
      git("remote", "set-url", "origin", "https://github.com/e2e/demo.git");
      await invoke("secret_set", { name: "github-token", value: "e2e-token" });
      await run(`localStorage.setItem("pulso.githubApi", ${JSON.stringify(API)}); localStorage.removeItem("pulso.boardWriteOk:e2e/demo"); return 1`);
      await bootApp(gitSession());
      await key("i", { ctrl: true, shift: true });
      await openBoard();
      eq(await colOf(1), "todo");
      eq(await colOf(2), "doing");
      eq(await colOf(3), "done");
      eq(await colOf(4), null, "las PR no son issues");
      eq(await run(`return [...document.querySelectorAll(".board-col-count")].map(c => c.textContent)`), ["1", "1", "0", "1"]);
      eq(await run(`return document.querySelector('.board-card[data-number="2"] .board-card-foot').textContent`), "carla", "muestra a quien está asignada");
      // Con `draggable` el navegador inicia su arrastre nativo y cancela el del tablero: con un ratón real la tarjeta no se movería.
      eq(await run(`const c = document.querySelector('.board-card[data-number="1"]'); const ev = new DragEvent("dragstart", { bubbles: true, cancelable: true }); c.dispatchEvent(ev); return { draggable: c.draggable, prevented: ev.defaultPrevented }`), { draggable: false, prevented: true });
    });

    await test("arrastrar a «En curso» pide confirmar la primera vez, añade la etiqueta y mueve la tarjeta", async () => {
      await dropOn(1, "doing");
      await waitFor(`return !!document.querySelector(".modal")`, "la confirmación de escritura");
      eq((await dialog()).title, "El tablero modifica GitHub");
      await clickBtn("Cancelar");
      await wait(300);
      eq(writes.length, 0, "cancelar no escribe nada");
      eq(await colOf(1), "todo");
      await dropOn(1, "doing");
      await waitFor(`return !!document.querySelector(".modal")`, "la confirmación otra vez");
      await clickBtn("Entendido, continuar");
      await waitFor(`return document.querySelector('.board-card[data-number="1"]')?.closest(".board-col")?.dataset.col === "doing"`, "la tarjeta en curso");
      for (let k = 0; k < 60 && writes.length < 1; k++) await wait(50);
      eq(writes, ['POST /repos/e2e/demo/issues/1/labels {"labels":["in progress"]}']);
      ok(mockIssues[0].labels.some((l) => l.name === "in progress"), "GitHub (falso) recibió la etiqueta");
    });

    await test("a «Hecho» quita la etiqueta y cierra; a «Por hacer» reabre sin volver a preguntar", async () => {
      writes.length = 0;
      await dropOn(2, "done");
      await waitFor(`return document.querySelector('.board-card[data-number="2"]')?.closest(".board-col")?.dataset.col === "done"`, "la tarjeta hecha");
      await wait(500);
      eq(writes, ["DELETE /repos/e2e/demo/issues/2/labels/in%20progress", 'PATCH /repos/e2e/demo/issues/2 {"state":"closed"}']);
      eq(mockIssues[1].state, "closed");
      writes.length = 0;
      await dropOn(3, "todo");
      await waitFor(`return document.querySelector('.board-card[data-number="3"]')?.closest(".board-col")?.dataset.col === "todo"`, "la tarjeta reabierta");
      await wait(500);
      eq(writes, ['PATCH /repos/e2e/demo/issues/3 {"state":"open"}']);
      eq(await run(`return !!document.querySelector(".modal")`), false, "ya no vuelve a pedir confirmación");
    });

    await test("soltar en la misma columna no escribe y un fallo de GitHub se explica y deja el estado real", async () => {
      writes.length = 0;
      await dropOn(3, "todo");
      await wait(400);
      eq(writes.length, 0);
      failNext = 403;
      await dropOn(3, "doing");
      await waitFor(`return !!document.querySelector(".modal")`, "el diálogo de error");
      const d = await dialog();
      eq(d.title, "No se pudo mover #3");
      ok((await run(`return document.querySelector(".modal-msg").textContent`)).includes("permiso de escritura"));
      await clickBtn("Entendido");
      await waitFor(`return document.querySelector('.board-card[data-number="3"]')?.closest(".board-col")?.dataset.col === "todo"`, "la tarjeta vuelve a su sitio");
      eq(mockIssues[2].labels.length, 0, "GitHub no cambió");
    });

    const fillForm = (v) => run(`
      const f = [...document.querySelectorAll(".modal-form .modal-input")];
      const set = (el, val) => { if (val === undefined) return; el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set(f[0], ${JSON.stringify(v.title)}); set(f[1], ${JSON.stringify(v.body)}); set(f[2], ${JSON.stringify(v.labels)});
      return f.map(x => x.value)`);

    await test("«Nueva issue» crea la issue en GitHub y la tarjeta aparece en la columna", async () => {
      writes.length = 0;
      await run(`document.querySelector('.board-col[data-col="todo"] .board-add').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario");
      eq((await dialog()).title, "Nueva issue en «Por hacer»");
      await clickBtn("Crear");
      await waitFor(`return document.querySelector(".modal-err")?.textContent.includes("título")`, "que exija el título");
      await fillForm({ title: "Creada desde Pulso", body: "Primera línea\nSegunda línea", labels: "bug, ui, BUG" });
      await clickBtn("Crear");
      await waitFor(`return [...document.querySelectorAll(".board-card-title")].some(t => t.textContent === "Creada desde Pulso")`, "la tarjeta nueva");
      eq(writes.length, 1);
      ok(writes[0].startsWith("POST /repos/e2e/demo/issues "), writes[0]);
      eq(JSON.parse(writes[0].slice(writes[0].indexOf("{"))), { title: "Creada desde Pulso", body: "Primera línea\nSegunda línea", labels: ["bug", "ui"] });
      eq(await run(`return [...document.querySelectorAll(".board-card")].find(c => c.querySelector(".board-card-title").textContent === "Creada desde Pulso").closest(".board-col").dataset.col`), "todo");
      ok(mockIssues.some((i) => i.title === "Creada desde Pulso"), "GitHub (falso) la guardó");
    });

    await test("crear desde «En curso» añade la etiqueta de progreso", async () => {
      writes.length = 0;
      await run(`document.querySelector('.board-col[data-col="doing"] .board-add').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario");
      await fillForm({ title: "Ya empezada", labels: "ui" });
      await clickBtn("Crear");
      await waitFor(`return [...document.querySelectorAll(".board-card-title")].some(t => t.textContent === "Ya empezada")`, "la tarjeta");
      eq(JSON.parse(writes[0].slice(writes[0].indexOf("{"))).labels, ["ui", "in progress"]);
      eq(await run(`return [...document.querySelectorAll(".board-card")].find(c => c.querySelector(".board-card-title").textContent === "Ya empezada").closest(".board-col").dataset.col`), "doing");
    });

    await test("pulsar una tarjeta abre su edición con los datos actuales y guarda solo lo que cambió", async () => {
      writes.length = 0;
      await run(`document.querySelector('.board-card[data-number="1"] .board-card-title').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario de edición");
      eq((await dialog()).title, "Editar #1");
      eq(await run(`return [...document.querySelectorAll(".modal-form .modal-input")].map(x => x.value)`), ["Primera tarea", "", "in progress"], "trae título, descripción y etiquetas");
      await clickBtn("Cancelar");
      await wait(300);
      eq(writes.length, 0);
      // Guardar sin tocar nada tampoco escribe.
      await run(`document.querySelector('.board-card[data-number="1"] .board-card-title').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario otra vez");
      await clickBtn("Guardar");
      await wait(400);
      eq(writes.length, 0, "sin cambios no se escribe nada");
      await run(`document.querySelector('.board-card[data-number="1"] .board-card-title').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario por tercera vez");
      await fillForm({ title: "Primera tarea (editada)", body: "con descripción", labels: "in progress, docs" });
      await clickBtn("Guardar");
      await waitFor(`return [...document.querySelectorAll(".board-card-title")].some(t => t.textContent === "Primera tarea (editada)")`, "el título nuevo en la tarjeta");
      eq(writes.length, 1);
      eq(JSON.parse(writes[0].slice(writes[0].indexOf("{"))), { title: "Primera tarea (editada)", body: "con descripción", labels: ["in progress", "docs"] });
      eq(mockIssues.find((i) => i.number === 1).title, "Primera tarea (editada)");
    });

    await test("al volver a la ventana el tablero trae lo creado en GitHub y no repinta si nada cambió", async () => {
      await run(`localStorage.setItem("pulso.boardMinGap", "300"); return 1`);
      mockIssues.push({ node_id: "I_99", number: 99, title: "Creada directamente en GitHub", state: "open", labels: [], user: { login: "otra" }, comments: 0, html_url: "https://example.test/99", assignees: [] });
      await wait(500);
      await run(`window.dispatchEvent(new Event("focus")); return 1`);
      await waitFor(`return [...document.querySelectorAll(".board-card-title")].some(t => t.textContent === "Creada directamente en GitHub")`, "la issue creada en GitHub", 15000);
      eq(await run(`return document.querySelector('.board-card[data-number="99"]').closest(".board-col").dataset.col`), "todo");
      // Sin cambios en GitHub, las tarjetas existentes siguen siendo las mismas (no hay parpadeo ni se pierde el foco).
      await run(`document.querySelector('.board-card[data-number="2"]').__marca = "intacta"; return 1`);
      await wait(500);
      await run(`window.dispatchEvent(new Event("focus")); return 1`);
      await wait(1200);
      eq(await run(`return document.querySelector('.board-card[data-number="2"]')?.__marca ?? null`), "intacta", "el tablero no se repintó");
      // Un cambio hecho fuera sí se refleja: alguien la cierra en GitHub.
      mockIssues.find((i) => i.number === 99).state = "closed";
      await wait(500);
      await run(`window.dispatchEvent(new Event("focus")); return 1`);
      await waitFor(`return document.querySelector('.board-card[data-number="99"]')?.closest(".board-col")?.dataset.col === "done"`, "la issue cerrada en GitHub pasa a Hecho", 15000);
      await run(`localStorage.removeItem("pulso.boardMinGap"); return 1`);
    });

    await test("cada tarjeta tiene botones para cerrar/reabrir y eliminar, y eliminar pide confirmar con la opción de cerrar en su lugar", async () => {
      await bootApp(gitSession());
      await key("i", { ctrl: true, shift: true });
      await openBoard();
      writes.length = 0;
      await run(`document.querySelector('.board-card[data-number="1"] .board-card-actions .board-open').click(); return 1`);
      await waitFor(`return document.querySelector('.board-card[data-number="1"]')?.closest(".board-col")?.dataset.col === "done"`, "la tarjeta cerrada con su botón");
      for (let k = 0; k < 60 && !writes.some((w) => w.includes('"state":"closed"')); k++) await wait(50);
      ok(writes.some((w) => w.startsWith("PATCH /repos/e2e/demo/issues/1 ") && w.includes('"state":"closed"')), `se cerró en GitHub: ${writes}`);
      writes.length = 0;
      await run(`document.querySelector('.board-card[data-number="99"] .board-del').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal")`, "la confirmación de eliminar");
      const d = await dialog();
      eq(d.title, "Eliminar #99");
      eq(d.buttons, ["Cancelar", "Cerrar en su lugar", "Eliminar para siempre"]);
      await clickBtn("Cancelar");
      await wait(300);
      eq(writes.length, 0, "cancelar no borra nada");
      await run(`document.querySelector('.board-card[data-number="99"] .board-del').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal")`, "la confirmación otra vez");
      await clickBtn("Eliminar para siempre");
      await waitFor(`return !document.querySelector('.board-card[data-number="99"]')`, "la tarjeta eliminada");
      ok(writes.some((w) => w.startsWith("POST /graphql ") && w.includes("deleteIssue") && w.includes("I_99")), `se eliminó en GitHub: ${writes}`);
      ok(!mockIssues.some((i) => i.number === 99), "GitHub (falso) la borró");
    });

    await test("sin permisos de administración, eliminar lo explica y la tarjeta se queda", async () => {
      writes.length = 0;
      mockIssues.find((i) => i.number === 3).node_id = "I_desconocida";
      await run(`document.querySelector('.board-card[data-number="3"] .board-del').click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal")`, "la confirmación");
      await clickBtn("Eliminar para siempre");
      await waitFor(`return document.querySelector(".modal-title")?.textContent.startsWith("No se pudo eliminar")`, "el error");
      await clickBtn("Entendido");
      ok(await run(`return !!document.querySelector('.board-card[data-number="3"]')`), "la tarjeta sigue");
      mockIssues.find((i) => i.number === 3).node_id = "I_3";
    });

    // ---------- Chat de grupo ----------
    const chatRows = () => run(`return [...document.querySelectorAll("#view-chat .chat-row")].map(r => ({ mine: r.classList.contains("mine"), who: r.querySelector(".chat-who")?.textContent ?? null, text: r.querySelector(".chat-bubble")?.textContent, pings: !!r.querySelector(".chat-bubble.pings-me") }))`);
    await test("el chat no existe todavía: ofrece crearlo, y al crearlo usa la etiqueta «pulso-chat»", async () => {
      await run(`localStorage.setItem("pulso.chatBackgroundMs", "500"); localStorage.removeItem("pulso.chatSeen:e2e/demo"); return 1`);
      await bootApp(gitSession());
      writes.length = 0;
      await run(`document.querySelector('.act[data-view="chat"]').click(); return 1`);
      await waitFor(`return document.querySelector("#view-chat .chat-msg")?.textContent.includes("Todavía no hay chat")`, "el aviso de que no hay chat", 15000);
      await run(`[...document.querySelectorAll("#view-chat button")].find(b => b.textContent === "Crear el chat del equipo").click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal")`, "la confirmación");
      eq((await dialog()).title, "Crear el chat del equipo");
      await clickBtn("Crear");
      await waitFor(`return !!document.querySelector("#view-chat .chat-input")`, "la conversación abierta", 15000);
      ok(writes.some((w) => w.startsWith("POST /repos/e2e/demo/labels ")), "creó la etiqueta");
      ok(writes.some((w) => w.startsWith("POST /repos/e2e/demo/issues ") && w.includes('"pulso-chat"')), `creó la issue con la etiqueta: ${writes}`);
      ok((await run(`return document.querySelector("#view-chat .chat-empty")?.textContent`)).includes("Escribe el primero"));
    });

    await test("escribir un mensaje: aparece como propio y se publica como comentario", async () => {
      writes.length = 0;
      await run(`const b = document.querySelector("#view-chat .chat-input"); b.value = "Hola equipo"; b.dispatchEvent(new Event("input", { bubbles: true })); b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return 1`);
      await waitFor(`return [...document.querySelectorAll("#view-chat .chat-row.mine")].some(r => r.textContent.includes("Hola equipo") && !r.classList.contains("pending"))`, "el mensaje enviado");
      ok(writes.some((w) => /^POST \/repos\/e2e\/demo\/issues\/\d+\/comments \{"body":"Hola equipo"\}$/.test(w)), `comentario publicado: ${writes}`);
      eq(await run(`return document.querySelector("#view-chat .chat-input").value`), "", "el cuadro queda vacío");
    });

    await test("Mayús+Enter no envía y los mensajes de otras personas llegan solos, agrupados y con su nombre", async () => {
      writes.length = 0;
      await run(`const b = document.querySelector("#view-chat .chat-input"); b.value = "no enviar"; b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); return 1`);
      await wait(300);
      eq(writes.length, 0, "Mayús+Enter no envía");
      await run(`document.querySelector("#view-chat .chat-input").value = ""; return 1`);
      say("ana", "Buenas, ¿alguien revisa el PR?");
      say("ana", "Es el de @yo, ojo");
      say("bruno", "Yo lo miro: https://github.com/e2e/demo/pull/7.");
      await waitFor(`return document.querySelectorAll("#view-chat .chat-row:not(.mine)").length >= 3`, "los mensajes de las otras personas", 15000);
      const rows = await chatRows();
      eq(rows.filter((r) => !r.mine).map((r) => r.who), ["ana", null, "bruno"], "el nombre solo en el primer mensaje de cada grupo");
      eq(rows.filter((r) => !r.mine).map((r) => r.pings), [false, true, false], "resalta el que te menciona");
      eq(await run(`return document.querySelector("#view-chat .chat-link")?.textContent`), "https://github.com/e2e/demo/pull/7", "el enlace no incluye el punto final");
      eq(await run(`return document.querySelectorAll("#view-chat .chat-day").length`), 1, "un separador de día");
    });

    await test("el chat vive en la barra lateral y un botón lo pasa a pantalla completa (Esc vuelve), recordando la elección", async () => {
      eq(await run(`return document.getElementById("view-chat").classList.contains("chat-docked")`), true, "empieza en la barra lateral");
      const docked = await run(`const r = document.getElementById("view-chat").getBoundingClientRect(); return r.width`);
      ok(docked < 500, `ancho en la barra lateral: ${docked}`);
      await run(`document.querySelector("#view-chat .chat-expand").click(); return 1`);
      await waitFor(`return document.getElementById("view-chat").classList.contains("chat-full")`, "pantalla completa");
      const wide = await run(`return document.getElementById("view-chat").getBoundingClientRect().width`);
      ok(wide > 900, `ancho en pantalla completa: ${wide}`);
      eq(await run(`return getComputedStyle(document.querySelector("#view-chat .chat-members")).display`), "block", "las personas se ven en pantalla completa");
      await run(`document.querySelector("#view-chat .chat-input").focus(); return 1`);
      await key("Escape");
      await waitFor(`return document.getElementById("view-chat").classList.contains("chat-docked")`, "Esc vuelve a la barra lateral");
      await run(`document.querySelector("#view-chat .chat-expand").click(); return 1`);
      await bootApp(gitSession());
      await run(`document.querySelector('.act[data-view="chat"]').click(); return 1`);
      await waitFor(`return !!document.querySelector("#view-chat .chat-input")`, "el chat reabierto");
      eq(await run(`return document.getElementById("view-chat").classList.contains("chat-full")`), true, "recuerda la pantalla completa");
      await run(`document.querySelector("#view-chat .chat-expand").click(); return 1`);
      await waitFor(`return document.getElementById("view-chat").classList.contains("chat-docked")`, "de vuelta a la barra lateral");
    });

    await test("el panel de personas muestra a todo el repositorio y «@» ofrece mencionarlas", async () => {
      eq(await run(`return document.querySelector("#view-chat .chat-members-title")?.textContent`), "Personas · 3");
      ok((await run(`return document.querySelector("#view-chat .chat-members").textContent`)).includes("yo (tú)"));
      await run(`const b = document.querySelector("#view-chat .chat-input"); b.focus(); b.value = "hola @a"; b.setSelectionRange(7, 7); b.dispatchEvent(new Event("input", { bubbles: true })); return 1`);
      await waitFor(`return [...document.querySelectorAll("#view-chat .chat-mention-opt")].map(o => o.lastChild.textContent).join() === "ana"`, "la sugerencia de mención");
      await run(`document.querySelector("#view-chat .chat-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return 1`);
      eq(await run(`return document.querySelector("#view-chat .chat-input").value`), "hola @ana ", "elige la mención sin enviar");
      await run(`document.querySelector("#view-chat .chat-input").value = ""; return 1`);
    });

    await test("con el chat cerrado, la insignia cuenta los mensajes nuevos de otras personas y se borra al abrirlo", async () => {
      await run(`document.querySelector('.act[data-view="explorer"]').click(); return 1`);
      await waitFor(`return document.getElementById("view-chat").hidden`, "que el chat se oculte al cambiar de vista");
      eq(await run(`return document.getElementById("chat-badge").hidden`), true, "sin pendientes");
      say("bruno", "¿Seguimos mañana?");
      await waitFor(`return !document.getElementById("chat-badge").hidden`, "la insignia", 15000);
      eq(await run(`return document.getElementById("chat-badge").textContent`), "1");
      await run(`document.querySelector('.act[data-view="chat"]').click(); return 1`);
      await waitFor(`return document.querySelectorAll("#view-chat .chat-row").length >= 5`, "el chat reabierto");
      await wait(600);
      await waitFor(`return document.getElementById("chat-badge").hidden`, "la insignia se borra al leer", 15000);
      await run(`localStorage.removeItem("pulso.chatBackgroundMs"); return 1`);
    });

    await test("la issue del chat no sale en el tablero ni en la lista lateral, y con el chat abierto solo él marca la barra", async () => {
      await run(`document.querySelector('.act[data-view="chat"]').click(); return 1`);
      await waitFor(`return !!document.querySelector("#view-chat .chat-input")`, "el chat");
      eq(await run(`return [...document.querySelectorAll(".act.active")].map(a => a.dataset.view)`), ["chat"], "solo el chat marca la barra");
      await run(`document.querySelector('.act[data-view="issues"]').click(); document.getElementById("open-board").click(); return 1`);
      await waitFor(`return document.querySelectorAll("#board-view .board-card").length > 0`, "el tablero");
      eq(await run(`return [...document.querySelectorAll("#board-view .board-card-title")].some(t => t.textContent.includes("Chat de Pulso"))`), false, "no aparece en el tablero");
      await key("Escape");
      await run(`document.getElementById("refresh-issues").click(); return 1`);
      await wait(1500);
      eq(await run(`return document.getElementById("issues").textContent.includes("Chat de Pulso")`), false, "no aparece en la lista");
    });

    await test("si la issue de la sala se cierra en GitHub, el chat lo detecta y ofrece crear otra", async () => {
      await run(`localStorage.setItem("pulso.chatRoomCheckMs", "500"); document.querySelector('.act[data-view="chat"]').click(); return 1`);
      await waitFor(`return !!document.querySelector("#view-chat .chat-input")`, "el chat abierto");
      mockIssues.find((i) => i.labels.some((l) => l.name === "pulso-chat")).state = "closed";
      await waitFor(`return document.querySelector("#view-chat .chat-msg")?.textContent.includes("Todavía no hay chat")`, "que detecte la sala cerrada", 20000);
      await run(`localStorage.removeItem("pulso.chatRoomCheckMs"); return 1`);
    });

    await test("un cambio hecho en GitHub (reabrir y pasar a «En curso») llega solo al tablero, sin recargar ni volver a la ventana", async () => {
      await run(`localStorage.setItem("pulso.boardInterval", "1000"); return 1`);
      await bootApp(gitSession());
      await key("i", { ctrl: true, shift: true });
      await openBoard();
      const n = 3;
      const issue = mockIssues.find((i) => i.number === n);
      const colIs = (c) => waitFor(`return document.querySelector('.board-card[data-number="${n}"]')?.closest(".board-col")?.dataset.col === "${c}"`, `que la tarjeta pase sola a «${c}»`, 20000);
      issue.state = "closed"; issue.labels = []; issue.updated_at = new Date().toISOString();
      await colIs("done");
      // El caso del fallo: se reabre en GitHub con la etiqueta de «En curso» y el tablero debe seguirla.
      issue.state = "open"; issue.labels = [{ name: "in progress", color: "fbca04" }]; issue.updated_at = new Date(Date.now() + 1000).toISOString();
      await colIs("doing");
      await run(`localStorage.removeItem("pulso.boardInterval"); return 1`);
    });

    // ---------- Pull requests ----------
    const prRows = () => run(`return [...document.querySelectorAll("#prs-body .pr-row")].map(r => ({ title: r.querySelector(".pr-row-text").textContent, dot: r.querySelector(".pr-dot").className.replace("pr-dot ", ""), meta: r.querySelector(".pr-row-meta").textContent }))`);
    await test("la vista Pull requests lista las abiertas con su estado y la rama de cada una", async () => {
      await bootApp(gitSession());
      await run(`document.querySelector('.act[data-view="prs"]').click(); return 1`);
      await waitFor(`return document.querySelectorAll("#prs-body .pr-row").length === 2`, "las pull requests abiertas", 15000);
      const rows = await prRows();
      eq(rows.map((r) => [r.title, r.dot]), [["Añade el panel de IA", "open"], ["Corrige el tablero", "draft"]]);
      ok(rows[0].meta.includes("#31 · ana · feature/ia → trunk"), rows[0].meta);
      await run(`document.querySelector('#prs-filter [data-v="closed"]').click(); return 1`);
      await waitFor(`return document.querySelectorAll("#prs-body .pr-row").length === 1`, "las cerradas");
      eq((await prRows())[0].dot, "merged", "una fusionada se distingue de una cerrada sin fusionar");
      await run(`document.querySelector('#prs-filter [data-v="open"]').click(); return 1`);
      await waitFor(`return document.querySelectorAll("#prs-body .pr-row").length === 2`, "vuelven las abiertas");
    });

    await test("el detalle muestra rama, archivos y totales, y cada archivo se abre en el visor de diferencias", async () => {
      await run(`document.querySelector("#prs-body .pr-row").click(); return 1`);
      await waitFor(`return !!document.querySelector("#prs-body .pr-detail .pr-files .hist-file")`, "el detalle", 15000);
      eq(await run(`return document.querySelector(".pr-title-text").textContent`), "Añade el panel de IA");
      eq(await run(`return document.querySelector(".pr-chip").textContent`), "Abierta");
      eq(await run(`return document.querySelector(".pr-branch").textContent`), "feature/ia → trunk");
      ok((await run(`return document.querySelector(".pr-stats").textContent`)).startsWith("3 archivos · +12 −3"), "totales");
      eq(await run(`return [...document.querySelectorAll(".pr-files .hist-st")].map(x => x.textContent)`), ["A", "M", "R"]);
      await run(`document.querySelectorAll(".pr-files .hist-file")[1].click(); return 1`);
      await waitFor(`return !document.getElementById("diff-view").hidden && !!document.querySelector("#diff-view .monaco-diff-editor")`, "el visor de diferencias", 15000);
      eq(await run(`return document.querySelector("#diff-view .diff-title").textContent`), "chat.ts");
      await key("Escape");
      await waitFor(`return document.getElementById("diff-view").hidden`, "cerrar con Esc");
      await run(`document.querySelector(".pr-back").click(); return 1`);
      await waitFor(`return document.querySelectorAll("#prs-body .pr-row").length === 2`, "volver a la lista");
    });

    await test("«Nueva pull request» propone el título del último commit, crea la PR con la rama actual y abre su detalle", async () => {
      const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
      const subject = git("log", "-1", "--format=%s").trim();
      writes.length = 0;
      await run(`document.getElementById("prs-new").click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario", 15000);
      eq((await dialog()).title, "Nueva pull request");
      eq(await run(`return [...document.querySelectorAll(".modal-form .modal-input")].map(x => x.value)`), [subject, "", "trunk"], "título, descripción y destino propuestos");
      await run(`const f = [...document.querySelectorAll(".modal-form .modal-input")]; f[1].value = "Cambios de la rama"; f[1].dispatchEvent(new Event("input", { bubbles: true })); return 1`);
      await clickBtn("Crear");
      await waitFor(`return !!document.querySelector("#prs-body .pr-detail")`, "el detalle de la nueva PR", 20000);
      const post = writes.find((w) => w.startsWith("POST /repos/e2e/demo/pulls "));
      ok(post, `se creó en GitHub: ${writes}`);
      eq(JSON.parse(post.slice(post.indexOf("{"))), { title: subject, head: branch, base: "trunk", body: "Cambios de la rama" });
      eq(await run(`return document.querySelector(".pr-branch").textContent`), `${branch} → trunk`);
    });

    await test("con una PR ya abierta para esa rama GitHub lo rechaza y Pulso lo explica; con destino igual a la rama avisa antes de enviar", async () => {
      await run(`document.querySelector(".pr-back").click(); return 1`);
      await waitFor(`return document.querySelectorAll("#prs-body .pr-row").length === 3`, "la lista con la nueva");
      await run(`document.getElementById("prs-new").click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario");
      await clickBtn("Crear");
      await waitFor(`return document.querySelector(".modal-title")?.textContent === "No se pudo crear la pull request"`, "el error", 15000);
      ok((await run(`return document.querySelector(".modal-msg").textContent`)).includes("Ya hay una pull request abierta"));
      await clickBtn("Entendido");
      const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
      writes.length = 0;
      await run(`document.getElementById("prs-new").click(); return 1`);
      await waitFor(`return !!document.querySelector(".modal-form")`, "el formulario otra vez");
      await run(`const f = [...document.querySelectorAll(".modal-form .modal-input")]; f[2].value = ${JSON.stringify(branch)}; f[2].dispatchEvent(new Event("input", { bubbles: true })); return 1`);
      await clickBtn("Crear");
      await waitFor(`return document.querySelector(".modal-title")?.textContent === "Aún no se puede crear"`, "el aviso previo");
      await clickBtn("Entendido");
      eq(writes.length, 0, "no se envió nada");
    });

    // ---------- Asistente de IA (herramienta falsa, sin red) ----------
    const FAKE_STATE = path.join(os.tmpdir(), "pulso-fake-claude.json");
    const FAKE_LOG = path.join(os.tmpdir(), "pulso-fake-claude.log.jsonl");
    const fakeLog = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    const aiTool = await invoke("ai_detect").catch(() => null);
    const fakeOn = !!aiTool?.version?.includes("falso");
    console.log(fakeOn ? "\nAsistente de IA (herramienta falsa)" : "\nAsistente de IA: omitido (inicia la app con PULSO_CLAUDE_BIN=scripts\\fake-claude.cmd)");
    let aiBefore = 0;
    const aiSend = async (text) => {
      aiBefore = await run(`return document.querySelectorAll("#view-ai .ai-user").length`);
      await run(`const t = document.querySelector(".ai-input"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return 1`);
    };
    // Termina cuando ya hay un mensaje nuevo de la persona y lo último de la conversación es el resultado o el error de ese turno.
    const aiDone = () => waitFor(`const b = document.querySelector("#view-ai .ai-body"); return document.querySelectorAll("#view-ai .ai-user").length > ${aiBefore} && !document.querySelector(".ai-working") && !!b.lastElementChild?.matches(".ai-outcome, .ai-error")`, "que termine la respuesta", 20000);
    const openAi = async () => { await run(`document.querySelector('.act[data-view="ai"]').click(); return 1`); await waitFor(`return !!document.querySelector("#view-ai .ai-shell")`, "el asistente"); };

    // La herramienta falsa imita a Claude Code: se fija ese proveedor y al terminar se devuelve el que la persona tenía elegido.
    const prevProvider = await run(`return localStorage.getItem("pulso.ai.provider")`);
    // El historial de conversaciones vive en un archivo de la aplicación: se aparta el de la persona y se restaura al terminar.
    const prevHistory = fakeOn ? await invoke("ai_history_read").catch(() => "") : "";
    if (fakeOn) {
      await invoke("ai_history_write", { text: "[]" });
      await run(`localStorage.setItem("pulso.ai.provider", "claude"); return 1`);
      await test("sin sesión iniciada el asistente ofrece iniciarla, y al volver a comprobar queda listo", async () => {
        fs.writeFileSync(FAKE_STATE, JSON.stringify({ loggedIn: false }));
        fs.rmSync(FAKE_LOG, { force: true });
        await run(`for (const k of ["pulso.ai.mode", "pulso.ai.editOk", "pulso.ai.chats", "pulso.ai.model", "pulso.ai.usage", "pulso.ai.usage.v2"]) localStorage.removeItem(k); return 1`);
        await bootApp(gitSession());
        await openAi();
        await waitFor(`return document.querySelector("#view-ai .ai-setup")?.textContent.includes("no hay una sesión iniciada")`, "el aviso de sesión", 15000);
        eq(await run(`return document.querySelector("#view-ai .ai-compose").hidden`), true, "sin sesión no se puede escribir");
        fs.writeFileSync(FAKE_STATE, JSON.stringify({ loggedIn: true }));
        await run(`[...document.querySelectorAll("#view-ai .ai-setup button")].find(b => b.textContent.includes("volver a comprobar")).click(); return 1`);
        await waitFor(`return !document.querySelector("#view-ai .ai-compose").hidden`, "el asistente listo", 15000);
        eq(await run(`return document.querySelector("#view-ai .ai-sub").textContent`), "Claude Code 9.9.9 · plan Max");
        ok(!(await run(`return document.getElementById("view-ai").textContent`)).includes("secreto@example.com"), "no se muestra el correo de la cuenta");
      });

      await test("un mensaje con el archivo y la selección adjuntos llega a la herramienta, y la respuesta se pinta con código, listas y uso del plan", async () => {
        await run(`document.querySelector('.act[data-view="explorer"]').click(); return 1`);
        await waitFor(`return [...document.querySelectorAll("#tree .node .name")].some(n => n.textContent === "a.txt")`, "a.txt");
        await run(`[...document.querySelectorAll("#tree .node")].find(n => n.querySelector(".name")?.textContent === "a.txt").click(); return 1`);
        await waitFor(`return !!document.querySelector(".tab.active")`, "a.txt abierto");
        await run(`const ta = document.querySelector(".group.focused textarea.inputarea"); ta.focus(); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, ctrlKey: true, bubbles: true, cancelable: true })); return 1`);
        await wait(300);
        await openAi();
        await waitFor(`return !!document.querySelector("#view-ai .ai-chip")`, "los chips de contexto", 10000);
        ok((await run(`return [...document.querySelectorAll("#view-ai .ai-chip")].map(c => c.textContent).join("|")`)).includes("a.txt"), "chip del archivo");
        await aiSend("Explícame esto");
        await aiDone();
        const call = fakeLog().pop();
        ok(call.prompt.includes("Archivo abierto: a.txt"), call.prompt);
        ok(call.prompt.endsWith("Mensaje:\nExplícame esto"), "el mensaje va al final");
        ok(call.args.includes("--permission-mode") && call.args.includes("default") && !call.args.join(" ").includes("Edit"), `solo lectura: ${call.args}`);
        eq(await run(`return document.querySelector("#view-ai .ai-user-text").textContent`), "Explícame esto");
        eq(await run(`return document.querySelector("#view-ai .ai-code code").textContent`), "const a = 1;");
        eq(await run(`return document.querySelector("#view-ai .ai-code-head span").textContent`), "js");
        eq(await run(`return document.querySelectorAll("#view-ai .ai-li").length`), 2);
        ok((await run(`return document.querySelector("#view-ai .ai-outcome").textContent`)).startsWith("Listo"), "resultado");
        ok((await run(`return document.querySelector("#view-ai .ai-foot").textContent`)).includes("sesión de 5 h: 34 %"), "uso del plan");
      });

      await test("las herramientas que usa la IA se resumen en una línea y se despliegan", async () => {
        await aiSend("LEE el archivo");
        await aiDone();
        await waitFor(`return !!document.querySelector("#view-ai .ai-tool")`, "la fila de la herramienta");
        eq(await run(`return document.querySelector("#view-ai .ai-tool-text").textContent`), "Leyó a.txt");
        eq(await run(`return document.querySelector("#view-ai .ai-tool-dot").className.includes("ok")`), true);
        await run(`document.querySelector("#view-ai .ai-tool summary").click(); return 1`);
        ok((await run(`return document.querySelector("#view-ai .ai-tool-result")?.textContent`)).includes("linea 1"), "el resultado");
        eq(await run(`return document.querySelector("#view-ai .ai-assistant:last-of-type strong, #view-ai .ai-assistant strong")?.textContent`), "dos líneas");
        // La conversación se reanuda con la sesión de la herramienta.
        const calls = fakeLog();
        ok(calls[calls.length - 1].args.includes("--resume"), "reanuda la sesión anterior");
      });

      await test("«Puede editar» pide confirmar una vez, cambia los permisos y los archivos que la IA modifica se recargan en el editor", async () => {
        await run(`localStorage.removeItem("pulso.ai.editOk"); [...document.querySelectorAll("#view-ai .ai-mode button")].find(b => b.textContent === "Puede editar").click(); return 1`);
        await waitFor(`return !!document.querySelector(".modal")`, "la confirmación");
        eq((await dialog()).title, "Permitir que la IA edite archivos");
        await clickBtn("Permitir editar");
        await waitFor(`return document.querySelector("#view-ai .ai-mode button[aria-selected=true]")?.textContent === "Puede editar"`, "el modo cambiado");
        await aiSend("EDITA a.txt por favor");
        await aiDone();
        const call = fakeLog().pop();
        ok(call.args.includes("acceptEdits"), `permisos de edición: ${call.args}`);
        ok(!call.args.join(" ").includes("Bash"), "nunca comandos");
        ok(fs.readFileSync(`${GROOT}/a.txt`, "utf8").includes("línea añadida por la IA"), "la IA editó el archivo");
        await waitFor(`return document.querySelector(".group.focused .view-lines")?.textContent.includes("añadida")`, "que el editor muestre el cambio sin recargar a mano", 15000);
        await run(`[...document.querySelectorAll("#view-ai .ai-mode button")].find(b => b.textContent === "Solo leer").click(); return 1`);
      });

      await test("parar corta una respuesta en curso", async () => {
        await run(`document.querySelector("#view-ai .ai-chip-x")?.click(); return 1`);
        await aiSend("LENTO por favor");
        await waitFor(`return document.querySelector("#view-ai .ai-send").classList.contains("stop")`, "el botón de parar", 10000);
        await run(`document.querySelector("#view-ai .ai-send").click(); return 1`);
        await waitFor(`return document.querySelector("#view-ai .ai-error")?.textContent.includes("se detuvo")`, "que la conversación se detenga", 15000);
        eq(await run(`return document.querySelector("#view-ai .ai-send").classList.contains("stop")`), false, "vuelve el botón de enviar");
      });

      await test("un error de sesión de la herramienta se muestra con el botón para iniciar sesión", async () => {
        await aiSend("ERROR por favor");
        await aiDone();
        ok((await run(`return document.querySelector("#view-ai .ai-error").textContent`)).includes("Invalid API key"));
        ok(await run(`return [...document.querySelectorAll("#view-ai .ai-error button")].some(b => b.textContent.includes("Iniciar sesión"))`), "ofrece iniciar sesión");
      });

      await test("las conversaciones se guardan, se listan por proyecto y se reabren tras reiniciar", async () => {
        await wait(800); // el historial se escribe en el archivo con un pequeño retraso
        await bootApp(gitSession());
        await openAi();
        await waitFor(`return !document.querySelector("#view-ai .ai-compose").hidden`, "el asistente");
        await run(`document.querySelector('#view-ai .ai-tools button[title="Conversaciones anteriores"]').click(); return 1`);
        await waitFor(`return document.querySelectorAll("#view-ai .ai-hist-row").length >= 1`, "el historial");
        ok((await run(`return document.querySelector("#view-ai .ai-hist-name").textContent`)).length > 0);
        await run(`document.querySelector("#view-ai .ai-hist-open").click(); return 1`);
        await waitFor(`return document.querySelectorAll("#view-ai .ai-user").length >= 1`, "los mensajes de la conversación guardada");
        const before = fakeLog().length;
        await aiSend("seguimos");
        await aiDone();
        const resumed = fakeLog()[before];
        ok(resumed.args.includes("--resume"), "la conversación guardada reanuda su sesión");
      });

      await test("el asistente pasa a pantalla completa con el botón y Esc lo devuelve a la barra lateral", async () => {
        eq(await run(`return document.getElementById("view-ai").classList.contains("ai-docked")`), true);
        await run(`document.querySelector("#view-ai .ai-expand").click(); return 1`);
        await waitFor(`return document.getElementById("view-ai").classList.contains("ai-full")`, "pantalla completa");
        ok((await run(`return document.getElementById("view-ai").getBoundingClientRect().width`)) > 900, "ocupa la ventana");
        await key("Escape");
        await waitFor(`return document.getElementById("view-ai").classList.contains("ai-docked")`, "Esc vuelve");
      });
      await run(`for (const k of ["pulso.ai.mode", "pulso.ai.editOk", "pulso.ai.chats", "pulso.ai.model", "pulso.ai.usage", "pulso.ai.usage.v2", "pulso.aiFull"]) localStorage.removeItem(k); return 1`);
      fs.rmSync(FAKE_STATE, { force: true });
      await wait(800);
      await invoke("ai_history_write", { text: prevHistory || "[]" });
      await run(`${prevProvider ? `localStorage.setItem("pulso.ai.provider", ${JSON.stringify(prevProvider)})` : `localStorage.removeItem("pulso.ai.provider")`}; return 1`);
    }

    await test("sin token no se intenta escribir y Esc cierra el tablero", async () => {
      await invoke("secret_delete", { name: "github-token" });
      await bootApp(gitSession());
      writes.length = 0;
      // Sin token la lectura también falla: el tablero lo explica en vez de quedarse vacío.
      await run(`document.querySelector('.act[data-view="git"]').click(); return 1`);
      await key("i", { ctrl: true, shift: true });
      await run(`document.getElementById("open-board").click(); return 1`);
      await waitFor(`return document.querySelector("#board-view .board-msg")?.textContent.includes("token")`, "el aviso de token", 15000);
      eq(writes.length, 0);
      eq(await run(`return document.querySelector("#board-view .board-msg button")?.textContent ?? null`), "Conectar con GitHub", "ofrece conectar la cuenta en vez de pedir configurar nada");
      await key("Escape");
      await waitFor(`return document.getElementById("board-view").hidden`, "cerrar con Esc");
      // El panel lateral de issues ofrece lo mismo.
      await run(`document.getElementById("refresh-issues").click(); return 1`);
      await waitFor(`return !!document.querySelector("#issues .issues-connect button")`, "el botón de conectar en la lista de issues", 15000);
      eq(await run(`return document.querySelector("#issues .issues-connect button").textContent`), "Conectar con GitHub");
    });
  } finally {
    server.close();
    await run(`localStorage.removeItem("pulso.githubApi"); localStorage.removeItem("pulso.boardWriteOk:e2e/demo"); localStorage.removeItem("pulso.chatSeen:e2e/demo"); return 1`).catch(() => {});
    if (savedToken) await invoke("secret_set", { name: "github-token", value: savedToken }).catch(() => {});
    else await invoke("secret_delete", { name: "github-token" }).catch(() => {});
  }

  await test("fuera de un repositorio el panel lo explica en vez de fallar", async () => {
    await bootApp(session([["a.txt"]]));
    await key("g", { ctrl: true, shift: true });
    await waitFor(`return document.querySelector("#scm-list .scm-empty")?.textContent.includes("repositorio")`, "el mensaje de no-repositorio");
    eq(await run(`return document.getElementById("scm-compose").hidden`), true);
  });
  console.log("\nTareas: scripts de package.json");
  const SROOT = `${ROOT}-scripts`;
  const openScriptPicker = async () => {
    await key("P", { ctrl: true, shift: true });
    await waitFor(`return !document.getElementById("quickopen").hidden`, "la paleta de comandos");
    await run(`const i = document.getElementById("qo-input"); i.value = "script de package"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1`);
    await waitFor(`return document.querySelector("#qo-list li .qo-label")?.textContent.includes("Ejecutar un script")`, "el comando de scripts");
    await run(`document.getElementById("qo-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return 1`);
  };
  await test("la paleta lista los scripts de package.json con el gestor que usa el proyecto", async () => {
    fs.rmSync(SROOT, { recursive: true, force: true });
    fs.mkdirSync(SROOT, { recursive: true });
    fs.writeFileSync(`${SROOT}/package.json`, JSON.stringify({ scripts: { dev: "vite", "test:unit": "vitest run", "mal; rm -rf x": "boom" } }));
    fs.writeFileSync(`${SROOT}/yarn.lock`, "");
    await bootApp({ root: SROOT, layout: { dir: "row", focus: 0, groups: [{ paths: [], active: null, pinned: [] }] } });
    await openScriptPicker();
    await waitFor(`return document.querySelector("#qo-input").placeholder === "Ejecutar un script de package.json" && document.querySelectorAll("#qo-list li .qo-label").length >= 2`, "la lista de scripts");
    eq(await run(`return [...document.querySelectorAll("#qo-list li .qo-label")].map(l => l.textContent)`), ["dev", "test:unit"], "los nombres no seguros se omiten");
    eq(await run(`return document.querySelector("#qo-list li .qo-hint")?.textContent ?? null`), "yarn");
    await run(`document.getElementById("qo-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1`);
  });
  await test("sin package.json la lista lo explica en vez de fallar", async () => {
    fs.rmSync(`${SROOT}/package.json`);
    await openScriptPicker();
    await waitFor(`return document.querySelector("#qo-list li.none")?.textContent.includes("package.json")`, "el mensaje de lista vacía");
    await run(`document.getElementById("qo-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1`);
  });
} finally {
  // Deja la app como estaba.
  if (savedToken) await invoke("secret_set", { name: "github-token", value: savedToken }).catch(() => {});
  else await invoke("secret_delete", { name: "github-token" }).catch(() => {});
  await run(`localStorage.removeItem("pulso.noAutoConnect");
             ${saved.session == null ? 'localStorage.removeItem("pulso.session")' : `localStorage.setItem("pulso.session", ${JSON.stringify(saved.session)})`};
             ${saved.settings == null ? 'localStorage.removeItem("pulso.settings")' : `localStorage.setItem("pulso.settings", ${JSON.stringify(saved.settings)})`};
             ${saved.recent == null ? 'localStorage.removeItem("pulso.recent")' : `localStorage.setItem("pulso.recent", ${JSON.stringify(saved.recent)})`};
             ${saved.lastRoot == null ? 'localStorage.removeItem("pulso.lastRoot")' : `localStorage.setItem("pulso.lastRoot", ${JSON.stringify(saved.lastRoot)})`};
             location.reload(); return 1`).catch(() => {});
  for (const b of (await invoke("backup_list").catch(() => [])) ?? []) if (b.path.startsWith(ROOT)) await invoke("backup_remove", { path: b.path }).catch(() => {});
  await invoke("term_kill_all").catch(() => {});
  ws.close();
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(`${ROOT}-git`, { recursive: true, force: true }); fs.rmSync(`${ROOT}-bare`, { recursive: true, force: true }); fs.rmSync(`${ROOT}-clone`, { recursive: true, force: true }); fs.rmSync(`${ROOT}-scripts`, { recursive: true, force: true }); break; } catch (e) {
      if (i === 9) console.log("  (no se pudo borrar la carpeta temporal: " + e.code + ")");
      await wait(500);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} pruebas correctas${failed.length ? `, ${failed.length} fallaron` : ""}.`);
process.exit(failed.length ? 1 : 0);
