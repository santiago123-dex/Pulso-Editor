// Medición aislada del LSP: solo lee el proyecto y nunca guarda el documento abierto.
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [rootArg, ...fileArgs] = process.argv.slice(2);
if (!rootArg || !fileArgs.length) throw new Error('Uso: node scripts/perf-real-lsp.mjs "carpeta" "archivo relativo" [más archivos]');
const root = resolve(rootArg);
const files = await Promise.all(fileArgs.map(async arg => {
  const file = resolve(root, arg), rel = relative(root, file);
  if (!rel || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) throw new Error("El archivo debe estar dentro del proyecto.");
  return { file, rel, contents: await readFile(file, "utf8") };
}));
const { file, rel, contents } = files[0];
function processes() {
  if (process.platform !== "win32") return [];
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  try { const parsed = JSON.parse(result.stdout || "[]"); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; }
}
const baseline = new Set(processes().map(p => p.Id));
const started = performance.now();
const child = spawn(process.execPath, ["--require", resolve("scripts/lsp-no-console.cjs"), resolve("node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let bytes = Buffer.alloc(0), sequence = 0, errors = "";
const requests = new Map();
let diagnosticsAt;
child.stderr.on("data", data => { errors += data.toString().slice(0, 4096); });
function send(value) { const body = Buffer.from(JSON.stringify(value)); child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body); }
function request(method, params) { const id = ++sequence; return new Promise((resolveRequest, reject) => { const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Tiempo agotado: ${method}`)); }, 45000); requests.set(id, { resolveRequest, reject, timer }); send({ jsonrpc: "2.0", id, method, params }); }); }
child.stdout.on("data", data => {
  bytes = Buffer.concat([bytes, data]);
  while (true) {
    const end = bytes.indexOf("\r\n\r\n"); if (end < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(bytes.subarray(0, end).toString())?.[1]);
    if (!Number.isFinite(length) || bytes.length < end + 4 + length) return;
    const message = JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString()); bytes = bytes.subarray(end + 4 + length);
    if (message.method === "textDocument/publishDiagnostics" && diagnosticsAt === undefined) diagnosticsAt = performance.now();
    if (message.method && message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => ({})) : null });
    else if (!message.method && requests.has(message.id)) { const pending = requests.get(message.id); requests.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error.message)) : pending.resolveRequest(message.result); }
  }
});
try {
  const rootUri = pathToFileURL(root).href, uri = pathToFileURL(file).href;
  await request("initialize", { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "proyecto" }], capabilities: { workspace: { configuration: true }, textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } } }, initializationOptions: { hostInfo: "Pulso", disableAutomaticTypingAcquisition: true } });
  const initialized = performance.now();
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  for (const entry of files) {
    const languageId = /\.tsx$/i.test(entry.file) ? "typescriptreact" : /\.jsx$/i.test(entry.file) ? "javascriptreact" : /\.[cm]?js$/i.test(entry.file) ? "javascript" : "typescript";
    send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: pathToFileURL(entry.file).href, languageId, version: 1, text: entry.contents } } });
  }
  const lines = contents.split(/\r?\n/); const line = Math.max(0, lines.findIndex(s => /\bimport\s+[A-Za-z_$]/.test(s)));
  const imported = /\bimport\s+([A-Za-z_$][\w$]*)/.exec(lines[line]);
  const character = imported ? imported.index + imported[0].lastIndexOf(imported[1]) : Math.max(0, lines[line].search(/[A-Za-z_$]/));
  const startHover = performance.now();
  const hoverResult = await request("textDocument/hover", { textDocument: { uri }, position: { line, character } });
  const hover = performance.now();
  await new Promise(resolveWait => setTimeout(resolveWait, 5000));
  const nodes = processes().filter(p => !baseline.has(p.Id) || p.Id === child.pid);
  console.log(JSON.stringify({ archivo: rel, archivos_abiertos: files.length, bytes: files.reduce((n, f) => n + Buffer.byteLength(f.contents), 0), inicio_lsp_ms: Math.round(initialized - started), primer_hover_ms: Math.round(hover - startHover), hover_encontrado: Boolean(hoverResult), primeros_diagnosticos_ms: diagnosticsAt === undefined ? null : Math.round(diagnosticsAt - initialized), memoria_node_mb: nodes.map(p => ({ pid: p.Id, mb: Math.round(p.WorkingSet64 / 1048576), cpu_segundos: p.CPU })), nota: "Memoria de procesos Node nuevos observados durante la medición; puede incluir otros procesos iniciados simultáneamente. No mide WebView2 ni el editor." }, null, 2));
  await request("shutdown", null).catch(() => {});
  send({ jsonrpc: "2.0", method: "exit", params: null });
} finally {
  child.stdin.end();
  if (child.exitCode === null) { const timer = setTimeout(() => child.kill(), 2000); await new Promise(resolveClose => child.once("close", resolveClose)); clearTimeout(timer); }
  if (errors) process.stderr.write(errors.slice(0, 4096));
}
