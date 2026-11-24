# Privacidad en Pulso Editor

Pulso Editor es un editor local. No incluye telemetría, analítica ni servidores propios que recopilen tu código o actividad.

## Qué se guarda en tu equipo

- **Configuración, temas, carpetas recientes y pestañas por proyecto:** se guardan en el almacenamiento local del WebView de la aplicación.
- **Historial del asistente de IA e imágenes adjuntas:** se guardan localmente en la carpeta de datos de la aplicación (`ai-chats.json` y `ai-images/`), sin cifrado adicional. Puedes eliminar conversaciones desde el historial del chat.
- **Carpetas aprobadas y de confianza:** `approved-folders.json` guarda las carpetas que aprobaste en un diálogo nativo para que el editor pueda leer y escribir en ellas; `trusted-folders.json` guarda los proyectos en los que confías (lo comparte la línea de comandos `pulso`). Solo contienen rutas.
- **Agente propio:** `agent-memory.json` guarda las notas que el agente decide recordar entre sesiones; `agent-permissions.json` guarda las reglas de permitir y denegar que defines. Los ganchos (`hooks.json`) y las instrucciones del proyecto (`.pulso/`) son archivos tuyos que Pulso solo lee. Los ganchos son comandos que se ejecutan en tu equipo; los del proyecto solo corren si confías en él. Lo mismo vale para los servidores MCP (`mcp.json`): son programas que tú configuras y que Pulso arranca en tu equipo; lo que hagan o envíen por su cuenta (a su servicio o a internet) queda fuera del control de Pulso. Cada llamada a sus herramientas pide tu aprobación, y lo que devuelven se envía al proveedor de IA que uses.
- **Claves de API de proveedores:** las que uses con el agente propio se guardan en el almacén seguro del sistema operativo, igual que el token de GitHub.
- **Token de GitHub:** se guarda en el almacén seguro de credenciales del sistema operativo (Administrador de credenciales de Windows, Keychain en macOS o Secret Service en Linux).
- **Registro de diagnóstico:** `logs/pulso.log` (rotado automáticamente a 512 KB) solo guarda eventos técnicos locales y nunca se envía automáticamente.

## Qué se envía a servicios de terceros (solo cuando tú los usas)

- **GitHub:** al conectar tu cuenta y usar Issues, Tablero Kanban, Pull Requests o Chat del equipo, Pulso se comunica directamente con `api.github.com`. Los mensajes del Chat del equipo se guardan como comentarios de una issue con la etiqueta `pulso-chat` visible para quien tenga acceso al repositorio.
- **Proveedores de IA:**
  - **Claude Code, Codex (ChatGPT) y Antigravity:** Pulso ejecuta las herramientas oficiales instaladas en tu equipo con tu propia sesión; nunca lee ni almacena tus credenciales. El texto del mensaje, el contexto que adjuntes y las imágenes que subas se envían al proveedor que elijas según su política de privacidad.
  - **Agente propio (OpenAI, Anthropic, Google, Groq y otros):** con tu propia clave, Pulso envía directamente al proveedor que elijas el mensaje, los archivos que el agente lea y el resultado de sus herramientas. No pasa por servidores de Pulso. El catálogo de proveedores y modelos se descarga de `models.dev`, sin enviar datos tuyos.
  - **Ollama (modelo local):** la conversación, lo que el agente lea y las imágenes permanecen en `127.0.0.1` en tu propio equipo. Como el agente es el mismo que con la nube, si le dejas usar herramientas que salen del equipo (leer páginas web, comandos, servidores MCP), esas sí pueden hacerlo, y siempre con tu aprobación.
- **Actualizaciones:** al comprobar actualizaciones, Pulso consulta `latest.json` en GitHub Releases.
