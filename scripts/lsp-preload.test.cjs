const { test } = require("node:test");
const assert = require("node:assert/strict");

test("los procesos hijos del servidor se crean sin ventanas en Windows", () => {
  const child = require("node:child_process");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const original = child.fork;
  const calls = [];
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    child.fork = (...args) => { calls.push(args); return {}; };
    require("./lsp-no-console.cjs");
    child.fork("tsserver.js", ["--example"], { silent: true });
    child.fork("other.js", { cwd: "C:/project" });
    assert.equal(calls[0][2].windowsHide, true);
    assert.equal(calls[0][2].silent, true);
    assert.equal(calls[1][1].windowsHide, true);
    assert.equal(calls[1][1].cwd, "C:/project");
  } finally {
    child.fork = original;
    Object.defineProperty(process, "platform", platform);
    require("node:module").syncBuiltinESMExports();
  }
});
