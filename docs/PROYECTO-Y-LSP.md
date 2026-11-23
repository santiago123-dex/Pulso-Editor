# Pulso Editor: Documentación Integral del Proyecto e Inteligencia LSP

Este documento reúne en un solo lugar la arquitectura completa de **Pulso Editor**, el inventario de módulos (frontend y backend), las decisiones de diseño, las mejoras implementadas en esta sesión y una explicación detallada de cómo funciona la inteligencia de lenguaje (**LSP**).

---

## 1. Visión general y stack técnico

**Pulso Editor** es un editor de código de escritorio ligero construido para programadores, con enfoque en flujo de trabajo integrado (edición, terminal, Git, GitHub Issues/Kanban/Pull Requests, chat del equipo y asistente de IA).

| Capa | Tecnología | Rol |
| --- | --- | --- |
| Contenedor nativo | **Tauri 2** (`src-tauri/`) | Ventana sin marco (`decorations: false`), diálogo nativo, eventos e IPC (`invoke`). |
| Backend nativo | **Rust** (edición 2021) | Sistema de archivos, guardado atómico, búsqueda, `keyring`, Git CLI, PTY, transporte LSP y CLI de IA. |
| Frontend UI | **Vite + TypeScript + DOM directo** | Sin framework pesado de componentes; manipulación directa del DOM y modelos puros testables. |
| Editor de código | **Monaco Editor** (`0.52.0`) | Resaltado, edición multi-cursor, grupos divididos y proveedor de diferencias (`DiffEditor`). |
| Terminal integrada | **xterm.js** (`6.0.0`) + `FitAddon` + `portable-pty` | Pseudoterminal nativo (ConPTY en Windows) multi-pestaña con fuente *Symbols Nerd Font Mono* incluida. |
| Inteligencia TS/JS | **TypeScript 7** nativo (`7.0.2`, `tsc --lsp --stdio`); **typescript-language-server** (`6.1.0`) solo en el modo compatible | El nativo no necesita Node. El modo compatible (proyectos con TypeScript 5 o 6 instalado) usa Node y el `tsserver` del proyecto. |
| Pruebas | **Vitest** (`5.1.0`) + `cargo test` + scripts Node/CDP | Pruebas unitarias TS/Rust, humo LSP real, UI WebView2 (`test:lsp:ui`), E2E y `perf`. |

### Identidad visual ([DESIGN.md](../DESIGN.md))
- Superficies de grafito neutro (`#0e0e0f`, `#111111`, `#151515`, `#191919`, `#232323`), bordes finos (`#2a2a2a`) y un único acento azul (`#5b9cf5`) reservado para foco, estados activos y la acción principal.
- Tipografía nativa de sistema (`Segoe UI Variable` / `Segoe UI`) para la interfaz y monoespaciada (`Cascadia Code`, `JetBrains Mono`, `Fira Code`, etc.) para código, rutas y metadatos técnicos.

---

## 2. Mapa completo de la arquitectura

### 2.1 Backend Rust (`src-tauri/src/`)

