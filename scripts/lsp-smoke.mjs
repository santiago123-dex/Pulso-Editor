// Prueba del servidor real con un proyecto temporal y cambios que aún no están en disco.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = await mkdtemp(join(resolve("."), ".pulso-lsp-test-"));
const file = join(root, "main.ts");
const other = join(root, "other.ts");
await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, moduleResolution: "node", baseUrl: ".", paths: { "@/*": ["./*"] } } }));
await writeFile(other, "export const saludo: string = 'hola';\n");
await writeFile(file, "import { saludo } from '@/other';\nconst resultado = saludo;\n");
const packaged = process.env.PULSO_LSP_PACKAGED === "1";
const server = spawn(process.execPath, ["--require", resolve(packaged ? "src-tauri/target/debug/lsp/no-console.cjs" : "scripts/lsp-no-console.cjs"), resolve(packaged ? "src-tauri/target/debug/lsp/node_modules/typescript-language-server/lib/cli.mjs" : "node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let buffer = Buffer.alloc(0), next = 0;
const pending = new Map();
const diagnostics = [];
const notices = [];
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk; });
server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n"); if (end < 0) break;
    const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString());
    if (!match) throw new Error("Cabecera LSP inválida");
    const length = Number(match[1]); if (buffer.length < end + 4 + length) break;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    if (msg.method) notices.push(msg);
    buffer = buffer.subarray(end + 4 + length);
    if (msg.method === "textDocument/publishDiagnostics") diagnostics.push(msg.params);
    if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, result: msg.method === "workspace/configuration" ? (msg.params.items ?? []).map(() => ({})) : null });
    else if (pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
  }
});
function send(msg) { const data = Buffer.from(JSON.stringify(msg)); server.stdin.write(`Content-Length: ${data.length}\r\n\r\n`); server.stdin.write(data); }
function request(method, params) { const id = ++next; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
const waitFor = async (predicate) => { const until = Date.now() + 15000; while (!predicate()) { if (Date.now() > until) throw new Error(`Tiempo agotado. ${stderr} ${JSON.stringify(notices)}`); await new Promise((r) => setTimeout(r, 50)); } };
const timeout = setTimeout(() => { console.error("Tiempo agotado esperando al servidor LSP", stderr); server.kill(); process.exitCode = 1; }, 30000);
try {
  const rootUri = pathToFileURL(root).href, fileUri = pathToFileURL(file).href, otherUri = pathToFileURL(other).href;
  const initialized = await request("initialize", { processId: null, rootUri, workspaceFolders: [{ uri: rootUri, name: "test" }], capabilities: { workspace: { configuration: true }, textDocument: { publishDiagnostics: { versionSupport: true }, completion: { completionItem: { snippetSupport: true } }, hover: { contentFormat: ["markdown", "plaintext"] }, definition: { linkSupport: true } } }, initializationOptions: { disableAutomaticTypingAcquisition: true } });
  const sync = initialized.capabilities.textDocumentSync;
  assert.equal(typeof sync === "number" ? sync : sync.change, 2, "el servidor debe admitir cambios incrementales");
  notify("initialized", {});
  notify("textDocument/didOpen", { textDocument: { uri: fileUri, languageId: "typescript", version: 1, text: "import { saludo } from '@/other';\nconst resultado = saludo;\n" } });
  notify("textDocument/didChange", { textDocument: { uri: fileUri, version: 2 }, contentChanges: [
    { range: { start: { line: 1, character: 25 }, end: { line: 2, character: 0 } }, text: "\nsalu" },
    { range: { start: { line: 1, character: 15 }, end: { line: 1, character: 15 } }, text: ": number" },
  ] });
  await waitFor(() => diagnostics.some((d) => decodeURIComponent(d.uri).toLowerCase() === decodeURIComponent(fileUri).toLowerCase() && d.diagnostics.some((item) => item.code === 2322)));
  const definition = await request("textDocument/definition", { textDocument: { uri: fileUri }, position: { line: 1, character: 27 } });
  assert.ok(definition.some((x) => decodeURIComponent(x.uri ?? x.targetUri).toLowerCase() === decodeURIComponent(otherUri).toLowerCase()), `debe encontrar la definición en otro archivo: ${JSON.stringify(definition)}`);
  const completions = await request("textDocument/completion", { textDocument: { uri: fileUri }, position: { line: 2, character: 4 } });
  assert.ok((Array.isArray(completions) ? completions : completions.items).some((item) => item.label === "saludo"), "debe completar contenido sin guardar");
  const hover = await request("textDocument/hover", { textDocument: { uri: fileUri }, position: { line: 1, character: 27 } });
  assert.ok(JSON.stringify(hover).includes("saludo"), "debe mostrar información del símbolo");
  console.log("LSP real: alias, definición, hover, diagnósticos y autocompletado de cambios sin guardar: OK");
} finally {
  clearTimeout(timeout);
  server.kill();
  await new Promise((r) => server.once("close", r));
  await rm(root, { recursive: true, force: true });
}
