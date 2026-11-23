# Instalación y prueba de la versión instalada

## Generar el instalador

```bash
npm run tauri build -- --bundles nsis
```

Produce `src-tauri/target/release/bundle/nsis/Pulso Editor_0.1.0_x64-setup.exe` (≈ 8,4 MB). La primera compilación de producción tarda unos 3 minutos. El instalador se instala por usuario en `%LOCALAPPDATA%\Pulso Editor` (`/S` para instalación silenciosa). Incluye el servidor nativo de TypeScript 7 (unos 28 MB sin comprimir; el instalador pasó de 11,9 a 16,3 MB), así que la inteligencia de TypeScript y JavaScript funciona sin Node.js. Node solo hace falta para el modo compatible de proyectos con TypeScript 5 o 6, que ya lo tienen.

Si el equipo no tiene WebView2, el instalador descarga el instalador de Microsoft y lo ejecuta sin preguntar (`webviewInstallMode: downloadBootstrapper` en `tauri.conf.json`). Para eso necesita conexión a internet. En Windows 11 y en la mayoría de los Windows 10 actualizados ya viene instalado.

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
- Sin Node ni Git en el `PATH` la aplicación arranca, no lanza errores de página y degrada con mensajes claros: «LSP: detenido» con el motivo y la indicación de instalar Node.js, y el panel Git explica que falta Git. (Prueba anterior al servidor nativo de TypeScript 7; desde entonces, sin Node el LSP debería arrancar igual. Falta repetirla.)
- `npm run perf` contra la compilación de producción da cifras parecidas a las de depuración (ver [Rendimiento](RENDIMIENTO.md)).

## Publicar una versión desde GitHub

El flujo `.github/workflows/release.yml` se activa al subir una etiqueta `vX.Y.Z`, que debe coincidir con la versión de `src-tauri/tauri.conf.json`. Por ejemplo, para publicar la 0.2.0 después de cambiar la versión en `tauri.conf.json`, `package.json` y `Cargo.toml`:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