| Archivo | Responsabilidad principal |
| --- | --- |
| `main.rs` | Punto de entrada que invoca `pulso_editor_lib::run()`. |
| `lib.rs` | Registro de comandos Tauri (`invoke_handler`), manejo de salida (`RunEvent::Exit`), lectura/escritura atómica (`write_atomic`), copias de recuperación (`backup_*`), credenciales del sistema (`secret_*` con `keyring`), recorrido de archivos (`walk` con `SKIP_DIRS`), búsqueda (`search_files`) y reemplazo (`replace_in_file`), escaneo de temas de VS Code (`scan_vscode_themes`) y estado Git básico (`git_status`, `git_remote`). En Windows oculta ventanas de consola mediante `background_command` (`creation_flags(0x08000000)`). |
| `lsp.rs` | Elige el servidor: TypeScript 7 nativo (`lsp/typescript/tsc --lsp --stdio`) o, si el proyecto instala TypeScript 5 o 6, `typescript-language-server` con `node --require lsp/no-console.cjs cli.mjs --stdio`. Enmarca/desenmarca mensajes JSON-RPC con `Content-Length` (límite de 32 MB por mensaje), elimina prefijos verbatim `\\?\` en Windows (`node_path`), emite eventos `lsp-message` y `lsp-exit` y captura hasta 16 KB de `stderr`. |
| `term.rs` | Gestiona sesiones PTY (`TermState`), detecta shells en Windows (PowerShell, CMD, Git Bash, WSL), envía salida en `base64` por eventos `term-data` (sin romper caracteres UTF-8 divididos) y cierra todas las terminales al salir. |
| `userconf.rs` | Lee configuraciones existentes de VS Code y Windows Terminal y enumera fuentes instaladas para adaptar la terminal. |
| `gitops.rs` | Operaciones completas de Git con el binario `git`: cambios staged/unstaged/conflictos (`git_changes`), `git_stage`, `git_unstage`, `git_commit`, `git_diff_sources`, ramas (`git_branches`, `git_switch`), descartar cambios (`git_discard`, enviando archivos sin seguimiento a la papelera), `git_push`, `git_pull` (`--ff-only`, timeout 120 s), historial (`git_log`, `git_commit_files`, `git_commit_sources`) y `git_blame`. |
| `githubauth.rs` | Obtiene credenciales HTTPS de `github.com` reutilizando `git credential fill` (Git Credential Manager) y abre enlaces externos seguros (`http`/`https`) mediante `open_external`. |
| `aichat.rs` | Integración con el CLI oficial de Claude Code (`claude auth status`, `claude -p --output-format stream-json --include-partial-messages`), validando tokens de sesión/modelo (`safe_token`) y limitando herramientas según modo (`read`: `Read,Glob,Grep`; `edit`: `Read,Glob,Grep,Edit,Write,MultiEdit`, sin `Bash`). *(En desarrollo activo.)* |
| `tests.rs` | Pruebas unitarias del backend (escritura atómica, conflictos, backups, PTY, búsqueda y reemplazo). |

### 2.2 Frontend TypeScript (`src/`)

| Grupo funcional | Archivos clave |
| --- | --- |
| **Arranque, ventana y comandos** | `main.ts`, `titlebar.ts`, `ui.ts`, `commands.ts`, `keybindings.ts`, `keybindingsView.ts`, `nav.ts`, `util.ts`, `external.ts` |
| **Documentos, pestañas y grupos** | `docs.ts`, `groups.ts`, `workspace.ts`, `largeFile.ts`, `diffView.ts` |
| **Explorador y búsqueda** | `explorer.ts`, `explorerNavigation.ts`, `explorer-a11y.css`, `icons.ts`, `search.ts`, `searchReplace.ts` |
| **Inteligencia LSP y problemas** | `lsp.ts`, `lspState.ts`, `lspEdits.ts`, `problems.ts`, `problemsModel.ts` |
| **Terminal y tareas** | `terminal.ts`, `terminalPrefs.ts`, `scripts.ts`, `scriptsModel.ts` |
| **Git y GitHub** | `git.ts`, `scm.ts`, `scmModel.ts`, `history.ts`, `historyModel.ts`, `blame.ts`, `github.ts`, `githubConnect.ts`, `issues.ts`, `prs.ts`, `prModel.ts`, `pulls.ts` |
| **Tablero Kanban y Chat del equipo** | `board.ts`, `boardModel.ts`, `boardLabels.ts`, `board.css`, `repoChat.ts`, `repoChatApi.ts`, `chatModel.ts`, `repoChat.css` |
| **Apariencia y ajustes** | `settings.ts`, `settingsPage.ts`, `themes.ts`, `themeGallery.ts`, `themeImport.ts`, `styles.css` |
| **Asistente de IA *(en progreso)*** | `aiChat.ts`, `aiChat.css`, `aiModel.ts`, `aiContext.ts`, `aiMarkdown.ts`, `aiStore.ts` |

---

## 3. Inteligencia de proyecto: cómo funciona el LSP en Pulso

El sistema LSP conecta **Monaco Editor** en el WebView con un proceso real ejecutado por el backend Rust. Por defecto es el servidor nativo de **TypeScript 7** (`tsc --lsp --stdio`, sin Node). En proyectos que instalan TypeScript 5 o 6 es **`typescript-language-server`** con el `tsserver` del proyecto (modo compatible). El diagrama siguiente describe el modo compatible; el nativo es un único proceso, sin Node ni `tsserver`, y sus diagnósticos se piden con `textDocument/diagnostic`.

### 3.1 Ciclo de vida y transporte

```text
[Monaco Editor / src/lsp.ts]
        │  JSON-RPC 2.0 (invoke "lsp_send" / eventos "lsp-message", "lsp-exit")
        ▼
