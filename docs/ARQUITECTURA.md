# Arquitectura e implementaciones

Documento técnico del estado actual de Pulso. Para instalar o ejecutar la aplicación, consulta el [README](../README.md); para las funciones disponibles, consulta [Funciones](FUNCIONES.md).

## Estructura general

Pulso es una aplicación Tauri 2. La interfaz es una aplicación Vite con TypeScript y DOM, sin un framework de componentes; utiliza Monaco para la edición y xterm.js para la terminal. El backend Rust expone comandos Tauri para acceder al sistema de archivos, Git, credenciales, procesos PTY y el transporte del servidor de lenguaje. La comunicación de la interfaz con Rust usa `invoke`; la salida de procesos asíncronos llega mediante eventos Tauri.

| Ubicación | Responsabilidad |
| --- | --- |
| `index.html`, `src/styles.css` | Estructura de la ventana y estilos. |
| `src/main.ts`, `src/titlebar.ts`, `src/ui.ts` | Arranque, comandos, ventana, diálogos y menús. |
| `src/docs.ts`, `src/groups.ts`, `src/workspace.ts` | Documentos, modelos Monaco compartidos, pestañas, grupos y persistencia de sesión. |
| `src/explorer.ts`, `src/search.ts`, `src/nav.ts` | Explorador, búsqueda/reemplazo y navegación. |
| `src/settings.ts`, `src/settingsPage.ts`, `src/keybindings.ts`, `src/keybindingsView.ts` | Ajustes, vista y asignación de atajos. |
| `src/themes.ts`, `src/themeImport.ts`, `src/themeGallery.ts`, `src/icons.ts` | Temas, importación y recursos visuales. |
| `src/git.ts`, `src/github.ts`, `src/issues.ts` | Estado Git, token y consulta de issues. |
| `src/terminal.ts`, `src/terminalPrefs.ts`, `src-tauri/src/term.rs`, `src-tauri/src/userconf.rs` | Interfaz de terminal, preferencias, PTY y detección de configuración del usuario. |
| `src/lsp.ts`, `src-tauri/src/lsp.rs` | Cliente Monaco/LSP y transporte de mensajes al servidor local. |
| `src-tauri/src/lib.rs` | Comandos nativos de archivos, búsqueda, recuperación, credenciales y Git; registro de servicios. |
| `src/*.test.ts`, `src-tauri/src/tests.rs`, `scripts/lsp-smoke.mjs`, `scripts/e2e.mjs` | Pruebas unitarias, del backend, del servidor LSP real y de la aplicación. |

## Documentos, guardado y recuperación

Cada archivo abierto tiene un modelo Monaco identificado por URI. `docs.ts` registra la versión guardada y la fecha de modificación, controla el autoguardado y comparte el modelo entre grupos. `groups.ts` gestiona su disposición y cierre. El backend escribe en un archivo temporal del mismo directorio, sincroniza su contenido y trata de reemplazar el destino; se conserva el enlace simbólico resolviendo su destino. La comprobación de conflictos compara la fecha en milisegundos, por lo que no es una operación condicional atómica frente a otros procesos.

Las copias se guardan como JSON en el subdirectorio `recovery` del directorio de datos de la aplicación. Contienen ruta, texto, fecha base y momento de copia. El cliente limita la frecuencia de copias durante la escritura y serializa sus operaciones por ruta para evitar que una escritura anterior reaparezca después de una eliminación. El cierre intencional ofrece guardar o descartar; ante un cierre inesperado se ofrece recuperación al iniciar. Las copias no están cifradas y no representan un historial de versiones.

Los ajustes, carpetas recientes y disposición se almacenan en `localStorage` del WebView. El token de GitHub usa el almacén de credenciales del sistema mediante `keyring`; existe migración desde la clave antigua de `localStorage`. Si la migración falla, el dato antiguo se conserva para no perderlo.

## Terminal

`terminal.ts` crea las vistas xterm.js y adapta tamaños con `FitAddon`. `term.rs` crea un PTY con `portable-pty`, inicia la shell, envía los bytes de salida codificados en base64 mediante eventos y recibe entrada y cambios de tamaño mediante comandos Tauri. La salida se conserva como bytes para no romper caracteres UTF-8 divididos entre fragmentos. Las sesiones se cierran al recargar o salir. `userconf.rs` y `terminalPrefs.ts` detectan configuraciones existentes para ofrecer una adaptación opcional.

## LSP de TypeScript y JavaScript

`lsp.rs` inicia el servidor sobre stdio y transporta JSON-RPC con cabeceras `Content-Length`, identificando cada sesión. El cliente `lsp.ts` inicializa el servidor por carpeta, sincroniza los modelos abiertos mediante `didOpen`, `didChange`, `didSave` y `didClose`, y adapta diagnósticos, hover, completado, definiciones y referencias a Monaco. Las peticiones incluyen límites de espera y soporte de cancelación; las operaciones de envío se ordenan. Cambiar de carpeta cierra la sesión anterior. Si falla, se reactivan los proveedores integrados de Monaco.

