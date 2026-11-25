# Privacidad en Pulso Editor

Pulso Editor es un editor local. No incluye telemetría, analítica ni servidores propios que recopilen tu código o actividad.

## Qué se guarda en tu equipo

- **Configuración, temas, carpetas recientes y pestañas por proyecto:** se guardan en el almacenamiento local del WebView de la aplicación.
- **Historial del asistente de IA:** se guarda localmente en la carpeta de datos de la aplicación (`ai-chats.json`), **cifrado con AES-256-GCM**. La clave se genera al guardar por primera vez y vive en el almacén seguro del sistema operativo, nunca junto al archivo: copiar el archivo (una copia de seguridad, una carpeta sincronizada) no basta para leerlo. No protege de otro programa que corra con tu mismo usuario, que puede pedirle la clave al almacén igual que Pulso. Si el sistema no tiene almacén de credenciales (Linux sin Secret Service, por ejemplo), se guarda en texto antes que perder las conversaciones. Si la clave desaparece (por ejemplo, borras las credenciales), el archivo no se puede abrir: Pulso lo aparta como `ai-chats.locked-….bin` (conserva los últimos 3) y empieza un historial nuevo. Puedes eliminar conversaciones desde el historial del chat.
- **Imágenes adjuntas al asistente:** se guardan en `ai-images/`, **sin cifrar**. Las copias de recuperación de archivos sin guardar (`recovery/`) tampoco van cifradas.
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
  - **Ollama (modelo local):** mientras la conversación siga con Ollama, lo que se habla, lo que el agente lea y las imágenes permanecen en `127.0.0.1` en tu propio equipo (ver abajo qué pasa al cambiar de proveedor). Como el agente es el mismo que con la nube, si le dejas usar herramientas que salen del equipo (leer páginas web, comandos, servidores MCP), esas sí pueden hacerlo, y siempre con tu aprobación.
  - **Al cambiar de proveedor dentro de una conversación:** el siguiente mensaje entrega al nuevo proveedor el texto de lo hablado antes y un resumen de las acciones realizadas, **también si venía de un modelo local de Ollama**, y **sin pedir confirmación**. Si una conversación no debe salir de tu equipo, no cambies de proveedor dentro de ella: abre una nueva.
- **Actualizaciones:** unos segundos después de abrirse, y cuando lo pides, Pulso consulta `latest.json` en GitHub Releases. No instala nada sin que lo aceptes. Hoy no hay un ajuste para desactivar la consulta del arranque.

## Qué se consulta automáticamente

Pulso ejecuta las herramientas oficiales instaladas (Claude Code, Codex y Antigravity) para saber si hay una sesión iniciada y cuánto queda de tu plan. El uso del plan se consulta al detectar las cuentas, al terminar cada respuesta y, con el panel de IA a la vista, cada 45 segundos durante una respuesta, cada 2 minutos en reposo y al volver a la ventana. Para responder, cada herramienta puede comunicarse con su proveedor usando tu sesión.

## Políticas de terceros

[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement), [OpenAI](https://openai.com/policies/privacy-policy/), [Anthropic](https://www.anthropic.com/legal/privacy) y [Google](https://policies.google.com/privacy). Con otros proveedores se aplica la política de cada uno.