[src-tauri/src/lsp.rs]
        │  Cabeceras "Content-Length: N\r\n\r\n" + UTF-8 JSON por stdin/stdout
        ▼
[node --require lsp/no-console.cjs cli.mjs --stdio]
        │
        ▼
[tsserver (del proyecto abierto o el incluido en recursos de Pulso)]
```

1. **Inicio por workspace (`setLspWorkspace(root)`)**:
   - Cada cambio de carpeta incrementa un contador `generation` y serializa las transiciones mediante una cadena de promesas (`transition`) para que nunca queden dos servidores activos ni respuestas tardías de la carpeta anterior.
   - El backend busca primero el servidor en `resource_dir/lsp/node_modules/...` (aplicación instalada) y, si no existe, en `../node_modules/...` (modo desarrollo). En Windows limpia los prefijos `\\?\` y `\\?\UNC\` antes de pasárselos a Node.js.
   - `scripts/lsp-no-console.cjs` evita que en Windows aparezcan ventanas de consola al lanzar procesos hijo desde Node.
2. **Negociación (`initialize` → `initialized`)**:
   - Mientras el servidor arranca (`LSP: iniciando…`), los proveedores integrados de Monaco (`typescriptDefaults` / `javascriptDefaults`) permanecen activos.
   - Una vez que responde `initialize`, `src/lsp.ts` lee las capacidades anunciadas por el servidor (`s.caps`), desactiva el lenguaje integrado de Monaco (`builtIn(false)`) para evitar duplicados/falsos errores de resolución de módulos, cambia el estado a `LSP: activo` y abre todos los modelos `file://` ya cargados (`textDocument/didOpen`).
   - Si el servidor falla o se detiene (`lsp-exit`), se limpian los marcadores de `pulso-lsp`, se reactivan los servicios integrados de Monaco (`builtIn(true)`) y la barra de estado muestra el motivo y permite reiniciar.
3. **Sincronización incremental (`textDocument/didChange`)**:
   - Cuando el servidor anuncia `textDocumentSync = 2` (incremental), cada edición envía únicamente los rangos modificados en coordenadas 0-based UTF-16. En flushes completos o cambios de EOL se envía el texto íntegro.
   - Al guardar (`onDocSaved`), Pulso envía `textDocument/didSave`. Al cerrar o disponer el modelo, envía `textDocument/didClose`.
4. **Caché de definiciones y arranque en frío (`Ctrl+clic`)**:
   - Al pulsar `Ctrl` (o `Cmd` en macOS) y pasar sobre una palabra, `probeDefinition` consulta y cachea la definición en `s.definitions` (límite de 100 entradas) para mostrar el subrayado sin duplicar peticiones cuando el usuario hace clic.
   - Si el servidor acaba de abrir el archivo (`< 12 s`), `tsserver` a veces devuelve inicialmente la propia línea `import ...` local mientras termina de indexar `tsconfig.json`. `definition()` detecta ese caso y reintenta con pausas progresivas (`[0, 200, 400, 800, 1200, 1800]` ms) hasta obtener el archivo de destino real.
