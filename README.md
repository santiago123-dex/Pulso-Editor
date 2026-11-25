# Pulso Editor

Pulso es un editor de código de escritorio construido con Tauri, Rust, TypeScript y Monaco. Incluye explorador de archivos, terminal, búsqueda, integración inicial con Git y GitHub, y un servidor de lenguaje para proyectos TypeScript y JavaScript.


LSP = Language server protocol


## Probar Pulso en Windows

### Opción 1: ejecutable ya compilado

En este equipo, si ya compilaste la versión de prueba, abre desde el Explorador de Windows:

```text
src-tauri\target\debug\pulso-editor.exe
```

También puedes ejecutarlo desde PowerShell, situado en la carpeta del proyecto:

```powershell
.\src-tauri\target\debug\pulso-editor.exe
```

Es una **compilación de prueba**, no una instalación. Conserva junto al `.exe` la carpeta `lsp` generada dentro de `target\debug`: contiene recursos necesarios para la inteligencia de código. Para probar la aplicación como instalada, usa el instalador de la siguiente sección.

### Opción 2: crear e instalar la aplicación

1. Abre PowerShell en la carpeta de Pulso.
2. Instala las dependencias y genera el instalador:

   ```powershell
   npm install
   npm run tauri -- build --bundles nsis
   ```

3. Al finalizar, busca el archivo `*-setup.exe` en `src-tauri\target\release\bundle\nsis\`, ábrelo y sigue el asistente. Después podrás abrir Pulso desde el menú Inicio.

Para generar un instalador de prueba más rápido, usa `npm run tauri -- build --debug --bundles nsis`; su salida está en `src-tauri\target\debug\bundle\nsis\`. Cada vez que modifiques el código debes volver a compilar y reinstalar para actualizar la aplicación instalada.

Para compilar se necesitan Node.js **22.22.2 o superior**, npm, Rust, las herramientas de compilación de Microsoft C++ y los requisitos de Tauri 2. En Windows, la aplicación necesita Microsoft Edge WebView2 Runtime. La inteligencia de TypeScript/JavaScript usa el servidor nativo de TypeScript 7 que viene con Pulso y **no necesita Node.js en el equipo donde se ejecuta**. Solo los proyectos que instalan TypeScript 5 o 6 lo usan con Node, en el modo compatible.

## Ejecutar durante el desarrollo

```powershell
npm install
npm run tauri -- dev
```

Esto inicia Vite y abre la ventana de escritorio. Para cerrar el entorno, cierra la aplicación y detén el comando con `Ctrl+C`. El servidor de desarrollo usa el puerto `1420`; si está ocupado, libera ese puerto o cambia la configuración de Vite y Tauri de forma consistente.

## Primeros pasos

1. Abre una carpeta con `Ctrl+O` y selecciona un proyecto.
2. Abre archivos desde el explorador o con `Ctrl+P`; guarda con `Ctrl+S`.
3. Abre la terminal con `Ctrl+J` y la paleta de comandos con `Ctrl+Shift+P`.
4. En un proyecto TypeScript o JavaScript, espera el aviso de activación del servidor de lenguaje. Prueba a abrir un archivo, introducir un error de tipos o usar **Ir a definición** sobre un símbolo.
5. Si el servidor no inicia, comprueba `node --version`, reinicia Pulso y utiliza el comando **Lenguaje: Reiniciar inteligencia de TypeScript y JavaScript** desde la paleta.

La configuración y los atajos se pueden consultar con `Ctrl+,`. La vista de issues usa el remoto `origin` de GitHub; los repositorios privados requieren configurar un token.

## Documentación

- [Funciones y guía de uso](docs/FUNCIONES.md): inventario, atajos, limitaciones y pruebas manuales.
- [Arquitectura e implementaciones](docs/ARQUITECTURA.md): estructura del código, almacenamiento, terminal, confiabilidad y LSP.
- [Mejoras pendientes](docs/HOJA-DE-RUTA.md): prioridades y propuestas que aún no están implementadas.
- [Plan para publicar](docs/PLAN-LANZAMIENTO.md): qué falta para entregar Pulso al público, arreglos, funciones nuevas y cómo depender menos de terceros.

## Pruebas

```powershell
npm test                 # Pruebas TypeScript
npm run test:rust        # Pruebas Rust, incluidas pruebas PTY
npm run test:windows     # Comportamiento de procesos del servidor LSP
npm run test:lsp         # Servidor real y proyecto temporal
npm run test:lsp:ui      # Ctrl+clic y hover en una ventana de prueba de Windows
npm run build            # Comprobación TypeScript y compilación web
```

El instalador y su prueba están en [docs/DISTRIBUCION.md](docs/DISTRIBUCION.md).

`npm run perf` mide arranque, apertura, escritura, búsqueda y memoria con la aplicación abierta en las mismas condiciones; los resultados y sus límites están en [docs/RENDIMIENTO.md](docs/RENDIMIENTO.md).

`npm run e2e` necesita la aplicación abierta con el puerto de depuración WebView2 configurado; los pasos están al comienzo de `scripts/e2e.mjs`.
`test:lsp:ui` requiere Windows, WebView2 y una compilación reciente en `src-tauri\target\debug\pulso-editor.exe`; abre una instancia aislada con un proyecto temporal y usa el puerto local 19337.

En GitHub, la integración continua (`.github/workflows/ci.yml`) ejecuta en Windows y Linux, en cada push a `main` y en cada pull request, las pruebas TypeScript y Rust, la comprobación de tipos y la compilación web.

## Licencia

Pulso se publica bajo la [licencia MIT](LICENSE). Los componentes de terceros que incluye y sus licencias están en [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Code signing policy

> **Estado:** los instaladores actuales **no tienen firma de código** y Windows puede mostrar una advertencia. La firma gratuita se va a solicitar a SignPath Foundation; esta política se aplicará si la aprueban.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- **Quién puede cambiar el código y quién revisa:** [santiago123-dex](https://github.com/santiago123-dex). Todo cambio de otra persona se revisa antes de unirlo.
- **Quién aprueba cada firma:** [santiago123-dex](https://github.com/santiago123-dex).
- **Qué se firma:** solo instaladores compilados desde este repositorio por su flujo de publicación en GitHub Actions.
- **Privacidad:** [PRIVACY.md](PRIVACY.md). Guía de la solicitud: [docs/FIRMA.md](docs/FIRMA.md).
