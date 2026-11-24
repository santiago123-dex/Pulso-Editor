# Evaluación de pruebas E2E (`scripts/e2e.mjs`) en la CI

Este documento evalúa ejecutar las 68 comprobaciones de `npm run e2e` dentro de GitHub Actions (`windows-latest`).

## Cómo funciona `scripts/e2e.mjs` hoy

- Arranca `pulso-editor.exe` con WebView2 en modo depuración remota (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=...`).
- Se conecta por Chrome DevTools Protocol (CDP) a la ventana viva para interactuar con Monaco, pestañas, terminal, Git, LSP y diálogos.
- Necesita un entorno de escritorio Windows con WebView2 Runtime y aceleración/renderizado de ventana reales.

## Por qué NO se activa todavía en cada push de `.github/workflows/ci.yml`

1. **Sesión gráfica y estabilidad en `windows-latest`:** los runners alojados de GitHub corren en una sesión sin usuario interactivo donde WebView2 presenta fallos intermitentes de inicialización de GPU/compositor y tiempos variables al abrir ventanas con `decorations: false`.
2. **Tiempo de compilación:** `e2e.mjs` exige compilar el binario completo de Tauri antes de lanzar los 68 casos (~6–9 min adicionales por push en Windows, multiplicando el tiempo de la CI actual de ~5 min a >13 min).
3. **Cobertura ya asegurada en CI rápida:** `.github/workflows/ci.yml` ya ejecuta en Windows y Linux las 480+ pruebas unitarias de Vitest, `tsc && vite build`, `test:windows` (arranque del LSP) y todas las pruebas de Rust (`cargo test`).

## Recomendación

- Mantener `npm run e2e` como comprobación **previa a cada release** en máquina Windows con escritorio real (o en un futuro job opcional `workflow_dispatch` sobre `windows-latest` con `--disable-gpu` y `timeout-minutes: 25` cuando se necesite regresión visual automatizada).
- Seguir ampliando pruebas unitarias de vistas (`debugView.test.ts`, `extView.test.ts`, etc.) en Vitest, que corren en ~2 s en Windows y Linux sin depender de WebView2.
