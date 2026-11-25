# Changelog

Todos los cambios notables en Pulso Editor se documentan en este archivo.

## [Sin publicar]

## [0.2.2] - 2026-11-25

### Añadido
- **Fusionar pull requests con un botón dividido**, como en GitHub: un clic usa el método elegido y el menú permite cambiar entre merge commit, squash y rebase. La elección se recuerda por repositorio y el botón se desactiva mientras hay una fusión en curso.
- **Cambiar de proveedor sin perder la conversación.** Al elegir otra herramienta (Claude, Codex, Antigravity, Ollama o un modelo en la nube) el chat sigue siendo el mismo. La que entra recibe lo que no ha visto (texto y resumen de acciones, con límite de tamaño) y, al volver a una anterior, se reanuda su sesión. Antes se abría una conversación vacía.

### Corregido
- Los agentes propios (Ollama y nube) perdían el primer mensaje en las conversaciones largas: ahora se conserva el objetivo inicial junto a los 29 más recientes.
- **El uso de los planes se actualiza en vivo.** Con el panel de IA a la vista se consulta durante una respuesta (cada 45 segundos), al terminarla, cada 2 minutos en reposo y al volver a la ventana; los paneles de uso abiertos se repintan solos. Además, las cifras antiguas guardadas en una conversación ya no pisan las recién consultadas, y el uso de Claude se actualiza al terminar sus respuestas y aunque haya otro proveedor elegido.

## [0.2.1] - 2026-11-24

