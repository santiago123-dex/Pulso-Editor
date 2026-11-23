# Changelog

Todos los cambios notables en Pulso Editor se documentan en este archivo.

## [Sin publicar]

### Añadido
- **Modelos en la nube de más de 300 proveedores** con el catálogo de [models.dev](https://models.dev): OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, xAI, DeepSeek y los demás que usan el protocolo compatible con OpenAI o el de Anthropic. «IA: Conectar un proveedor de modelos…» guarda la clave en el almacén seguro del sistema (la ventana nunca la recibe) o la toma de la variable de entorno del proveedor.
- Agente propio con esos modelos: lee y busca en el proyecto (`glob`, `grep`), edita con reemplazo exacto y crea archivos (como diferencias a revisar, o directamente en el modo Agente), ejecuta comandos (solo los de lectura fuera del modo Agente), lee páginas web y lleva una lista de tareas, con el coste de cada respuesta según el precio del catálogo. - **Aprobación de comandos:** en el modo Agente el agente se detiene y pregunta antes de ejecutar un comando o leer una página web (permitir una vez, siempre ese comando, todo en la conversación, o denegar). Lo de riesgo (`git push`, borrados recursivos, `sudo`…) siempre pregunta. Las reglas se guardan por proyecto fuera de él. «IA: Comandos permitidos para este proyecto…» las muestra.
- **Instrucciones, skills, subagentes y comandos propios** para ese agente, con formato propio (`.pulso/`) y lectura de `AGENTS.md`, `CLAUDE.md`, `.claude/skills`, `.claude/agents` y `.claude/commands`. La herramienta `task` delega en subagentes (varios a la vez) con su propio contexto, sin más permisos que el agente que los lanza y, si se quiere, con otro modelo. «IA: Ver instrucciones, skills y agentes del proyecto…» muestra lo cargado.

Ver [Agente propio](docs/AGENTE.md) para el diseño y las fases siguientes (aprobación de comandos, MCP y ganchos).

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