Cuando el servidor anuncia sincronización incremental, se envían los rangos y textos modificados en lugar del documento completo en cada tecla. Ante un reemplazo completo del modelo o un servidor que no la admita se envía el texto completo. **Dos servidores posibles:**
- **Nativo (por defecto):** `tsc --lsp --stdio` de TypeScript 7, un ejecutable sin Node. El instalador lo incluye en `lsp/typescript/` junto a sus `lib.*.d.ts` (`tauri.windows.conf.json` y `tauri.linux.conf.json` añaden el de cada plataforma). En desarrollo se usa el de `node_modules/@typescript/typescript-<plataforma>`. No envía los diagnósticos: los anuncia con `diagnosticProvider` y el cliente los pide con `textDocument/diagnostic` 300 ms después del último cambio. Si el servidor declara dependencias entre archivos, los pide para todos los documentos abiertos. También atiende `workspace/diagnostic/refresh`. Lee su configuración con `workspace/configuration` (secciones `js/ts`, `typescript` y `javascript`, formato de VS Code); `src/lspConfig.ts` activa ahí los inlay hints.
- **Compatible:** si el proyecto tiene TypeScript 5 o 6 en `node_modules` (buscado hacia arriba desde la carpeta abierta), `node --require lsp/no-console.cjs cli.mjs --stdio` con `typescript-language-server`, al que el cliente pasa la ruta del `tsserver.js` del proyecto. Así se respetan las opciones de `tsconfig` que TypeScript 7 retiró. El script de preparación evita ventanas de consola en Windows, y se retira el prefijo verbatim de las rutas antes de pasarlas a Node. Sin Node, `lsp_start` arranca el nativo y devuelve un aviso.

`lsp_start` devuelve el modo elegido. Las rutas del mismo archivo se comparan sin distinguir mayúsculas. En esta fase hay un servidor para una carpeta de trabajo; no hay gestor de múltiples servidores o lenguajes ni interfaz de instalación de servidores.

## Búsqueda y Git

El backend recorre el árbol y aplica un conjunto fijo de carpetas excluidas. La búsqueda usa `regex`, devuelve posiciones UTF-16 compatibles con Monaco y limita los resultados. El reemplazo se hace por archivo y la interfaz confirma la operación; es una ruta independiente de `write_file` y actualmente usa escritura directa.

Git se consulta mediante el comando del sistema `git` y se interpreta `status --porcelain`; las decoraciones se calculan en `src/git.ts`. `github.ts` consulta la API de issues del remoto `origin`; no hay cliente de gestión completa de Git o pull requests.

Las consultas Git y del registro de Windows se ejecutan sin ventanas de consola. La lectura de directorios y archivos, las búsquedas, el guardado y las copias se ejecutan en trabajo en segundo plano. El explorador no espera a Git para mostrar los archivos, agrupa consultas Git simultáneas y descarta resultados obsoletos. Al guardar solo actualiza las marcas Git después de una breve pausa, sin reconstruir todo el árbol. Las solicitudes de apertura también se invalidan al cambiar de archivo o carpeta, para que una lectura tardía no sustituya la selección más reciente.

## Idiomas de la interfaz

Los textos se escriben en español dentro de `t("…")` (`src/i18n.ts`). El texto en español es la clave, y la traducción inglesa está en `src/locales/en.ts`. Lo que no se ha marcado o no tiene traducción se muestra en español, así que se puede traducir por partes.
- **Valores variables:** van como `{nombre}`: `t("Conectado como {login}", { login })`.
- **Cuándo se decide el idioma:** al cargar `i18n.ts`, a partir del ajuste `language` y del idioma del sistema, antes de que se construyan menús y comandos. Por eso cambiarlo recarga la ventana.
- **HTML estático:** `translateStatic` traduce los textos y los atributos `title`, `placeholder` y `aria-label` de `index.html` al arrancar.
- **Pruebas:** `src/i18n.test.ts`, con `scripts/i18n-keys.mjs`, comprueba que cada `t("…")` del código y cada texto fijo del HTML tengan traducción con los mismos `{valores}`, y que no sobren entradas.
- **Para traducir una pantalla nueva:** envolver sus textos en `t()`, ejecutar `node scripts/i18n-keys.mjs --missing` y añadir lo que liste a `en.ts`.

## Compilación y pruebas

`npm run build` ejecuta TypeScript y Vite. `npm run tauri -- build` construye la aplicación nativa y sus paquetes; los recursos LSP se declaran en `src-tauri/tauri.conf.json`. `npm test` ejecuta Vitest; `npm run test:rust` usa Cargo; `npm run test:lsp` inicia el servidor real sobre un proyecto temporal. `npm run test:lsp:ui` inicia una instancia Windows aislada y prueba hover, diagnósticos, Ctrl+clic y reapertura de la definición. `scripts/e2e.mjs` prueba la aplicación abierta mediante el puerto de depuración de WebView2 y tiene requisitos descritos en su encabezado.

Las pruebas automatizadas no reemplazan la comprobación en una instalación Windows real, especialmente al cambiar empaquetado, WebView2, terminal o la búsqueda del ejecutable Node.