Compila el instalador NSIS en Windows y los paquetes .deb, .rpm y AppImage en Linux (Ubuntu 22.04), y los adjunta a un **borrador** de release en el repositorio público [Pulso-Editor-releases](https://github.com/santiago123-dex/Pulso-Editor-releases), no en este, que es privado. Hay que revisarlo y publicarlo a mano allí. Ese repositorio solo tiene un README y las releases. La etiqueta se crea en los dos: la que subes aquí dispara el flujo, y la de allí la crea el flujo sobre su rama `main`.

Para publicar allí, el flujo necesita el secreto `RELEASES_TOKEN`, porque el token automático de GitHub solo vale para este repositorio. Es un *fine-grained personal access token* creado en GitHub (*Settings → Developer settings → Personal access tokens → Fine-grained tokens*), limitado al repositorio `Pulso-Editor-releases`, con el permiso *Contents: Read and write* y nada más. Caduca: hay que renovarlo antes de la fecha que se le ponga y actualizar el secreto. Los instaladores no tienen firma de código (SmartScreen avisa). No se genera versión para macOS porque nunca se compiló ahí. Este flujo todavía no se ha ejecutado en GitHub.

## Aplicación OAuth de GitHub (iniciar sesión con un código)

El inicio de sesión por código necesita el identificador público (*Client ID*) de una aplicación OAuth de GitHub. **No** hace falta su secreto, y el identificador no es privado.

Para registrarla:
1. En GitHub, ve a *Settings → Developer settings → OAuth Apps → New OAuth App*.
2. Rellena los campos:
   - *Application name*: «Pulso Editor».
   - *Homepage URL*: la del repositorio de releases.
   - *Authorization callback URL*: GitHub la exige aunque este método no la usa; vale `http://127.0.0.1/`.
3. Marca **Enable Device Flow**.
4. Copia el *Client ID*.

La aplicación está registrada en la cuenta de santiago123-dex con *Device Flow* activado y **sin** «Expire user access tokens», porque Pulso aún no renueva tokens que caducan. Su identificador (`Ov23ctd2I0EnevVSgO2p`) está en `CLIENT_ID` de `src-tauri/src/githubdevice.rs`. Se puede cambiar al compilar con la variable `PULSO_GITHUB_CLIENT_ID`; si la variable está vacía, «Conectar con GitHub» usa la sesión de Git del equipo.

Las organizaciones con restricciones para aplicaciones OAuth tendrán que aprobar «Pulso Editor» para que vea sus repositorios.

## Actualizaciones automáticas

La versión instalada busca una versión nueva 8 s después de arrancar, y cuando se pide con «Ayuda: Buscar actualizaciones» (paleta o menú Ayuda). Lee `latest.json` de la última release publicada de `Pulso-Editor-releases` (`plugins.updater.endpoints` en `tauri.conf.json`). Si hay una versión nueva, lo pregunta y muestra las notas de la release. Al aceptar:

1. Guarda los documentos con cambios. Si alguno no se puede guardar, no instala.
2. Descarga el paquete y comprueba su firma con la clave pública de `tauri.conf.json`.
3. Detiene terminales, LSP y procesos de IA, instala sin pedir nada (modo `passive` en Windows) y vuelve a abrir Pulso.

La búsqueda automática no avisa si falla, por ejemplo sin conexión. Las compilaciones de desarrollo no se actualizan nunca.

**Firma de las actualizaciones.** Es independiente de la firma de código del instalador. La clave privada está en `%USERPROFILE%\.tauri\pulso-updater.key`, fuera del repositorio. La pública está en `tauri.conf.json`. El flujo de publicación firma los paquetes con dos secretos del repositorio: `TAURI_SIGNING_PRIVATE_KEY` (el contenido del archivo `.key`) y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Solo firma en GitHub, mediante `src-tauri/tauri.updater.conf.json`: las compilaciones locales no necesitan la clave. **Si se pierde la clave privada o su contraseña, las versiones ya instaladas no podrán actualizarse más.** Hay que guardar una copia de seguridad.

**Requisitos para que funcione:**
- El repositorio de releases tiene que seguir siendo **público**. Desde un repositorio privado, Pulso no puede descargar `latest.json`.
- El flujo necesita los secretos `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` y `RELEASES_TOKEN` en este repositorio.
- La release tiene que estar **publicada**: ni borrador ni versión preliminar.
- La versión nueva tiene que ser mayor que la instalada.

En Linux solo se actualiza el AppImage. Los paquetes .deb y .rpm se actualizan reinstalando.

Probado: se genera el instalador firmado (`.sig`) con una clave de prueba y la ruta de configuración que usa el flujo, y la compilación local sin clave sigue funcionando. No probado: una actualización real de principio a fin, que requiere publicar dos versiones.

## Qué NO se probó

- Un Windows limpio o una máquina virtual (sin herramientas de desarrollo, sin WebView2 preinstalado).
- El instalador MSI (solo se generó NSIS) y la desinstalación completa.
- Firma de código: el instalador no está firmado, así que SmartScreen mostrará una advertencia.
- Una actualización automática real de una versión a otra.
- La política de seguridad del contenido (`csp`) ya está acotada en `src-tauri/tauri.conf.json` (con `connect-src` restringido a IPC local; las llamadas a GitHub salen desde Rust).

## Datos de la versión instalada y de la de desarrollo

La versión instalada usa el identificador `dev.pulso.editor`. Las compilaciones sin optimizar usan `dev.pulso.editor.dev`: `src-tauri\target\debug\pulso-editor.exe`, `npm run tauri -- dev` y el instalador generado con `--debug`. Por eso guardan configuración, sesión, copias de recuperación y datos del WebView en carpetas distintas de `%APPDATA%` y `%LOCALAPPDATA%`, y las dos pueden estar abiertas a la vez. El token de GitHub del almacén de credenciales se comparte. La primera vez que se abre la versión de desarrollo empieza sin configuración: lo anterior a este cambio quedó en la carpeta de la instalada.
