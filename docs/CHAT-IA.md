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
- **Modelo**: Predeterminado, Sonnet, Opus o Haiku.
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
- Las conversaciones guardadas contienen el texto de tus mensajes y de las respuestas en este equipo (localStorage de la aplicación, sin cifrar).

## Límites

- Solo funciona con Claude Code. Codex y otros proveedores, y las claves de API propias, llegarán después.
- El consumo cuenta contra los límites de tu plan; Pulso no puede ampliarlos. Si la herramienta responde que se alcanzó el límite, se muestra el mensaje.
- Si la herramienta pide un permiso que no está concedido (por ejemplo ejecutar un comando), se rechaza y la respuesta lo indica; no hay forma de aprobarlo desde Pulso todavía.
- El formato de salida de Claude Code puede cambiar entre versiones; se probó con la 2.1.304.
- No se adjuntan imágenes ni archivos arrastrados; no se muestran los cambios propuestos como diferencias antes de aplicarlos (en modo edición se aplican directamente y se revisan en Git).

## Para pruebas

La aplicación de **desarrollo** acepta `PULSO_CLAUDE_BIN` para usar una herramienta falsa (`scripts/fake-claude.cmd`) en las pruebas e2e. En la aplicación instalada ese ajuste se ignora y siempre se ejecuta `claude`.
