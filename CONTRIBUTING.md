# Contribuir a Pulso Editor

¡Gracias por tu interés en contribuir a Pulso Editor!

## Requisitos previos

- **Node.js** 20+ y `npm`
- **Rust** (toolchain estable) y `cargo`
- En Windows: WebView2 Runtime (incluido en Windows 11)
- En Linux: dependencias de Tauri 2 (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, etc.)

## Desarrollo local

```bash
npm install
npm run tauri dev
```

## Verificación antes de abrir una Pull Request

Ejecuta siempre estas comprobaciones y asegúrate de que pasen sin errores:

```bash
npx tsc --noEmit
npm test
node scripts/i18n-keys.mjs --missing
npm run test:rust
npm run build
```

## Convenciones

- **Idioma del código y claves de interfaz:** el texto base en `t("…")` (TypeScript) y `tr("…")` (Rust) va en español; cada texto nuevo debe añadir su traducción al inglés en `src/locales/en.ts` o `src-tauri/src/i18n.rs`.
- **Seguridad:** todas las operaciones de archivos desde el WebView pasan por `WorkspaceGuard` (`src-tauri/src/fsguard.rs`). No añadas comandos de disco sin validar fronteras.
- **Pruebas:** añade pruebas unitarias junto a cada cambio de lógica en `src/*.test.ts` o módulos `#[cfg(test)]` en Rust.
