// El servidor LSP crea procesos tsserver. En Windows también deben ejecutarse sin ventanas.
if (process.platform === "win32") {
  const childProcess = require("node:child_process");
  const originalFork = childProcess.fork;
  childProcess.fork = function (modulePath, args, options) {
    if (!Array.isArray(args)) return originalFork.call(this, modulePath, { ...args, windowsHide: true });
    return originalFork.call(this, modulePath, args, { ...options, windowsHide: true });
  };
  require("node:module").syncBuiltinESMExports();
}
