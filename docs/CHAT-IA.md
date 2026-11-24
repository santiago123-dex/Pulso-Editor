# Asistente de IA

Chat con una IA dentro de Pulso, usando **Claude Code** (la herramienta oficial de Anthropic) con **tu propia sesión**: si tienes una suscripción de Claude (Pro, Max), la conversación gasta de ese plan. Pulso no pide ni guarda ninguna clave: lanza la herramienta en la carpeta de tu proyecto, le pasa tu mensaje y pinta lo que va respondiendo.

Se abre con el icono del asistente de la barra de actividad (o «Ver: Asistente de IA» en la paleta). El botón de la esquina lo pasa a pantalla completa; `Esc` o el mismo botón lo devuelven a la barra lateral.

## Requisitos

- Claude Code instalado y con la sesión iniciada. Si falta, el panel lo dice. Si está instalado pero sin sesión, el botón «Iniciar sesión en la terminal» ejecuta `claude auth login` en la terminal de Pulso.
- Una carpeta de proyecto abierta: la IA trabaja dentro de ella.

## Qué se puede hacer

- **Conversar** con respuesta en vivo: texto con código (con botón para copiar), listas, negrita y `código`. El razonamiento, si lo hay, queda plegado.
- **Ver lo que hace**: cada herramienta que usa la IA aparece como una línea («Leyó a.ts», «Editó b.ts», «Buscó…») que se despliega para ver qué recibió y qué devolvió.
- **Contexto visible**: encima del cuadro de texto aparecen el archivo abierto y tu selección, como etiquetas que puedes quitar con la ×. Eso es lo que se le dice a la IA; nada se adjunta en secreto.
- **Modelo**: depende del proveedor y se lee de tu instalación, no de una lista inventada.
  - **Claude Code**: Predeterminado y los alias `fable`, `opus`, `sonnet` y `haiku` (siempre apuntan al más reciente de tu plan), más las versiones fijas de la familia actual.
  - **Codex (ChatGPT)**: los modelos que tu cuenta tiene disponibles, leídos de `~/.codex/models_cache.json`; los marcados como anteriores o heredados quedan en «Versiones específicas». Si la caché no existe solo se ofrece «Predeterminado» y «Otro ID de modelo…».
  - **Gemini CLI**: los alias `pro`, `flash` y `flash-lite`, y las versiones concretas que conoce la herramienta instalada (sin embeddings, imágenes ni generaciones retiradas).
- **Permisos** (dos modos):
  - **Solo leer** (por defecto): la IA puede leer y buscar en el proyecto, pero no modificarlo.
  - **Puede editar**: puede editar y crear archivos sin preguntar cada vez, previa confirmación la primera vez. Los archivos abiertos que cambie se recargan en el editor, y los cambios se ven en el panel de Git, donde se pueden descartar. **Nunca se permite ejecutar comandos desde aquí.**
- **Parar** una respuesta en curso con el botón de enviar, que cambia a «parar».
- **Conversaciones**: se guardan en este equipo por proyecto (hasta 30), se listan con el botón del reloj y se reanudan con la misma sesión de la herramienta, así que recuerdan lo anterior.
- **Uso del plan**: al pie, el consumo de la sesión de 5 horas y de la semana, con cuándo se reinicia, tal como lo informa la herramienta tras cada respuesta.

## Privacidad y seguridad

- El código que la IA lee lo envía la herramienta oficial a Anthropic, igual que cuando la usas en una terminal. Pulso no envía nada por su cuenta.
- Pulso no ve tu sesión ni ningún token; no guarda tu correo (la herramienta lo informa y se descarta).
- La respuesta se pinta siempre como texto: no se interpreta HTML.
- Los argumentos que se pasan a la herramienta (sesión, modelo, permisos) se validan; el mensaje va por la entrada estándar, no por la línea de comandos.
- Las conversaciones guardadas contienen el texto de tus mensajes y de las respuestas en este equipo, sin cifrar, en el archivo `ai-chats.json` de los datos de la aplicación (antes estaban en localStorage; al actualizar se mueven solas). Se guardan como máximo 30 por equipo y 1,5 MB.

## Modelo local (Ollama)