5. **Renombrado seguro multi-archivo (`F2`) y ediciones del servidor**:
   - `prepareRename` verifica primero si el símbolo bajo el cursor es renombrable.
   - `renameEdits` y `applyServerWorkspaceEdit` comparten la misma tubería (`prepareWorkspaceEdits` + `writeClosedEdits`):
     - Los **archivos abiertos** se editan directamente en sus modelos de Monaco (quedan sin guardar y admiten `Ctrl+Z`).
     - Los **archivos cerrados** se leen, se transforman con `applyTextEdits` (`src/lspEdits.ts`, validando que no haya rangos invertidos ni solapados) y se escriben atómicamente con comprobación de `mtime` (`write_file`) solo después de haber calculado todos los archivos sin error.
6. **Diagnósticos y Panel de Problemas (`Ctrl+Shift+M`)**:
   - `textDocument/publishDiagnostics` filtra versiones antiguas (`params.version < model.getVersionId()`), traduce severidades a `monaco.MarkerSeverity` y publica marcadores bajo el propietario `"pulso-lsp"`.
   - `src/problems.ts` escucha `onDidChangeMarkers` y agrupa los problemas de todos los archivos abiertos.

### 3.2 Capacidades LSP añadidas y mejoras de memoria

Se amplió el cliente LSP en [src/lsp.ts](../src/lsp.ts) manteniendo total compatibilidad hacia atrás y respetando las capacidades que anuncia cada servidor (`s.caps`):

1. **Límite de memoria para `tsserver` (`maxTsServerMemory: 1536`)**:
   - Solo en el modo compatible. Se envía en `initializationOptions` durante `initialize`, acotando el heap de Node del subproceso `tsserver` (`--max-old-space-size=1536`) para evitar que crezca sin límite en proyectos grandes.
2. **Acciones de código y Quick Fixes (`Ctrl+.`)**:
   - Registrado `registerCodeActionProvider` (`textDocument/codeAction` y `codeAction/resolve`) con categorías `quickfix`, `refactor`, `source` y `source.organizeImports`.
   - Convierte los marcadores activos de Monaco dentro del rango seleccionado a diagnósticos LSP para que el servidor ofrezca arreglos contextuales (por ejemplo, añadir imports faltantes o quitar variables sin uso).
   - Puente de ejecución de comandos (`pulso.lsp.executeCommand` → `workspace/executeCommand`) y soporte completo para peticiones inversas **`workspace/applyEdit`** enviadas por el servidor al cliente (aplicando cambios tanto a modelos abiertos con `pushEditOperations` como a archivos cerrados de forma atómica).
3. **Ayuda de firma (`Signature Help`)**:
   - Registrado `registerSignatureHelpProvider` (`textDocument/signatureHelp`) disparado por `(` y `,`, mostrando las sobrecargas de la función, parámetro activo y documentación Markdown.
4. **Símbolos del documento (`Ctrl+Shift+O`)**:
   - Registrado `registerDocumentSymbolProvider` (`textDocument/documentSymbol`), soportando tanto árboles jerárquicos `DocumentSymbol[]` como listas planas `SymbolInformation[]` y traduciendo `SymbolKind` de LSP (base 1) a Monaco (base 0).
5. **Pistas en línea (`Inlay Hints`)**:
   - Registrado `registerInlayHintsProvider` (`textDocument/inlayHint`) con soporte para actualización reactiva mediante `workspace/inlayHint/refresh` y `monaco.Emitter`.
   - Activadas preferencias discretas por defecto en `initializationOptions.preferences`: nombres de parámetros solo en literales (`includeInlayParameterNameHints: "literals"`) y valores de miembros de `enum` (`includeInlayEnumMemberValueHints: true`).

---

## 4. Mejoras adicionales implementadas en el editor

Además de la actualización del cliente LSP, se implementaron las siguientes mejoras aisladas y cubiertas por pruebas unitarias:

### 4.1 Vista de diferencias al resolver conflictos de guardado ([src/docs.ts](../src/docs.ts))
- Cuando un archivo cambia externamente en disco y el usuario tiene cambios sin guardar al intentar guardar, el diálogo de conflicto (`resolveConflict`) ahora incluye la opción **"Ver diferencias"**.
- Al elegirla, carga de forma perezosa `openDiffRequest` de [src/diffView.ts](../src/diffView.ts) y abre la comparación lado a lado (o en línea) entre **Disco (externo)** y **Editor (cambios sin guardar)** sin perder el estado pendiente del documento.

