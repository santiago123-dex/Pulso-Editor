# Instalación y prueba de la versión instalada

## Generar el instalador

```bash
npm run tauri build -- --bundles nsis
```

Produce `src-tauri/target/release/bundle/nsis/Pulso Editor_0.1.0_x64-setup.exe` (≈ 8,4 MB). La primera compilación de producción tarda unos 3 minutos. El instalador se instala por usuario en `%LOCALAPPDATA%\Pulso Editor` (`/S` para instalación silenciosa). Incluye el servidor de TypeScript y la configuración que usa el LSP; no incluye Node.js.

## Linux (Fedora): paquete .rpm

Desde Windows, con Docker Desktop en marcha:

```powershell
./packaging/linux/build-rpm.ps1
```

Compila dentro de un contenedor Fedora (`packaging/linux/Dockerfile`) y deja el paquete en `dist-linux/`. En Fedora:

```bash
sudo dnf install ./Pulso\ Editor-0.1.0-1.x86_64.rpm
pulso-editor        # la ventana
pulso               # el asistente de IA en la terminal (también `pulso .` abre la ventana)
```

El paquete instala los dos programas en `/usr/bin`, así que `pulso` ya está en el PATH. Las herramientas de IA (`claude`, `codex`, `agy`) se buscan en el PATH y en `~/.local/bin`. No se probó ejecutándolo en un Fedora real: solo se comprobó que compila y qué dependencias declara el paquete.

## Qué se probó en la versión instalada

Probado el 17/11/2026 en un solo equipo con Windows 11 (el del desarrollo, con Node, Git y WebView2 ya instalados):

- Las pruebas e2e (44) pasan contra la aplicación instalada, que se sirve desde `tauri.localhost` y no desde el servidor de desarrollo.
- El LSP funciona con los recursos empaquetados: primer Ctrl+clic, cursor, hover y diagnóstico (`PULSO_EXE=… npm run test:lsp:ui`).
- Sin Node ni Git en el `PATH` la aplicación arranca, no lanza errores de página y degrada con mensajes claros: «LSP: detenido» con el motivo y la indicación de instalar Node.js, y el panel Git explica que falta Git.
- `npm run perf` contra la compilación de producción da cifras parecidas a las de depuración (ver [Rendimiento](RENDIMIENTO.md)).

## Qué NO se probó

- Un Windows limpio o una máquina virtual (sin herramientas de desarrollo, sin WebView2 preinstalado).
- El instalador MSI (solo se generó NSIS) y la desinstalación completa.
- Firma de código: el instalador no está firmado, así que SmartScreen mostrará una advertencia.
- Actualizaciones automáticas.
- La política de seguridad del contenido (`csp`) sigue en `null` en `tauri.conf.json`; conviene acotarla antes de distribuir.
- La app instalada y la de desarrollo comparten datos (mismo identificador `dev.pulso.editor`): configuración, sesión y copias de recuperación.
