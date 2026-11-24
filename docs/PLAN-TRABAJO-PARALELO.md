# Plan de trabajo en paralelo

Resultado del análisis completo de `develop` del 23/11/2026 (v0.2.0 publicada). Reparte lo que falta en **frentes independientes** para que varios agentes trabajen a la vez sin pisarse. Complementa la [Hoja de ruta](HOJA-DE-RUTA.md) (pendientes por área) y el [Plan para publicar](PLAN-LANZAMIENTO.md).

## Reglas para todos los frentes

- **Una rama por frente**, creada desde `origin/develop`, en su **propia carpeta de trabajo** (`git worktree add ../Pulso-<frente> -b <rama> origin/develop`). Nunca dos agentes en la misma carpeta.
- **Nada directo a `develop` ni a `main`.** Antes de subir: traer `origin/develop` a la rama, volver a probar, y abrir el PR solo cuando se pida. Los PR no llevan la línea «Generated with Claude Code».
- Todo texto visible va **en español** y con su traducción en `src/locales/en.ts` (interfaz) o `src-tauri/src/i18n.rs` (mensajes de Rust; si se crea un archivo `.rs` nuevo con textos, añadirlo a `SOURCES` de la prueba).
- Cada frente deja pruebas, entrada en `CHANGELOG.md` y marca sus casillas aquí.
- **Zonas calientes** (las tocan casi todos; cambios mínimos, solo registrar lo nuevo): `src-tauri/src/lib.rs`, `src/main.ts`, `src/aiChat.ts`, `src-tauri/src/aichat.rs`, `src/locales/en.ts`, `src-tauri/src/i18n.rs`, `CHANGELOG.md`. Los conflictos en las tres últimas se resuelven conservando ambos lados.
- No reconstruir el instalador (`.exe`) salvo que se pida: las releases se suben cada tanto. Ejecutar `cargo clean` tras compilar.

## Quién hace qué

Dos agentes trabajan a la vez: **Claude** y **Antigravity**. Cada uno hace solo sus frentes, cada frente termina en **su propio PR**, y al final se revisan entre ellos y con la persona antes de seguir.

| Agente | Frentes | Orden | Rama |
| --- | --- | --- | --- |
| **Claude** | **A** Carpeta fijada por el backend y confianza | 1.º | `seguridad-workspace` |
| **Claude** | **B** CI y calidad (solo en modo aviso, sin formatear) | 2.º | `ci-calidad` |
| **Claude** | **F** Agente de IA, fase 4 | 3.º | `agente-fase4` |
| **Antigravity** | **D** Depurador (DAP) | 1.º | `depurador` |
| **Antigravity** | **I** Rendimiento y tamaño | 2.º | `rendimiento` |
| **Antigravity** | **E** Extensiones | 3.º | `extensiones` |
| La persona | **C** Distribución y **J** Comunidad | cuando pueda | — |
| Segunda ronda | **G**, **H** y lo que queda de A y F | ver «Segunda ronda» | por decidir |

**Por qué así:** Claude se queda con lo que toca seguridad y el agente propio (`fsguard.rs`, `agent*.rs`, `src/ai/`), que ya conoce. Antigravity se queda con lo que va en **módulos nuevos** (`dap*.rs`, `debug*.ts`, `ext*.rs`, `ext*.ts`) y con `vite.config.ts`, así que casi no se cruzan.

**Reglas de no pisarse:**
- Claude no toca `dap*`, `debug*`, `ext*` ni `vite.config.ts`. Antigravity no toca `fsguard.rs`, `agent*.rs`, `src/ai/` ni la apertura de carpetas.
- En las zonas calientes (`lib.rs`, `main.ts`, `en.ts`, `i18n.rs`, `CHANGELOG.md`) cada uno solo **añade** sus líneas, sin reordenar ni reformatear.
- Si un agente necesita algo del otro, lo deja escrito en la sección «Notas entre agentes» del final y sigue con otra tarea.
- Cada PR dice en su descripción qué se probó y qué no.

**Después de los PR (verificación cruzada):**
1. Cada agente termina un frente, deja su PR abierto y marca las casillas.
2. **Claude revisa los PR de Antigravity y Antigravity los de Claude**: traer `develop`, ejecutar pruebas y buscar fallos. Los hallazgos van como comentarios en el PR.
3. La persona decide qué se une, en este orden: A, luego el resto.
4. Tras cada unión, el otro agente trae `develop` a su rama y vuelve a probar.
5. Con la primera ronda unida, se reparte la segunda (H y G) y se hace al final el PR de formato.

## Segunda ronda

