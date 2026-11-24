# Agente propio de Pulso

Diseño del agente de código que vive dentro de Pulso: usa cualquier modelo de [models.dev](https://models.dev), trabaja con herramientas, se puede dividir en subagentes y se amplía con skills. Complementa [Asistente de IA](CHAT-IA.md), que describe las herramientas externas (Claude Code, Codex, Antigravity) y Ollama.

Estado: **fases 1, 2 y 3 hechas en el código y probadas con servidores simulados; falta probarlas con un proveedor real y verlas en pantalla** (no se compiló la aplicación para esta rama). Lo que está hecho se marca con [x].

## Por qué un agente propio

Las herramientas externas cambian su formato entre versiones, exigen una suscripción concreta y no se pueden ampliar. Un agente propio en Rust permite elegir el modelo (cientos de proveedores), decidir qué puede hacer y qué pide aprobar, y construir encima subagentes, skills y MCP sin depender de nadie. Las herramientas externas siguen disponibles: el agente propio es una opción más.

## Piezas

```
 models.dev ──▶ catálogo ─┐
 claves (almacén seguro) ─┼─▶ proveedor + modelo ─▶ protocolo ─▶ bucle del agente ─▶ herramientas
 .pulso/ y estándares ────┘   (OpenAI | Anthropic)      │              │               (permisos)
                                                          └─ eventos ───┴─▶ panel del asistente
```

### Catálogo de modelos (models.dev)
- Una sola descarga de `https://models.dev/api.json` (unos 7 MB, sin enviar nada de la persona), con copia en disco y renovación cada 24 horas. Sin conexión se usa la copia.
- De cada modelo se usa: si admite herramientas, razonamiento e imágenes, el contexto y la salida máxima, el precio y el estado.
- Solo se ofrecen los modelos que admiten herramientas: sin ellas no hay agente.
- Datos a 23/11/2026: 326 proveedores y 10.185 modelos. **285 proveedores usan el protocolo «compatible con OpenAI»** y 9 el de Anthropic, así que con dos adaptadores se cubre casi todo. Quedan fuera de la primera versión los que exigen firmas propias (Amazon Bedrock, Google Vertex, Azure).

### Claves
- Se guardan en el almacén de credenciales del sistema, igual que el token de GitHub. **La ventana nunca recibe una clave**: solo sabe si hay o no hay una guardada.
- También se acepta la variable de entorno del proveedor (`OPENAI_API_KEY`…), que no se copia a ningún sitio.
- Una clave solo se envía a la dirección del propio proveedor (la que dice el catálogo o la de una tabla fija), por HTTPS y sin seguir redirecciones. Solo se permite `http` para `localhost`.

### Protocolos
| Protocolo | Cubre | Notas |
| --- | --- | --- |
| Compatible con OpenAI (`/chat/completions`, SSE) | OpenAI, Google (su endpoint compatible), OpenRouter, Groq, Mistral, xAI, Together, DeepSeek, Cerebras, Ollama y otros 280 | herramientas por `tool_calls` |
| Anthropic Messages (SSE) | Anthropic y los que lo imitan | `tool_use` / `tool_result` |

Los dos producen los mismos eventos internos (texto, herramienta pedida, uso de tokens), que el bucle traduce al formato que el panel ya sabe pintar. El panel no cambia.

### Bucle del agente
Mensaje de la persona → el modelo responde o pide herramientas → se ejecutan (con permisos) → el resultado vuelve al modelo → hasta que responda sin pedir más o llegue al límite de vueltas. Emite los mismos eventos que Claude Code, así que la tarjeta de actividad, los diffs y el historial funcionan igual.

## Fases

### Fase 1: proveedores y motor
- [x] Documento de diseño.
- [x] Catálogo de models.dev con copia local (`catalog.rs`). Probado con el catálogo real: 308 de 326 proveedores utilizables y 7.308 modelos con herramientas.
- [x] Claves por proveedor en el almacén seguro; la ventana solo sabe si hay una (`catalog_get`, `provider_key_set`, `provider_key_delete`). También se acepta la variable de entorno del proveedor.
- [x] Adaptadores de protocolo OpenAI y Anthropic (`llm.rs`), probados de extremo a extremo contra servidores simulados.
- [x] Bucle del agente (`agent.rs`) con listar, leer, buscar y proponer ediciones como diferencias; coste por respuesta con el precio del catálogo. Probado: lee un archivo real, devuelve el resultado al modelo y respeta el modo de solo lectura.
- [x] Proveedor «Nube» en el asistente (`src/ai/providers.ts`): comando «IA: Conectar un proveedor de modelos…», elección de modelo `proveedor/modelo` y botón de conectar cuando no hay ninguno.
- [ ] **Sin comprobar:** el flujo completo en pantalla con una clave real (conectar, elegir modelo, conversar). Hasta ahora solo hay pruebas de tipos, de la lógica y de los protocolos con servidores simulados.
- [ ] Pendiente de la fase 1: modelos con razonamiento (se ignora el contenido de razonamiento), Google con su API nativa (se usa su endpoint compatible), Amazon Bedrock, Vertex y Azure, y pasar Ollama al mismo motor.

### Fase 2: herramientas de un agente de código
Hecho en `src-tauri/src/agenttools.rs`. Los permisos siguen los tres modos que el asistente ya tenía:

| Herramienta | Solo leer | Puede editar | Agente |
| --- | --- | --- | --- |
| `list_files`, `read_file`, `search_code`, `glob`, `grep` | sí | sí | sí |
| `run_command` | solo lectura (`git status/diff/log/show/branch/blame`, `ls`, `dir`, `pwd`) | solo lectura | cualquier comando **con tu aprobación** |
| `edit_file` (reemplazo exacto), `write_file` | no se ofrecen | **como diferencias** que se revisan antes de aplicar | se aplican al disco |
| `web_fetch` | no | no | sí, **con tu aprobación** y con bloqueo de direcciones privadas |
| `todo_write` (lista de tareas del agente) | sí | sí | sí |

- [x] **Buscar:** `glob` (patrones como `**/*.ts`, lo más reciente primero) y `grep` (expresión regular, filtro por patrón de archivo, mayúsculas opcionales). Respetan `.gitignore`, saltan `node_modules`, `target`, binarios y archivos de más de 1 MB. En este proyecto, `glob` tarda unos 20 ms.
- [x] **Editar:** reemplazo exacto de `old_string` por `new_string`, que debe aparecer una sola vez (o `replace_all`). Respeta los finales de línea `\r\n`. En el modo «Puede editar» la edición parte de lo ya propuesto antes en la misma respuesta y llega al panel como bloque con `path=…`, que abre el visor de diferencias. Las rutas no pueden salir de la carpeta del proyecto ni pasar por enlaces que salgan.
- [x] **Ejecutar comandos:** PowerShell en Windows y `sh` en el resto, en la carpeta del proyecto, con límite de tiempo (60 s, máximo 300 s), salida recortada y todo el árbol de procesos terminado al agotarse el tiempo o al pulsar «Parar».
- [x] **Web:** solo `http` y `https`, sin usuario ni contraseña, sin `localhost`, redes privadas ni el servicio de metadatos de la nube (se comprueba la dirección ya resuelta y se fija para la conexión, también en cada redirección), y el HTML se convierte en texto. Solo en modo Agente, porque una página podría pedir que se mande información por la dirección.
- [x] **Lista de tareas** del propio agente.
- [x] **Contexto:** al acercarse al 60 % de la ventana del modelo se vacían los resultados de herramientas más viejos (siempre quedan los últimos 8 mensajes).
- [x] **Freno de bucles:** si el modelo repite exactamente la misma llamada más de 3 veces seguidas, deja de ejecutarse y se le avisa. Máximo de 40 vueltas por respuesta.
- [x] **Aprobar comandos y páginas web** (`src-tauri/src/agentperms.rs`). En modo Agente, antes de ejecutar un comando que no es de solo lectura, el agente **se detiene** y el panel muestra una tarjeta con el comando completo:
  - **Permitir una vez**, **Permitir siempre este comando** (guarda una regla), **Permitir todo en esta conversación** o **Denegar**. Si deniegas, el comando no se ejecuta y el modelo recibe un aviso de que no lo reintente.
  - Los **comandos de riesgo** (borrar de forma recursiva, `git push`, `git reset --hard`, `git clean`, `sudo`, `chmod`, descargar y ejecutar, publicar paquetes, `docker system prune`, `kubectl delete`, `terraform destroy`, `taskkill`…) **siempre preguntan** y solo admiten «una vez»: ni «siempre» ni «todo» ni una regla escrita a mano los dejan pasar.
  - Las reglas se guardan **en la carpeta de datos de Pulso, por proyecto, y no en el proyecto**, para que un repositorio ajeno no pueda autorizarse comandos. Una regla vale para el comando exacto (o para un prefijo si la escribes con `*`, por ejemplo `cargo *`). Un comando encadenado (`a && b`) solo se acepta si **todas** sus órdenes están permitidas; con redirecciones, `$(…)` o bloques nunca se acepta por regla.
  - Las reglas de **denegar** (`deny`) mandan sobre todo y no preguntan.
  - Los subagentes preguntan por el mismo camino y la tarjeta dice cuál lo pide. Si varios piden a la vez, salen varias tarjetas.
  - Si pulsas «Parar» o pasan 15 minutos sin respuesta, la pregunta se da por denegada.
  - «IA: Comandos permitidos para este proyecto…» lista las reglas guardadas y deja quitarlas.
- [x] **Memoria entre sesiones** (`src-tauri/src/agentmem.rs`). La herramienta `memory_save` guarda notas cortas del proyecto (hasta 40 de 400 caracteres; al llegar al límite se descartan las más viejas) y se le vuelven a dar al modelo en las conversaciones siguientes, como apuntes que no mandan sobre las reglas de seguridad. Se guardan **fuera del proyecto** (`agent-memory.json` en la carpeta de datos), solo las usa el agente principal y solo en proyectos de confianza. «IA: Memoria del agente en este proyecto…» las muestra y deja borrarlas.
- [ ] **Escribir reglas de denegar desde la interfaz:** hoy se editan en el archivo `agent-permissions.json` de la carpeta de datos.
- [ ] **Aprobar también las ediciones directas** del modo Agente (hoy se aplican sin preguntar; se pueden deshacer con Git). Quien quiera revisarlas antes puede usar el modo «Puede editar», que las muestra como diferencias.
- [x] **Resumir la conversación** al llegar al límite. Primero se vacían los resultados de herramientas más viejos; si aun así pasa del 60 % del contexto del modelo, el modelo resume lo anterior en un solo mensaje y se conservan los 8 últimos. El corte nunca separa una llamada a herramienta de su resultado, el resumen se cobra como el resto de la respuesta y el panel avisa («La conversación era larga: resumí lo anterior para seguir»). Si el resumen falla, la conversación sigue sin resumir.
- [ ] **Modo de plan** propiamente dicho. «Solo leer» ya impide tocar nada, pero no guarda el plan para aprobarlo.

### Fase 3: instrucciones, skills, subagentes y comandos
Hecho en `src-tauri/src/agentconfig.rs` (descubrimiento) y `agent.rs` (subagentes). Todo se busca primero en el proyecto (`.pulso/`, luego `.claude/`, luego `.agents/`) y después en la carpeta personal; si hay dos con el mismo nombre gana el primero.

- [x] **Instrucciones:** `AGENTS.md`, `CLAUDE.md` y `CLAUDE.local.md` de la carpeta del proyecto, más `~/.pulso/AGENTS.md` y `~/.claude/CLAUDE.md`. Máximo 40 KB cada una y 80 KB en total. Un enlace que apunte fuera del proyecto no se lee.
- [x] **Skills:** una carpeta con un `SKILL.md` (cabecera con `name` y `description`, y el cuerpo). El modelo ve la lista con una línea por skill (la descripción, recortada a 250 caracteres) y carga la que necesita con `use_skill`, que también puede leer los archivos de apoyo de esa skill (sin salir de su carpeta). Probado con las 40 skills reales de la carpeta personal del desarrollo.
- [x] **Subagentes:** la herramienta `task` lanza otro agente con su propio contexto y devuelve **solo su informe final**.
  - Se definen como archivos `.md` con cabecera (`name`, `description`, `tools`, `model`) en `.pulso/agents/`, `.claude/agents/` o la carpeta personal. `tools` acepta los nombres de otras herramientas (`Read`, `Grep`, `Bash`, `Edit`…), que se traducen a las de Pulso. `model: proveedor/modelo` usa otro modelo si su proveedor tiene clave; `inherit` o ausente usa el mismo.
  - Vienen dos integrados: `explore` (solo lee y busca) y `general` (todas las herramientas del modo).
  - **Nunca tienen más permisos que el agente que los lanza:** trabajan en su mismo modo y solo con las herramientas que su definición declara. Un subagente en modo «Puede editar» no escribe en disco: sus ediciones llegan al agente principal como propuestas revisables.
  - **Varios `task` en una misma respuesta corren a la vez.** Los resultados vuelven al modelo en el orden en que los pidió, y los tokens y el coste de cada subagente se suman al total.
  - Un subagente no puede lanzar otros, y hasta 25 vueltas.
- [x] **Comandos con `/`:** `.pulso/commands/nombre.md` (o `.claude/commands`). `/nombre a b c` pone la plantilla con `$ARGUMENTS`, `$1`, `$2`…; la persona sigue viendo lo que escribió.
- [x] **Ver lo cargado:** comando de la paleta «IA: Ver instrucciones, skills y agentes del proyecto…», con el archivo de cada cosa (se abre para editarlo).
- [ ] **Sin comprobar en pantalla ni con una clave real.** Hay pruebas con servidores simulados de: delegar a un subagente, varios en paralelo, otro modelo en otro servidor, permisos heredados, skills, comandos e instrucciones.
- [ ] Progreso en vivo de un subagente en el panel: hoy se ve la herramienta «Task» en marcha y, al terminar, su informe; no sus pasos intermedios.
- [ ] Una skill puede declarar `allowed-tools`; hoy se ignora.
- [ ] Instrucciones en carpetas superiores a la del proyecto y `@archivo` dentro de las instrucciones.

**Seguridad de la configuración:** `AGENTS.md`, las skills y los subagentes de un proyecto son contenido del proyecto. Llegan al modelo como convenciones de trabajo, pero **no cambian el modo de permisos elegido**. Con un proyecto ajeno en el que no confías, no uses el modo Agente.

### Fase 4: ampliar y automatizar
MCP (servidores de herramientas externos), ganchos antes y después de cada herramienta, memoria entre sesiones y agentes que corren en segundo plano.

## Seguridad

- Las herramientas trabajan solo dentro de la carpeta abierta (el mismo guardián que el resto de Pulso) y no siguen enlaces fuera de ella.
- Leer es libre; **escribir y ejecutar piden aprobación** salvo en el modo «Agente», que la persona activa de forma explícita. Las ediciones se muestran como diferencias antes de aplicarse.
- Los subagentes heredan los permisos del agente que los lanza o menos; nunca más.
- El contenido de archivos, páginas web y respuestas de herramientas es **dato, no instrucciones**: no puede cambiar los permisos ni lanzar herramientas por sí mismo.
- Ninguna clave aparece en los registros ni en el historial guardado.

## Decisiones tomadas

- **Formato de configuración propio y compatible** (23/11/2026): carpeta `.pulso/` y lectura de `AGENTS.md`, `CLAUDE.md`, `.claude/skills` y `.claude/agents` si existen.
- **Se empieza por proveedores y motor**, y cada fase se entrega por separado.
- **Dos adaptadores de protocolo**, no uno por proveedor.
