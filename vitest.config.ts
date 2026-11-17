import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Monaco necesita un navegador; en las pruebas se usa un sustituto y cada prueba lo simula.
      "monaco-editor": fileURLToPath(new URL("./src/test/monaco-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