### Añadido
- **«IA: Servidores MCP…»:** una pantalla en la paleta con los servidores MCP configurados, si arrancan (o por qué no) y qué herramientas ofrece cada uno. Los del proyecto sin confianza salen como bloqueados y no se ejecutan.
- **Pasos de un subagente en vivo:** mientras un subagente trabaja, su tarjeta en el panel muestra lo último que hizo y, al desplegarla, la lista de sus pasos (archivos leídos, búsquedas, comandos…), en vez de esperar a su informe final. Solo se envía la descripción corta de cada paso, nunca contenidos de archivos.
- **MCP en el agente propio:** el agente puede usar las herramientas de servidores MCP locales (`mcp.json` en `~/.pulso/` siempre y en `.pulso/` del proyecto solo con confianza). Cada llamada pide aprobación (servidor, herramienta y argumentos), no se ofrecen en solo lectura ni con `/plan`, y los ganchos también se aplican. Ver [Agente](docs/AGENTE.md).
- **Ganchos del agente propio:** comandos que se ejecutan antes y después de cada herramienta, en `hooks.json` (`~/.pulso/` siempre; `.pulso/` del proyecto solo con confianza). Un gancho previo que termina con el código 2 bloquea la herramienta; uno posterior añade su salida al resultado. Ver [Agente](docs/AGENTE.md).
- **Git y GitHub avanzado (frente H):** fusión (`merge`), rebase (`rebase`), barra contextual para continuar o abortar operaciones en curso y asistencia de conflictos a tres bandas (`diff3` con `|||||||`, botón «Aceptar base» y comparación visual); grafo SVG de ramas y búsqueda de texto en el historial; pull requests con fusión (`merge`/`squash`/`rebase`), revisión (aprobar/pedir cambios/comentar), comentarios, comprobaciones de CI y soporte de forks; botón «Ver diferencias» también al detectar cambios externos con modificaciones sin guardar; columnas personalizadas y orden dentro de la columna en el tablero; filtros por texto/etiqueta y paginación en el listado lateral de issues; y vinculación de una issue activa a los cambios locales en Control de código.
- **`/plan <tarea>` para el agente propio:** explora el proyecto y propone un plan sin tocar nada (siempre en solo lectura, aunque el modo elegido sea Agente); después se le pide que lo ejecute.
- **Reglas de denegar desde la interfaz** para el agente propio: «IA: Comandos permitidos para este proyecto…» permite añadir un comando (o un prefijo con `*`) que el agente nunca podrá ejecutar.
- **El agente propio resume la conversación larga** en vez de perder el hilo: al acercarse al límite de contexto del modelo, resume lo anterior y conserva lo reciente.
- **Memoria del agente entre sesiones.** El agente propio puede guardar notas cortas del proyecto (`memory_save`) y las recibe de nuevo en la conversación siguiente. Viven fuera del proyecto, solo se usan en proyectos de confianza y «IA: Memoria del agente en este proyecto…» las muestra y las borra.
- **Modelos en la nube de más de 300 proveedores** con el catálogo de [models.dev](https://models.dev): OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, xAI, DeepSeek y los demás que usan el protocolo compatible con OpenAI o el de Anthropic. «IA: Conectar un proveedor de modelos…» guarda la clave en el almacén seguro del sistema (la ventana nunca la recibe) o la toma de la variable de entorno del proveedor.
- Agente propio con esos modelos: lee y busca en el proyecto (`glob`, `grep`), edita con reemplazo exacto y crea archivos (como diferencias a revisar, o directamente en el modo Agente), ejecuta comandos (solo los de lectura fuera del modo Agente), lee páginas web y lleva una lista de tareas, con el coste de cada respuesta según el precio del catálogo. - **Aprobación de comandos:** en el modo Agente el agente se detiene y pregunta antes de ejecutar un comando o leer una página web (permitir una vez, siempre ese comando, todo en la conversación, o denegar). Lo de riesgo (`git push`, borrados recursivos, `sudo`…) siempre pregunta. Las reglas se guardan por proyecto fuera de él. «IA: Comandos permitidos para este proyecto…» las muestra.
- **Instrucciones, skills, subagentes y comandos propios** para ese agente, con formato propio (`.pulso/`) y lectura de `AGENTS.md`, `CLAUDE.md`, `.claude/skills`, `.claude/agents` y `.claude/commands`. La herramienta `task` delega en subagentes (varios a la vez) con su propio contexto, sin más permisos que el agente que los lanza y, si se quiere, con otro modelo. «IA: Ver instrucciones, skills y agentes del proyecto…» muestra lo cargado.
- **Depurador integrado (DAP):** cliente del protocolo DAP en Rust (`src-tauri/src/dap.rs`, `src-tauri/src/dap_config.rs`) con soporte inicial de punta a punta para Python (`debugpy`) y adaptadores stdio personalizados, lectura de `.pulso/launch.json` y `.vscode/launch.json`, puntos de interrupción en el margen de Monaco (`F9`), barra de control (`F5`, `F10`, `Shift+F10`, `Shift+F11`, `Shift+F5`), inspector de variables expandibles, pila de llamadas, consola de evaluación y validación de seguridad con `fsguard` y `trusted-folders.json`. Ver [Depurador](docs/DEPURADOR.md).
- **Rendimiento y tamaño:** retirado `ts.worker` de Monaco (~6 MB menos en el bundle y sin compilador TS duplicado en WebView2), límite de memoria configurable para el servidor LSP (`GOMEMLIMIT` / `--max-old-space-size`, 1536 MiB por defecto con `PULSO_LSP_MAX_MB`), copias de recuperación con debounce de 8 s y desactivación de `folding`/`links` en archivos grandes, y listado rápido (`list_files`) respetando `.gitignore`. Ver [Rendimiento](docs/RENDIMIENTO.md).
- **Sistema de extensiones declarativas:** validación estricta de `manifest.json` (`src-tauri/src/extensions.rs`), carga/activación/desactivación/desinstalación desde la carpeta del usuario, diálogo de instalación con permisos explícitos (`files`, `network`, `terminal`) y vista lateral **Extensiones** (`src/extView.ts`, `src/extModel.ts`, `src/ext.css`). Ver [Extensiones](docs/EXTENSIONES.md).
- **Segunda ronda (paso 1 — Depurador, Extensiones, accesibilidad y pruebas):** soporte de Node.js/TypeScript (`js-debug`) como segundo lenguaje en el depurador, extensión declarativa de ejemplo con prueba de instalación de punta a punta (`examples/extension-ejemplo/`), mejoras de accesibilidad (roles ARIA, regiones `aria-live`, navegación por teclado en variables, foco visible, modo de alto contraste `forced-colors` y ajuste de textos largos en inglés) en Depurador y Extensiones, pruebas de vistas (`src/debugView.test.ts`, `src/extView.test.ts`) y evaluación de E2E en CI ([CI-E2E.md](docs/CI-E2E.md)).
Ver [Agente propio](docs/AGENTE.md) para el diseño y las fases siguientes (aprobación de comandos, MCP y ganchos).

### Cambiado
- **La letra de fábrica del editor es Consolas** (con Courier New de reserva), la misma que usa VS Code en Windows, en lugar de Cascadia Code. Quien nunca cambió la letra pasa a Consolas; quien eligió una en Configuración (incluida Cascadia Code) la conserva. La terminal integrada y los textos técnicos del panel de IA siguen la letra del editor.
- **Ollama usa el mismo motor que los modelos de la nube.** El modelo local ya no es solo de lectura: tiene las mismas herramientas, modos, permisos, subagentes, skills, memoria, ganchos y MCP que el agente propio. Habla el protocolo nativo de Ollama y le pide una ventana de contexto suficiente (la del modelo con un tope de 16 384; `PULSO_OLLAMA_NUM_CTX` la cambia). Si el modelo no admite herramientas, lo avisa. El motor aparte (`localai.rs`) se retiró.

### Seguridad
- **El historial del chat de IA se guarda cifrado** (AES-256-GCM). La clave vive en el almacén de credenciales del sistema, no junto al archivo; el historial antiguo en texto se cifra solo al leerlo. Si la clave desaparece, el archivo se aparta (`ai-chats.locked-….bin`) en vez de perderse. Sin almacén de credenciales se guarda en texto, como antes. Las imágenes adjuntas y las copias de recuperación siguen sin cifrar. Ver [PRIVACY.md](PRIVACY.md).
- Al abrir un proyecto que trae `AGENTS.md`, skills, subagentes o comandos y en el que todavía no se confía, la barra de estado avisa de que no se cargan y de cómo confiar («IA: Confiar en este proyecto…»).
- Dos pruebas fijan que la búsqueda y el reemplazo no atraviesan enlaces simbólicos que salen de la carpeta abierta.
- **Depurador:** la confianza en la carpeta se concede con un diálogo nativo (ya no con un comando que pudiera llamar la propia ventana) y `dap_launch` lee la configuración de los archivos del proyecto en lugar de aceptarla desde la ventana, así que una ventana comprometida no puede lanzar un programa o un adaptador cualquiera.
- **Confianza en el proyecto para el agente propio.** Lo que viene del proyecto (`AGENTS.md`, `CLAUDE.md`, skills, subagentes y comandos) ya no llega al modelo hasta que confíes en él: sin confianza solo se cargan lo personal y los subagentes integrados. «IA: Confiar en este proyecto…» abre un diálogo nativo (lo pregunta Rust, la ventana no puede darse confianza a sí misma) y comparte la lista con la terminal `pulso`.
- **La ventana ya no decide su carpeta de trabajo.** `set_workspace_root` solo acepta carpetas que la persona aprobó: las que elige con «Abrir carpeta» (el diálogo ahora lo abre Rust), las que escribe en la terminal (`pulso carpeta`) y las que ya aprobó en sesiones anteriores (lista en la carpeta de datos de Pulso). Cualquier otra pide una confirmación nativa que la ventana no puede saltarse, y la raíz de una unidad, la carpeta personal y las carpetas del sistema se rechazan siempre.
- El acceso a la API de GitHub desde la ventana pasa por una lista de solicitudes permitidas (`src-tauri/src/githubpolicy.rs`): issues, etiquetas, pull requests, comentarios del chat, el usuario y el borrado de una issue. Se rechaza todo lo demás (borrar o transferir repositorios, claves, webhooks, notificaciones, otras cuentas), las rutas trucadas con `..` o `%2e`, los cuerpos que no son JSON y los de más de 256 KB. `/graphql` solo acepta la mutación de eliminar issue.
- Los comandos de Git, el agente de IA y el servidor de lenguaje solo aceptan carpetas que estén abiertas como espacio de trabajo en alguna ventana. Antes aceptaban cualquier ruta que enviara la ventana.
- La lectura de archivos de tema está limitada a los temas de VS Code instalados, al espacio de trabajo y a los archivos que la persona elige con el diálogo del sistema, que ahora abre Rust y no la ventana.

### Corregido
- «IA: Servidores MCP…» sin una carpeta abierta solo mostraba un aviso pequeño en la barra de estado y parecía que no hacía nada. Ahora abre la lista y explica que hace falta abrir una carpeta de proyecto.
- Si el depurador termina de golpe, el mensaje ahora sugiere comprobar que `debugpy` esté instalado (`pip install debugpy`) cuando se depura Python.
- `PRIVACY.md` corrige el nombre del historial del chat (`ai-chats.json`) y documenta las carpetas aprobadas y de confianza, la memoria y los permisos del agente, los ganchos y las claves de los proveedores.
- **Fusionar y revisar pull requests y ver sus comprobaciones funciona de verdad.** El panel nuevo las pedía, pero la lista de permitidos de GitHub (`githubpolicy.rs`) las rechazaba. Ahora se permiten solo `PUT pulls/N/merge`, `POST pulls/N/reviews` y `GET commits/SHA/check-runs`, y el cuerpo de las dos primeras se acota: solo los campos que usa el panel y valores conocidos (`merge_method` ∈ merge, squash, rebase; `event` ∈ COMMENT, APPROVE, REQUEST_CHANGES).
- **El panel «Ver uso y límites» del selector de modelos ya no se abre solo ni se queda abierto.** Se abría al pasar el cursor y, al pulsar para cerrarlo, se volvía a abrir porque el botón se redibujaba bajo el cursor. Ahora solo se abre y se cierra con un clic.
- La detección de la sesión de Claude Code reintenta una vez antes de rendirse y, si no puede comprobarla, lo dice («no se pudo comprobar la sesión») en lugar de pedir que se inicie sesión.

### Calidad
- **La CI exige el formato:** el trabajo «Calidad» (antes «Calidad (aviso)») pone en rojo un PR que no pase `cargo fmt --check` o `npm run format:check`; Clippy y las auditorías de dependencias siguen solo avisando. Ver [CONTRIBUTING.md](CONTRIBUTING.md).
- Se añaden `SECURITY.md` (cómo reportar una vulnerabilidad) y `CODE_OF_CONDUCT.md`, Dependabot y un trabajo de CI «Calidad (aviso)» con `cargo fmt`, `clippy`, `cargo audit`, `npm audit` y Prettier. Las dos pruebas de Ctrl+C de la terminal se pueden saltar con `PULSO_SKIP_CTRL_C=1`.

### Interno
- **Todo el código con el formato del proyecto:** `cargo fmt` (Rust) y Prettier (TypeScript en `src/`, sin traducciones), con las reglas de `src-tauri/rustfmt.toml` y `.prettierrc.json`. Solo cambia el formato, no el comportamiento. Para trabajar: `cargo fmt --manifest-path src-tauri/Cargo.toml` y `npm run format:check` (hace falta `npm install` para tener Prettier).
- `aiChat.ts` pasa de unas 2 300 líneas a unas 870: el estado compartido del panel está en `ai/chatState.ts` y el resto repartido en doce módulos de `src/ai/` (`turnView`, `popovers`, `quota`, `attachments`, `workbench`, `denials`…). Sin cambios de comportamiento.
- `aiChat.ts`: primeros módulos aparte (`ai/icons.ts`, `ai/modelLabels.ts`, `ai/images.ts`, `ai/markdownView.ts`), los que no dependen del estado del panel. Sin cambios de comportamiento.
- `lib.rs` (1352 líneas) se divide: carpeta de trabajo, archivos, copias de recuperación, credenciales, búsqueda, temas y estado de Git pasan a su propio módulo, y `lib.rs` queda con el registro de comandos y `run()`. Sin cambios de comportamiento.
- `aichat.rs` (1750 líneas) se divide en `aichat/`: detección de herramientas, programas externos, Codex, Antigravity, argumentos, salida en streaming, imágenes y agente en la nube, con las pruebas en su propio archivo. Sin cambios de comportamiento.
- `gitops.rs` (1258 líneas) se divide en `gitops/`: cambios, ramas, remoto e historial, con las pruebas en su propio archivo. Sin cambios de comportamiento.

## [0.2.0] - 2026-11-23

### Añadido
- Asistente de IA con modelos locales mediante Ollama sin cuentas ni herramientas de terceros.
- Soporte para adjuntar imágenes al chat de IA (botón, pegado `Ctrl+V` y arrastrar/soltar) con visor ampliado (lightbox) y limpieza automática de imágenes huérfanas.
- Soporte para abrir proyectos en nuevas ventanas independientes (`Archivo → Abrir carpeta en nueva ventana…`).
- Memoria de pestañas y grupos abiertos por carpeta de proyecto.
- Aviso interactivo si hay un agente de IA respondiendo al cambiar o cerrar carpeta.
- Diagnóstico local con registro rotativo y comando `Ayuda: Copiar información de diagnóstico`.
- Inicio de sesión con GitHub mediante OAuth por código de dispositivo.
- Interfaz completa en español e inglés (incluyendo mensajes del backend en Rust y la CLI `pulso`).
- Servidor nativo de TypeScript 7 (`tsgo`) integrado sin dependencia obligatoria de Node.js.

### Corregido
- Al cambiar o cerrar proyecto se resetean por completo el chat de IA, búsqueda, Git/SCM, historial, PRs, tablero Kanban, visor de diff, historial Atrás/Adelante y pila de pestañas cerradas.
- Corregido el parpadeo/salto de la burbuja del asistente de IA durante respuestas en streaming.
- La cabecera de cada terminal integrada muestra su carpeta real (`cwd`) al cambiar de proyecto.