### 4.2 Reemplazo en documentos abiertos sin guardar ([src/search.ts](../src/search.ts), [src/searchReplace.ts](../src/searchReplace.ts))
- Antes, la búsqueda global encontraba coincidencias en archivos abiertos sin guardar, pero el reemplazo los omitía.
- Se extrajo `computeLineReplacements` en `src/searchReplace.ts`, replicando las mismas reglas línea a línea del backend Rust (respeto de `CRLF`/`LF`, `wholeWord`, `caseSensitive`, `useRegex` y reemplazo literal sin interpretar `$1`/`$&` cuando `useRegex` está desactivado).
- Para archivos abiertos con cambios sin guardar, `search.ts` aplica las ediciones directamente sobre el modelo de Monaco mediante `pushEditOperations`, permitiendo **deshacer con `Ctrl+Z`**. Los archivos limpios o cerrados continúan usando `replace_in_file` atómico en Rust y recargando los modelos abiertos limpios.

### 4.3 Referencias clicables en el Chat del equipo ([src/chatModel.ts](../src/chatModel.ts), [src/repoChat.ts](../src/repoChat.ts), [src/repoChat.css](../src/repoChat.css))
- `splitBody` ahora detecta además de `@menciones` y enlaces `http(s)`:
  - **Referencias a issues (`#123`)**: al pulsarlas se abre la issue correspondiente en GitHub.
  - **Referencias `archivo.ext:línea` (ej. `src/lsp.ts:42`)**: rechazando secuencias `..` por seguridad y sin confundir horas (`10:30`); al pulsarlas se abre el archivo en el editor directamente en esa línea (saliendo del modo pantalla completa si el chat estaba maximizado).

