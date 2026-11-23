# Privacidad en Pulso Editor

Pulso Editor es un editor local. No incluye telemetría, analítica ni servidores propios que recopilen tu código o actividad.

## Qué se guarda en tu equipo

- **Configuración, temas, carpetas recientes y pestañas por proyecto:** se guardan en el almacenamiento local del WebView de la aplicación.
- **Historial del asistente de IA e imágenes adjuntas:** se guardan localmente en la carpeta de datos de la aplicación (`ai-history.json` y `ai-images/`), sin cifrado adicional. Puedes eliminar conversaciones desde el historial del chat.
- **Token de GitHub:** se guarda en el almacén seguro de credenciales del sistema operativo (Administrador de credenciales de Windows, Keychain en macOS o Secret Service en Linux).
- **Registro de diagnóstico:** `logs/pulso.log` (rotado automáticamente a 512 KB) solo guarda eventos técnicos locales y nunca se envía automáticamente.

## Qué se envía a servicios de terceros (solo cuando tú los usas)

- **GitHub:** al conectar tu cuenta y usar Issues, Tablero Kanban, Pull Requests o Chat del equipo, Pulso se comunica directamente con `api.github.com`. Los mensajes del Chat del equipo se guardan como comentarios de una issue con la etiqueta `pulso-chat` visible para quien tenga acceso al repositorio.
- **Proveedores de IA:**
  - **Claude Code, Codex (ChatGPT) y Antigravity:** Pulso ejecuta las herramientas oficiales instaladas en tu equipo con tu propia sesión; nunca lee ni almacena tus credenciales. El texto del mensaje, el contexto que adjuntes y las imágenes que subas se envían al proveedor que elijas según su política de privacidad.
  - **Ollama (modelo local):** toda la conversación, herramientas de lectura e imágenes permanecen en `127.0.0.1` en tu propio equipo.
- **Actualizaciones:** al comprobar actualizaciones, Pulso consulta `latest.json` en GitHub Releases.
