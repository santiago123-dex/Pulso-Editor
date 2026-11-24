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

Si lanzas las pruebas de Rust desde una herramienta automatizada (sin una consola real), las dos de Ctrl+C de `term.rs` pueden fallar sin que haya un error: ejecútalas con `PULSO_SKIP_CTRL_C=1` para saltarlas. Desde una terminal normal pasan.

**El formato es obligatorio.** El proyecto está formateado de forma uniforme y la CI (trabajo «Calidad») pone en rojo un PR que no lo cumpla. Antes de subir:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
npx prettier --write "src/**/*.ts"
```

(`npm run format:check` solo comprueba, sin cambiar nada; hace falta `npm install` para tener Prettier.) Las reglas están en `src-tauri/rustfmt.toml` y `.prettierrc.json`; `src/locales` no se formatea.

La CI también ejecuta, **solo como aviso** (no bloquean el PR): `cargo clippy`, `cargo audit` y `npm audit`.

## Convenciones

- **Idioma del código y claves de interfaz:** el texto base en `t("…")` (TypeScript) y `tr("…")` (Rust) va en español; cada texto nuevo debe añadir su traducción al inglés en `src/locales/en.ts` o `src-tauri/src/i18n.rs`.
- **Seguridad:** todas las operaciones de archivos desde el WebView pasan por `WorkspaceGuard` (`src-tauri/src/fsguard.rs`). No añadas comandos de disco sin validar fronteras.
- **Pruebas:** añade pruebas unitarias junto a cada cambio de lógica en `src/*.test.ts` o módulos `#[cfg(test)]` en Rust.