La pestaña **Local** del asistente usa un modelo que corre en tu equipo con [Ollama](https://ollama.com): sin cuenta, sin claves, sin límites de uso y sin enviar tu código a ningún servicio.

**Cómo funciona.** Aquí no hay herramienta externa: Pulso hace de agente, con **el mismo motor que los modelos de la nube** (`agent.rs`; ver [Agente](AGENTE.md)). Con Ollama habla su protocolo nativo (`/api/chat`, en `http://127.0.0.1:11434`), no el compatible con OpenAI, porque así puede fijar la ventana de contexto.
- Tiene todas las herramientas del agente (leer, buscar, editar, escribir, ejecutar comandos, leer la web) con los mismos **modos y permisos**: en «Solo leer» solo lee, en «Puede editar» propone y aplica cambios, y en «Agente» los comandos y las páginas web piden tu aprobación. También valen los subagentes, las skills, los comandos con `/`, la memoria, los ganchos y MCP (con la misma confianza en el proyecto).
- Las herramientas se ejecutan dentro de la carpeta abierta: rechazan rutas absolutas, `..` y enlaces que salgan de ella.
- Las herramientas usadas aparecen en el panel como en Claude Code («Leyó README.md», «Buscó «sumar»»).
- **Ventana de contexto:** Ollama usa por defecto unos 4 000 tokens, que no caben con las instrucciones y las herramientas del agente. Pulso le pide la del modelo con un tope de 16 384 (si no la conoce, 8 192); se puede cambiar con la variable `PULSO_OLLAMA_NUM_CTX`. Más contexto gasta más memoria.
- Si Ollama dice que el modelo no admite herramientas, Pulso lo avisa y no empieza (el agente no puede trabajar sin ellas).
- Algunos modelos pequeños (`qwen2.5-coder:7b` lo hace) escriben la llamada a la herramienta como texto JSON en vez de usar el formato de herramientas. Si **toda** la respuesta es una llamada válida a una herramienta que se ofreció, Pulso la trata como tal; si hay texto mezclado, no.

**Requisitos:**
- Ollama instalado y en marcha.
- Al menos un modelo descargado que admita herramientas, por ejemplo `ollama pull qwen2.5-coder:7b` (unos 4,7 GB).

El panel detecta Ollama y lee sus modelos de tu instalación. «Instalar y conectar» lo instala con `winget` y descarga ese modelo en la terminal integrada. Para otra dirección (solo de este equipo) se usa `OLLAMA_HOST` o `PULSO_OLLAMA_URL`.

**Límites:**
- La calidad depende del modelo y de tu equipo; los modelos pequeños se equivocan más con las herramientas, y el agente completo ofrece muchas más que antes. Si un modelo se pierde, usa el modo «Solo leer».
- El resumen automático de conversaciones largas y el coste usan el modelo local: no cuestan dinero (el coste sale siempre en cero).
- Los subagentes que piden «otro modelo» usan el mismo modelo local.
- La conversación se envía entera en cada mensaje (el texto, hasta los últimos 30 mensajes), porque Ollama no guarda sesiones.

## Límites

- **Gemini CLI ya no funciona con cuentas personales de Google**: Google la migró a Antigravity y la herramienta responde que el cliente «ya no está soportado». Sigue sirviendo con una clave de API de Gemini (`GEMINI_API_KEY`) o cuentas de Workspace/Vertex. Antigravity no ofrece en este equipo una herramienta de línea de comandos para conversar, así que Pulso no puede usarlo todavía.
- Codex se ejecuta con `--skip-git-repo-check` (funciona en carpetas que no son repositorios) y Gemini con `--skip-trust` (la carpeta la abriste tú en Pulso). Al continuar una conversación de Codex, el modo «Solo leer» o «Puede editar» se vuelve a aplicar.
- Las claves de API propias llegarán después.
- El consumo cuenta contra los límites de tu plan; Pulso no puede ampliarlos. Si la herramienta responde que se alcanzó el límite, se muestra el mensaje.
- Si la herramienta pide un permiso que no está concedido (por ejemplo ejecutar un comando), se rechaza y la respuesta lo indica; no hay forma de aprobarlo desde Pulso todavía.
- El formato de salida de Claude Code puede cambiar entre versiones; se probó con la 2.1.304.
- No se adjuntan imágenes ni archivos arrastrados; no se muestran los cambios propuestos como diferencias antes de aplicarlos (en modo edición se aplican directamente y se revisan en Git).

## Para pruebas

La aplicación de **desarrollo** acepta `PULSO_CLAUDE_BIN` para usar una herramienta falsa (`scripts/fake-claude.cmd`) en las pruebas e2e. En la aplicación instalada ese ajuste se ignora y siempre se ejecuta `claude`.
