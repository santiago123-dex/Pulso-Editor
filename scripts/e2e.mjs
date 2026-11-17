// Pruebas de extremo a extremo sobre la app real de Pulso.
//
// Requisitos: la app debe estar en ejecución con el puerto de depuración de WebView2 abierto:
//   PowerShell:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"; npx tauri dev
//   Después:     npm run e2e
//
// El script usa una carpeta temporal, no toca tus proyectos y restaura la sesión y la configuración al terminar.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
const saved = await run(`return { session: localStorage.getItem("pulso.session"), settings: localStorage.getItem("pulso.settings"), recent: localStorage.getItem("pulso.recent"), lastRoot: localStorage.getItem("pulso.lastRoot") }`);
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
  await test("la primera vez ofrece adaptar la terminal y 'No, gracias' no cambia nada", async () => {
    await run(`const s=JSON.parse(localStorage.getItem("pulso.settings")); s.terminalAdapted=false; s.terminalScheme=""; s.terminalFont=""; localStorage.setItem("pulso.settings", JSON.stringify(s)); location.reload(); return 1`);
    await wait(1500);
    await waitFor(`return document.body.classList.contains("ready")`, "el arranque", 20000);
    await key("j", { ctrl: true });
    // En un equipo sin VS Code ni Windows Terminal no hay nada que ofrecer: el panel se abre directamente.
    await waitFor(`return !!document.querySelector(".modal-title") || !document.getElementById("panel").hidden`, "el aviso o el panel", 20000);
    const asked = await run(`return document.querySelector(".modal-title")?.textContent`);
    if (asked) {
      eq(asked, "Adaptar la terminal a la tuya");
      ok((await run(`return document.querySelector(".modal-msg").textContent`)).includes("Colores"), "enumera lo que encontró");
      await clickBtn("No, gracias");
    }
    await waitFor(`return !document.getElementById("panel").hidden`, "el panel de la terminal", 20000);
    const s = JSON.parse(await run(`return localStorage.getItem("pulso.settings")`));
    eq(s.terminalAdapted, true, "no vuelve a preguntar");
    eq(s.terminalScheme, "", "no se cambió el esquema");
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
  const clickRowAct = (name) => run(`const r=[...document.querySelectorAll("#scm-list .scm-row")].find(r=>r.querySelector(".scm-name").textContent===${JSON.stringify(name)}); r.querySelector(".scm-act").click(); return 1`);

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

  await test("fuera de un repositorio el panel lo explica en vez de fallar", async () => {
    await bootApp(session([["a.txt"]]));
    await key("g", { ctrl: true, shift: true });
    await waitFor(`return document.querySelector("#scm-list .scm-empty")?.textContent.includes("repositorio")`, "el mensaje de no-repositorio");
    eq(await run(`return document.getElementById("scm-compose").hidden`), true);
  });
} finally {
  // Deja la app como estaba.
  await run(`${saved.session == null ? 'localStorage.removeItem("pulso.session")' : `localStorage.setItem("pulso.session", ${JSON.stringify(saved.session)})`};
             ${saved.settings == null ? 'localStorage.removeItem("pulso.settings")' : `localStorage.setItem("pulso.settings", ${JSON.stringify(saved.settings)})`};
             ${saved.recent == null ? 'localStorage.removeItem("pulso.recent")' : `localStorage.setItem("pulso.recent", ${JSON.stringify(saved.recent)})`};
             ${saved.lastRoot == null ? 'localStorage.removeItem("pulso.lastRoot")' : `localStorage.setItem("pulso.lastRoot", ${JSON.stringify(saved.lastRoot)})`};
             location.reload(); return 1`).catch(() => {});
  for (const b of (await invoke("backup_list").catch(() => [])) ?? []) if (b.path.startsWith(ROOT)) await invoke("backup_remove", { path: b.path }).catch(() => {});
  await invoke("term_kill_all").catch(() => {});
  ws.close();
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(`${ROOT}-git`, { recursive: true, force: true }); break; } catch (e) {
      if (i === 9) console.log("  (no se pudo borrar la carpeta temporal: " + e.code + ")");
      await wait(500);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} pruebas correctas${failed.length ? `, ${failed.length} fallaron` : ""}.`);
process.exit(failed.length ? 1 : 0);
