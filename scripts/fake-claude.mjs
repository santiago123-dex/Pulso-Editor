// Herramienta falsa que imita lo que Pulso usa de `claude` (versión, estado de sesión y -p con stream-json), para las pruebas e2e.
// La app de desarrollo se inicia con PULSO_CLAUDE_BIN apuntando a fake-claude.cmd. No habla con ningún servicio.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = os.tmpdir();
const STATE = path.join(tmp, "pulso-fake-claude.json");
const LOG = path.join(tmp, "pulso-fake-claude.log.jsonl");
const args = process.argv.slice(2);
const state = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args[0] === "--version") { console.log("9.9.9 (Claude Code falso)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  const s = state();
  console.log(JSON.stringify({ loggedIn: s.loggedIn !== false, authMethod: "claude.ai", email: "secreto@example.com", subscriptionType: "max" }));
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
fs.appendFileSync(LOG, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\n");

const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const session = resume ?? `sess-${Date.now().toString(36)}`;
const base = { session_id: session };
const ev = (event) => out({ type: "stream_event", event, ...base });
let n = 0;
const msgId = () => `msg_${session}_${++n}`;
const text = async (message, s) => {
  const id = msgId();
  ev({ type: "message_start", message: { id } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const part of s.match(/[\s\S]{1,14}/g) ?? []) { ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }); await sleep(5); }
  out({ type: "assistant", message: { id, content: [{ type: "text", text: s }] }, ...base });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_stop" });
};
const toolTurn = async (name, input, result, isError = false) => {
  const id = msgId();
  const toolId = `toolu_${n}`;
  ev({ type: "message_start", message: { id } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name, input: {} } });
  const json = JSON.stringify(input);
  ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 10) } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(10) } });
  out({ type: "assistant", message: { id, content: [{ type: "tool_use", id: toolId, name, input }] }, ...base });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_stop" });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: result, is_error: isError }] }, ...base });
};

out({ type: "system", subtype: "init", model: "claude-falso-1", ...base });
const usage = (a, b) => out({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: a, resetsAt: Math.floor(Date.now() / 1000) + 7500 }, seven_day: { utilization: b, resetsAt: Math.floor(Date.now() / 1000) + 90000 } } }, ...base });

if (/ERROR/.test(prompt)) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · Please run /login", total_cost_usd: 0, duration_ms: 5, ...base });
  process.exit(1);
}
if (/LENTO/.test(prompt)) {
  await text("empiezo…", "Empiezo a pensar. ");
  await sleep(60_000);
}
const edit = /EDITA (\S+)/.exec(prompt);
if (edit) {
  const file = path.join(process.cwd(), edit[1]);
  fs.appendFileSync(file, "\nlínea añadida por la IA\n");
  await toolTurn("Edit", { file_path: file }, "El archivo se editó");
  await text("m", "Listo, edité el archivo.");
} else if (/LEE/.test(prompt)) {
  await toolTurn("Read", { file_path: path.join(process.cwd(), "a.txt") }, "1\tlinea 1");
  await text("m", "El archivo tiene **dos líneas** y usa `texto plano`.");
} else {
  await text("m", "Hola desde la IA falsa.\n\n```js\nconst a = 1;\n```\n\n- uno\n- dos");
}
usage(0.34, 0.2);
out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, duration_ms: 1234, ...base });