### 4.4 Rediseño visual del Asistente de IA ([src/aiChat.ts](../src/aiChat.ts), [src/aiChat.css](../src/aiChat.css), [src/aiModel.ts](../src/aiModel.ts), [src/aiContext.ts](../src/aiContext.ts), [src-tauri/src/aichat.rs](../src-tauri/src/aichat.rs))
- **Diseño de flujo moderno (no genérico):** dock de comando unificado al pie (`.ai-dock`) con controles integrados, mensajes del usuario como bloques de instrucción con riel de acento izquierdo (`.ai-user`) y pasos de agente/razonamiento agrupados en una traza vertical de ejecución (`.ai-trace`).
- **Detección instantánea y recarga automática del plan:** `ai_detect` se ejecuta al iniciar la aplicación (`initAi`), y al iniciar sesión con `claude auth login` el editor detecta el regreso del foco y el cambio de estado automáticamente para cargar el plan al instante sin pasos manuales extra.
- **Selector específico de modelos y esfuerzo:** lista versiones concretas (`Claude Sonnet 5.5`, `Claude Opus 5.5`, `Claude Sonnet 5.0`, `Claude Sonnet 4.8`, `Claude Sonnet 4.6`, `Claude Haiku 4.5` o ID manual) además de los alias oficiales, selector de esfuerzo (`--effort`: *Auto*, *Bajo*, *Medio*, *Alto*, *Máx*) soportado en `aichat.rs`, y traducción de la versión exacta resuelta en vivo (`formatModelName`).
- **Uso real del plan (`% usado`):** descarta ventanas expiradas (`pruneUsage`) y limpia caché al cambiar de cuenta/sesión; muestra exactamente el **porcentaje usado** (`usedPercent`), barras de progreso lineales y la hora exacta de restablecimiento (`resetClockText`: *«Se restablece a las …»*).
- **Cierre limpio y extras:** `AiState::stop_all` en `RunEvent::Exit` ([src-tauri/src/lib.rs](../src-tauri/src/lib.rs)), botón `+` para adjuntar archivos (`extraFiles`), botón `⚡` de acciones rápidas, **Insertar**/**Copiar** en bloques de código y resumen de archivos modificados (`touchedFiles`).

### 4.5 Barra de actividad personalizable ([src/activityOrder.ts](../src/activityOrder.ts), [src/activityBar.ts](../src/activityBar.ts), [src/styles.css](../src/styles.css), [src/main.ts](../src/main.ts))
- **Arrastrar y soltar con puntero:** los iconos de `#activitybar` (excepto Configuración al pie) se reordenan arrastrando verticalmente (`>= 6 px`) con línea indicadora de inserción y cancelación con `Esc`.
- **Menú contextual y teclado:** clic derecho sobre la barra permite **Mover arriba / abajo**, **Ocultar / mostrar** cada vista (garantizando que siempre quede al menos una visible) o **Restablecer orden predeterminado**; también admite `Alt+↑` / `Alt+↓` con el foco en un botón.
- **Paleta de comandos y persistencia:** comandos **«Ver: Organizar botones de la barra lateral…»** y **«Ver: Restablecer botones de la barra lateral»**; la configuración se guarda en `localStorage` (`pulso.activityBar`).

---

## 5. Estado actual de pruebas y rendimiento

### 5.1 Suite de pruebas verificada tras estos cambios
- **TypeScript (`tsc --noEmit`)**: sin errores de tipos.
- **Compilación de producción (`vite build`)**: exitosa.
- **Pruebas unitarias (`vitest run`)**: **32 archivos de prueba, 398 pruebas pasando**, incluyendo cobertura ampliada en:
  - `src/lsp.test.ts` (2 pruebas integrales de ciclo LSP, diagnósticos, definición, `maxTsServerMemory`, signature help, code actions, command execution, `workspace/applyEdit`, document symbols e inlay hints).
  - `src/docs.test.ts` (45 pruebas, incluyendo resolución de conflicto con `"Ver diferencias"`).
  - `src/searchReplace.test.ts` (3 pruebas para reemplazo literal, palabra completa, CRLF y regex).
  - `src/chatModel.test.ts` (19 pruebas, incluyendo `#issues` y `archivo:línea`).
  - `src/activityOrder.test.ts` (4 pruebas de normalización, movimiento, visibilidad mínima y persistencia).

### 5.2 Referencia de rendimiento medida ([docs/RENDIMIENTO.md](../docs/RENDIMIENTO.md))
En la medición documentada sobre un proyecto sintético de 3.000 archivos TS en Windows 11 (compilación de producción):
- Arranque hasta explorador listo: **0,9–1,2 s**.
- Apertura de archivo de 5 MB: **0,36 s** (modo archivo grande `> 1.000.000` caracteres desactiva emparejamiento/coloración de corchetes y resaltado de coincidencias).
- Escritura en 5 MB: mediana **35 ms** (p95 ≈ **185 ms**, peor ≈ **370 ms**).
- Búsqueda con 1 resultado sobre ~9 MB / 3.000 archivos: **1,2 s**.
- Memoria total antes de limitar `tsserver`: **~3,5 GB** (WebView2 ~1,6 GB + Node LSP ~1,8 GB + Pulso ~40 MB).

---

## 6. Próximos pasos técnicos recomendados

1. **Seguridad antes de distribuir**: definir una `csp` estricta en [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) y restringir las operaciones de archivos en [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) al workspace activo.
2. **Cierre limpio del asistente de IA**: cuando finalice la integración en curso de `aichat.rs`, añadir el cierre de procesos activos de `AiState` dentro de `RunEvent::Exit` en `lib.rs`.
3. **File Watcher nativo (`notify`) + búsqueda con `ignore`**: vigilar cambios externos del sistema de archivos en tiempo real y respetar `.gitignore` en búsquedas y apertura rápida (`Ctrl+P`).
4. **Arquitectura Multi-LSP y Output Channel**: generalizar el registro de servidores en `lsp.rs` / `lsp.ts` por lenguaje (Python, Rust, HTML/CSS/JSON) y añadir un panel de salida para consultar logs de `stderr` y diagnósticos de proyecto completo.
5. **Persistencia fuera de `localStorage`**: migrar historial de chats de IA y temas importados desde `localStorage` hacia archivos JSON en `app_data_dir`.