La primera ronda (A, B, D, E, F parte 1, I y la corrección de seguridad del depurador) está unida a `develop`. Esta ronda reparte lo que queda. **La firma del instalador queda aplazada** por decisión de la persona: no se trabaja hasta que ella lo pida.

### El problema de esta ronda: `G` choca con todo

Dividir `aiChat.ts`, `aichat.rs`, `gitops.rs` y `lib.rs` mueve código que también tocan H y F. Por eso **va primero y corto**, y mientras tanto el otro agente trabaja en cosas que no estén en esos archivos.

| Paso | Quién | Qué | Mientras tanto |
| --- | --- | --- | --- |
| **1** | **Claude** | **G:** dividir los archivos grandes, sin cambiar comportamiento. Un PR por archivo (`gitops.rs`, `aichat.rs`, `lib.rs`, `aiChat.ts`), empezando por el que menos toque el otro agente | Antigravity solo hace el paso 1 (abajo) |
| **1** | **Antigravity** | Calidad y comprobaciones que no tocan esos archivos (ver «Antigravity, paso 1») | — |
| **2** | **Antigravity** | **H:** Git y GitHub avanzado, sobre los módulos ya divididos | Claude hace el paso 2 (abajo) |
| **2** | **Claude** | **F, parte 2:** MCP, ganchos, ver en vivo los pasos de un subagente, Ollama al motor común, cifrar el historial, y el resto de A | — |
| **3** | **Claude** | Un solo **PR de formato** (`cargo fmt` y Prettier) con todas las demás ramas cerradas | Nadie más abre PR |
| **Siempre** | La persona | **C** (sin la firma) y **J** | — |

Cada PR de G dice en su descripción qué archivos movió; Antigravity no empieza H hasta que el PR de `gitops.rs` esté unido.

### Antigravity, paso 1 (sin tocar `gitops.rs`, `aichat.rs`, `lib.rs` ni `aiChat.ts`)

- [ ] **Pruebas para los módulos de la interfaz sin prueba propia** (frente B): empezar por `debugView.ts`, `extView.ts` y las vistas que más cambian.
- [ ] **Comprobaciones e2e en la CI** (frente B): evaluar un ejecutor de Windows con WebView2, o dejar escrito por qué no.
- [ ] **Accesibilidad** (frente J): lector de pantalla y alto contraste en el depurador y en las extensiones; textos largos en inglés que no quepan.
- [ ] **Extensiones:** probar la instalación de punta a punta con una extensión de ejemplo y documentar cómo crear una.
- [ ] **Depurador:** un segundo lenguaje (Node/TypeScript) además de Python.

### Claude, paso 2 (después de G)

- [x] Resto de A: aviso al abrir un proyecto con `AGENTS.md` o skills sin confianza, y revisión de enlaces simbólicos en `search_files` y `replace_in_file`.
- [x] Resto de F: MCP, ganchos, ver en vivo los pasos de un subagente, Ollama al motor común y cifrar el historial. (Falta probar el agente con proveedores reales.)
- [ ] Probar el agente con proveedores reales cuando la persona pueda dar una clave.

### Antes de cada paso

1. Traer `origin/develop` a la rama y volver a probar.
2. Revisión cruzada: cada agente lee los PR del otro con atención a seguridad y deja los hallazgos como comentario.
3. **Nada de lo nuevo se ha visto en pantalla.** Antes de dar por buena la ronda, la persona (o un agente con la aplicación compilada) hace una pasada: diálogos nativos de abrir carpeta y de confianza, memoria y `/plan`, depurador, extensiones y el selector de modelos.

## Mapa de frentes

| # | Frente | Rama sugerida | Toca (zona propia) | Choca con | Tamaño |
| --- | --- | --- | --- | --- | --- |
| A | Carpeta fijada por el backend y confianza | `seguridad-workspace` | `fsguard.rs`, apertura de carpeta | G | Pequeño |
| B | CI y calidad de ingeniería | `ci-calidad` | `.github/`, configuración de linters | todos (si se formatea) | Pequeño |
| C | Confianza y distribución | `distribucion-firma` | `release.yml`, `tauri.conf.json`, docs | — | Mediano, manual |
| D | Depurador (DAP) | `depurador` | módulos nuevos `dap*.rs`, `debug*.ts` | — | Grande |
| E | Extensiones | `extensiones` | módulos nuevos `ext*.rs`, `ext*.ts` | — | Grande |
| F | Agente, fase 4 | `agente-fase4` | `agent*.rs`, `src/ai/` | G | Mediano |
| H | Git y GitHub avanzado | `git-avanzado` | `gitops.rs`, `prs`, `src/git*.ts` | G | Mediano |
| I | Rendimiento y tamaño | `rendimiento` | `vite.config.ts`, carga de Monaco | — | Pequeño |
| J | Comunidad y producto | `comunidad` | `README.md`, docs, repo aparte | — | Pequeño, sin código |
| G | Dividir archivos grandes | `refactor-archivos` | `aiChat.ts`, `aichat.rs`, `lib.rs`, `gitops.rs` | **todos** | Mediano |

