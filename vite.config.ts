import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Vigilar src-tauri (miles de archivos de compilación y carpetas temporales) mantenía a Vite al 100 % de CPU
    // y retrasaba cada solicitud del modo desarrollo, entre ellas los iconos de carpetas nuevas.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
