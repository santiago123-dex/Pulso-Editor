# Changelog

Todos los cambios notables en Pulso Editor se documentan en este archivo.

## [Sin publicar]

### Añadido
- **Reglas de denegar desde la interfaz** para el agente propio: «IA: Comandos permitidos para este proyecto…» permite añadir un comando (o un prefijo con `*`) que el agente nunca podrá ejecutar.
- **El agente propio resume la conversación larga** en vez de perder el hilo: al acercarse al límite de contexto del modelo, resume lo anterior y conserva lo reciente.
- **Memoria del agente entre sesiones.** El agente propio puede guardar notas cortas del proyecto (`memory_save`) y las recibe de nuevo en la conversación siguiente. Viven fuera del proyecto, solo se usan en proyectos de confianza y «IA: Memoria del agente en este proyecto…» las muestra y las borra.

### Seguridad
- **Confianza en el proyecto para el agente propio.** Lo que viene del proyecto (`AGENTS.md`, `CLAUDE.md`, skills, subagentes y comandos) ya no llega al modelo hasta que confíes en él: sin confianza solo se cargan lo personal y los subagentes integrados. «IA: Confiar en este proyecto…» abre un diálogo nativo (lo pregunta Rust, la ventana no puede darse confianza a sí misma) y comparte la lista con la terminal `pulso`.
- **La ventana ya no decide su carpeta de trabajo.** `set_workspace_root` solo acepta carpetas que la persona aprobó: las que elige con «Abrir carpeta» (el diálogo ahora lo abre Rust), las que escribe en la terminal (`pulso carpeta`) y las que ya aprobó en sesiones anteriores (lista en la carpeta de datos de Pulso). Cualquier otra pide una confirmación nativa que la ventana no puede saltarse, y la raíz de una unidad, la carpeta personal y las carpetas del sistema se rechazan siempre.

### Añadido
- **Modelos en la nube de más de 300 proveedores** con el catálogo de [models.dev](https://models.dev): OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, xAI, DeepSeek y los demás que usan el protocolo compatible con OpenAI o el de Anthropic. «IA: Conectar un proveedor de modelos…» guarda la clave en el almacén seguro del sistema (la ventana nunca la recibe) o la toma de la variable de entorno del proveedor.
- Agente propio con esos modelos: lee y busca en el proyecto (`glob`, `grep`), edita con reemplazo exacto y crea archivos (como diferencias a revisar, o directamente en el modo Agente), ejecuta comandos (solo los de lectura fuera del modo Agente), lee páginas web y lleva una lista de tareas, con el coste de cada respuesta según el precio del catálogo. - **Aprobación de comandos:** en el modo Agente el agente se detiene y pregunta antes de ejecutar un comando o leer una página web (permitir una vez, siempre ese comando, todo en la conversación, o denegar). Lo de riesgo (`git push`, borrados recursivos, `sudo`…) siempre pregunta. Las reglas se guardan por proyecto fuera de él. «IA: Comandos permitidos para este proyecto…» las muestra.
- **Instrucciones, skills, subagentes y comandos propios** para ese agente, con formato propio (`.pulso/`) y lectura de `AGENTS.md`, `CLAUDE.md`, `.claude/skills`, `.claude/agents` y `.claude/commands`. La herramienta `task` delega en subagentes (varios a la vez) con su propio contexto, sin más permisos que el agente que los lanza y, si se quiere, con otro modelo. «IA: Ver instrucciones, skills y agentes del proyecto…» muestra lo cargado.

Ver [Agente propio](docs/AGENTE.md) para el diseño y las fases siguientes (aprobación de comandos, MCP y ganchos).
### Seguridad
- El acceso a la API de GitHub desde la ventana pasa por una lista de solicitudes permitidas (`src-tauri/src/githubpolicy.rs`): issues, etiquetas, pull requests, comentarios del chat, el usuario y el borrado de una issue. Se rechaza todo lo demás (borrar o transferir repositorios, claves, webhooks, notificaciones, otras cuentas), las rutas trucadas con `..` o `%2e`, los cuerpos que no son JSON y los de más de 256 KB. `/graphql` solo acepta la mutación de eliminar issue.
- Los comandos de Git, el agente de IA y el servidor de lenguaje solo aceptan carpetas que estén abiertas como espacio de trabajo en alguna ventana. Antes aceptaban cualquier ruta que enviara la ventana.
- La lectura de archivos de tema está limitada a los temas de VS Code instalados, al espacio de trabajo y a los archivos que la persona elige con el diálogo del sistema, que ahora abre Rust y no la ventana.

### Corregido
- La detección de la sesión de Claude Code reintenta una vez antes de rendirse y, si no puede comprobarla, lo dice («no se pudo comprobar la sesión») en lugar de pedir que se inicie sesión.

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