**Orden recomendado:**
1. **Ahora, en paralelo:** A, B (sin formatear), C, D, E, I, J. No comparten archivos.
2. **Después de unir A, F y H:** G. Es el que más conflictos causa, así que va con las demás ramas cerradas.
3. **Al final, con ninguna rama abierta:** `cargo fmt` y Prettier a todo el proyecto, en un PR solo de formato.

---

## A. Carpeta fijada por el backend y confianza (prioridad máxima)

**Por qué:** hoy la ventana declara su carpeta con `set_workspace_root`. Una ventana comprometida podría declarar `C:\` y saltarse todo `fsguard`. Es el hueco de seguridad más importante.

- [x] Que **solo el backend fije la carpeta**: al elegirla con el diálogo (que abra Rust, no la ventana), al abrirla desde la CLI, al elegir una reciente y al restaurar la sesión guardada. Quitar `set_workspace_root` como comando libre, o hacer que solo acepte una ruta que el backend ya aprobó.
- [x] **Confianza en el proyecto** (misma lista que la CLI, `trusted-folders.json`): sin confianza no se cargan `AGENTS.md`, skills, subagentes ni comandos del proyecto; se pide con «IA: Confiar en este proyecto…». El modo Agente sigue disponible porque ya pregunta antes de cada comando. Al abrir un proyecto con esos archivos y sin confianza, la barra de estado avisa y nombra el comando.
- [x] Rechazar carpetas demasiado amplias (raíz de disco, carpeta personal) como espacio de trabajo, igual que ya hace `broad_dir_reason` en la CLI.
- [x] Revisar `search_files` y `replace_in_file` con enlaces simbólicos: la búsqueda no sigue enlaces (el recorrido no los sigue y solo lee archivos regulares) y `replace_in_file` pasa por el guardián, que resuelve el enlace y rechaza lo que sale de la carpeta. Quedan dos pruebas que lo fijan (se saltan sin permiso para crear enlaces, como en Windows sin modo desarrollador; corren en Linux).
- [x] Pruebas: una ventana que pida `C:\` o una ruta no aprobada es rechazada.

**Hecho cuando:** ningún comando acepta una carpeta que el backend no haya fijado y hay una prueba de Rust que lo demuestra.

## B. CI y calidad de ingeniería

- [x] Añadir a la CI, en un trabajo aparte «Calidad (aviso)» que no bloquea: `cargo fmt --check`, `cargo clippy`, `cargo audit`, `npm audit` y Prettier. **Falta ESLint:** `typescript-eslint` no admite todavía TypeScript 7 (`peer typescript <6`), así que no se puede instalar sin forzar las dependencias.
- [x] Decidir el formato y escribir `src-tauri/rustfmt.toml` (ancho 160, el que menos cambia: 385 diferencias en vez de 853) y `.prettierrc.json`. **No formatear todo el proyecto en este frente**: se hace al final (ver «Orden recomendado»), porque 853 diferencias de `rustfmt` chocarían con todas las ramas.
- [x] Las dos pruebas de Ctrl+C de `term.rs` se saltan con `PULSO_SKIP_CTRL_C=1` en entornos sin consola real (documentado en `CONTRIBUTING.md`); en la CI siguen corriendo.
- [ ] Ejecutar las 68 comprobaciones e2e en la CI (necesitan WebView2; evaluar un ejecutor de Windows) o dejar documentado por qué no.
- [ ] Pruebas para los 29 módulos de la interfaz sin prueba propia (sobre todo vistas), empezando por `main.ts` y los de seguridad.
- [x] `SECURITY.md` (cómo reportar una vulnerabilidad) y `CODE_OF_CONDUCT.md`.
- [x] Dependabot para npm, Cargo y GitHub Actions.

## C. Confianza y distribución

Casi todo es manual o de configuración; es lo que más frena a quien descargue Pulso.

- [ ] **(Aplazado a petición de la persona)** **Firmar el instalador** (SignPath gratis para código abierto, o Azure Trusted Signing) y evitar el aviso de SmartScreen.
- [ ] **Probar en un Windows limpio** (máquina virtual sin Node, Git ni WebView2): instalar, abrir, usar el comando `pulso`, desinstalar.
- [ ] **Probar una actualización real** entre dos versiones y guardar los secretos pendientes (`RELEASES_TOKEN`, clave de firma).
- [ ] **Linux:** probar `.rpm`, `.deb` y AppImage en una máquina real con pantalla (el `.rpm` solo se probó en un contenedor), y regenerar el `.rpm` de Fedora con lo nuevo.
- [ ] **macOS:** decidir si se da soporte y, si sí, añadir la compilación a `release.yml`.
- [ ] **Chat del equipo:** comprobar con dos cuentas reales si GitHub envía un correo por cada mensaje. Si es así, avisarlo en la interfaz o cambiar de transporte.
- [ ] Probar el tablero y las pull requests contra GitHub real (hoy solo contra uno simulado) y push/pull con autenticación.

## D. Depurador (DAP)

Es la mayor carencia frente a otros editores. Va en módulos nuevos para no chocar con nadie.

- [x] Cliente del protocolo DAP en Rust (`src-tauri/src/dap*.rs`): lanzar el adaptador, enviar y recibir mensajes, ciclo de vida.
- [x] Interfaz: puntos de interrupción en el margen del editor, panel de variables, pila de llamadas, consola de depuración y barra de control (continuar, paso, parar).
- [x] Un primer lenguaje de punta a punta (Node/TypeScript o Python con `debugpy`), antes de ampliar.
- [x] Configuración de lanzamiento por proyecto (`.pulso/launch.json`, con lectura de `.vscode/launch.json` como ayuda).
- [x] Respetar `fsguard` y el aviso de confianza de A: depurar ejecuta código.
- [x] Documentar en `docs/DEPURADOR.md`.

## E. Extensiones

Una API propia y acotada antes de prometer compatibilidad con VS Code.

- [x] **Diseño primero** (`docs/EXTENSIONES.md`): declarativas, con `manifest.json`, sin ejecutar código de terceros en la primera versión. Qué pueden aportar: temas, fragmentos, comandos que lanzan scripts con aprobación, servidores de lenguaje.
- [x] Carga, activación y desactivación desde una carpeta de extensiones del usuario; validación estricta del manifiesto.
- [x] Permisos explícitos por extensión (archivos, red, terminal) y pantalla de instalación que los muestre.
- [x] Vista «Extensiones» en la interfaz.
- [x] Decidir si más adelante se permiten plugins WASM aislados.

## F. Agente propio, fase 4

Lo ya hecho (proveedores de models.dev, herramientas, subagentes, skills, comandos y aprobación de comandos) está en [Agente](AGENTE.md).

- [ ] **Probar con proveedores reales** (OpenAI, Anthropic, OpenRouter, DeepSeek…) y corregir las rarezas; hasta ahora solo hay servidores simulados.
- [ ] **Aprobar las ediciones directas** del modo Agente (hoy se aplican sin preguntar; se deshacen con Git).
- [x] **Escribir reglas de denegar desde la interfaz.**
- [x] **Resumir la conversación** al llegar al límite de contexto, en vez de solo podar resultados.
- [x] **MCP:** cliente de servidores MCP locales (`agentmcp.rs`, ver [Agente](AGENTE.md)), con aprobación de cada llamada por el mismo camino que los comandos. Faltan los servidores remotos (HTTP) y OAuth.
- [x] **Ganchos (hooks)** antes y después de cada herramienta (`agenthooks.rs`, ver [Agente](AGENTE.md)).
- [x] **Memoria entre sesiones**, por proyecto, guardada fuera del proyecto (`agentmem.rs`).
- [x] **Modo plan:** `/plan <tarea>`, siempre en solo lectura; el agente propone el plan y tú decides cuándo ejecutarlo.
- [x] Ver en vivo los pasos de un subagente (evento `pulso_subagent_step`, ver [Agente](AGENTE.md)).
- [x] **Pasar Ollama al motor común** (`agent.rs`, con el protocolo nativo `/api/chat` para fijar la ventana de contexto) y retirar el motor aparte de `localai.rs` (ahora `ollama.rs` y `readtools.rs`).
- [x] Cifrar el historial del chat (`ai-chats.json`): AES-256-GCM con la clave en el almacén del sistema (`chatcrypt.rs`). Quedan sin cifrar las imágenes adjuntas y las copias de recuperación.

## H. Git y GitHub avanzado

- [x] Borrar y renombrar ramas; merge y rebase; asistencia de conflictos a tres bandas.
- [x] Pull requests: fusionar, revisar, comentar, ver el resultado de las comprobaciones y forks.
- [x] Grafo de ramas y búsqueda en el historial.
- [x] Mostrar las diferencias al resolver un conflicto de guardado.
- [x] Tablero: columnas personalizadas o GitHub Projects, orden dentro de la columna, paginación y filtros del listado de issues.
- [x] Relacionar una issue con los cambios locales.

## I. Rendimiento y tamaño

- [x] Quitar o cargar a demanda el servicio de TypeScript propio de Monaco (`ts.worker`, 6 MB) ahora que hay LSP.
- [x] Revisar Monaco (3,9 MB) y la fuente de símbolos (2,6 MB): subconjunto de glifos o carga diferida.
- [x] **Medir en compilación de producción** y con proyectos reales (hasta ahora es una compilación de depuración y un proyecto sintético), incluida la memoria con el TypeScript nativo.
- [x] Búsqueda que respete `.gitignore` y evite recorrer el disco entero cada vez.
- [x] Perfilar los picos al escribir en archivos muy grandes y acotar la memoria del servidor de lenguaje.

## J. Comunidad y producto (sin código)

- [ ] Capturas o un GIF corto en el `README.md` y enlace de descarga a la última release.
- [ ] Landing en un repositorio aparte (`pulso-landing`).
- [ ] Publicar el mensaje en las comunidades de Discord y abrir el servidor propio.
- [ ] Tras A, actualizar `PRIVACY.md` si cambia qué se guarda o se envía.
- [ ] Probar la interfaz con lector de pantalla y alto contraste, y en inglés (textos largos que no quepan).

## G. Dividir archivos grandes (al final)

Dividir por responsabilidad facilita revisar y evita que las ramas choquen. **Hacerlo cuando A, F y H estén unidas** y no haya otras ramas abiertas sobre estos archivos.

| Archivo | Líneas | Propuesta |
| --- | --- | --- |
| `src/aiChat.ts` | 2605 | **En curso:** ya salieron `ai/icons.ts`, `ai/modelLabels.ts`, `ai/images.ts` y `ai/markdownView.ts` (150 líneas, sin estado compartido). Lo que queda depende del estado del módulo (`activeProvider`, `model`, `tools`, `current`…): para dividirlo hace falta un módulo de estado compartido y una pasada con la aplicación compilada |
| `src-tauri/src/aichat.rs` | 1750 | **Hecho:** `aichat/` con `mod.rs` (estado y comandos de Tauri), `detect.rs`, `cli.rs`, `codex.rs`, `antigravity.rs`, `args.rs`, `stream.rs`, `images.rs`, `cloud.rs` y `tests.rs` |
| `src-tauri/src/bin/pulso.rs` | 1295 | enrutado, trabajo de ventana, terminal |
| `src-tauri/src/gitops.rs` | 1222 | **Hecho:** `gitops/` con `mod.rs` (ayudantes y comandos de Tauri), `changes.rs`, `branches.rs`, `remote.rs`, `history.rs` y `tests.rs` |
| `src-tauri/src/lib.rs` | 1352 | **Hecho:** `lib.rs` queda en unas 280 líneas (módulos, `run()` y el registro de comandos); el resto está en `workspace.rs`, `files.rs`, `recovery.rs`, `secrets.rs`, `search.rs`, `themes.rs` y `gitinfo.rs` |

- [ ] Sin cambiar comportamiento: las pruebas existentes deben pasar sin tocarlas.
- [ ] Después, **un PR solo de formato** con `cargo fmt` y Prettier.

---

## Mensaje de arranque para cada agente

> Lee `docs/PLAN-TRABAJO-PARALELO.md`. Eres **<Claude | Antigravity>**: haz solo los frentes que la sección «Quién hace qué» te asigna, en el orden indicado. Trabaja en una rama y una carpeta de trabajo propias creadas desde `origin/develop`, no toques archivos de otro agente salvo añadir líneas en las zonas calientes, trae `origin/develop` y vuelve a probar antes de subir, y deja un PR por frente. Marca las casillas hechas y anota lo que necesites del otro en «Notas entre agentes».

## Notas entre agentes

- **2026-11-23 (Antigravity → Claude):** Frente D (`depurador`) lee y escribe `trusted-folders.json` en `src-tauri/src/dap_config.rs` reutilizando `termui::{trusted_list, is_trusted, add_trusted, broad_dir_reason}` para no tocar `fsguard.rs` ni chocar con el Frente A (`seguridad-workspace`). Cuando A se una a `develop`, `dap_config.rs` puede conectarse directamente al estado de confianza centralizado del backend si A expone un helper común.
