# Funciones y guía de uso

Este inventario describe la implementación presente en el repositorio. Las propuestas para versiones futuras están en [Hoja de ruta](HOJA-DE-RUTA.md).

## Espacio de trabajo y archivos

- Se abre una carpeta de trabajo y se mantienen carpetas recientes. Al reiniciar se intenta restaurar la última sesión: carpeta, grupos y pestañas.
- El explorador permite crear, renombrar, mover y enviar archivos o carpetas a la papelera; ofrece menús contextuales y permite mostrar un elemento en el explorador del sistema.
- El editor admite pestañas fijadas, reapertura de pestañas y hasta cuatro grupos, en disposición horizontal o vertical. Un documento abierto en varios grupos comparte su contenido.
- Hay paleta de comandos, apertura rápida de archivos, navegación atrás/adelante y atajos editables.
- Línea de comandos (`pulso`, un programa de consola que viaja con el instalador y queda en el PATH del usuario; se deshace al desinstalar). Sin argumentos abre el asistente de IA en la propia terminal, sobre la carpeta actual, como `claude`: `pulso`, o `pulso -p "pregunta"` para una sola respuesta. Opciones: `--provider claude|codex|antigravity`, `--model`, `--effort`, `--edit` (por defecto solo lee). Solo trabaja en carpetas de proyecto: la primera vez en cada una pide confianza (se recuerda, y vale para sus subcarpetas; `--trust` la da sin preguntar) y se niega en la raíz de una unidad, la carpeta personal, Escritorio, Documentos, Descargas y carpetas del sistema. Muestra un recuadro de bienvenida, un indicador de espera con el tiempo, las herramientas que usa la IA y la respuesta con formato (títulos, listas, negrita, código y bloques); sin colores si la salida no es una terminal o existe `NO_COLOR`. Habla en el idioma del sistema (español si es español; si no, inglés); `PULSO_LANG=es` o `PULSO_LANG=en` lo fija. Dentro: `/provider`, `/model`, `/effort`, `/edit`, `/read`, `/new`, `/help`, `/exit`; la conversación continúa entre mensajes. Con una ruta abre la ventana: `pulso .`, `pulso archivo`, `pulso -g archivo:línea:columna` (varias a la vez). Solo hay una ventana: si Pulso ya está abierto, las rutas se abren en ella y se le da el foco. Una carpeta pasa a ser el espacio de trabajo; un archivo suelto sin carpeta abierta abre la carpeta que lo contiene. El comando «Instalar el comando «pulso» en la terminal» repite el paso del PATH en Windows.
- El explorador oculta `.git`, `node_modules` y `target`. La apertura rápida recorre hasta 20.000 archivos y omite, además, varios directorios de compilación habituales.

## Edición y búsqueda

Monaco proporciona la superficie de edición, resaltado de sintaxis y funciones propias como selección, deshacer/rehacer y búsqueda en el documento. Pulso permite ajustar fuente, tamaño, ligaduras, números de línea, minimapa, espacios visibles, ajuste de línea, tamaño de tabulación y autoguardado. La barra de estado muestra posición, lenguaje, espacios y fin de línea; se puede alternar entre LF y CRLF. En archivos de más de un millón de caracteres Pulso desactiva el resaltado de corchetes, de coincidencias y la coloración de pares de corchetes para mantener fluida la escritura; no hay aviso visible ni opción para cambiarlo todavía.

La búsqueda en el proyecto admite mayúsculas/minúsculas, palabra completa y expresiones regulares, corre en paralelo desde Rust respetando `.gitignore` y el contenido en pantalla de los documentos abiertos con cambios sin guardar (se marcan «sin guardar»). El reemplazo muestra primero los archivos y recuentos afectados, pide confirmación y reemplaza tanto en disco (escritura atómica con comprobación de cambios) como en documentos abiertos sin guardar (con soporte de `Ctrl+Z`). Solo reemplaza archivos de texto UTF-8 de hasta 2 MB y muestra como máximo 5.000 coincidencias.

## Confiabilidad y recuperación

- Al guardar se compara la fecha de modificación conocida con la del disco. Si cambió, Pulso ofrece cancelar, cargar la versión del disco o sobrescribirla.
- El guardado normal escribe en un archivo temporal del mismo directorio y lo reemplaza; si no puede reemplazarlo, comunica el error. Los enlaces simbólicos existentes se resuelven hacia su destino.
- Los cambios sin guardar generan copias de recuperación aproximadamente cada segundo mientras hay ediciones. Además se escriben al instante cuando la ventana pierde el foco o se oculta. Al iniciar, Pulso permite restaurarlas, descartarlas o dejarlas para después. Los errores al actualizar una copia se muestran en la barra de estado.
- Al cerrar pestañas o la aplicación con cambios pendientes, Pulso pregunta qué hacer. Si se edita mientras hay un guardado en curso, el documento sigue marcado como pendiente.

Límites: un fallo antes de que termine la primera copia o entre actualizaciones puede perder las últimas ediciones. El conflicto se detecta por fecha; si la fecha cambió pero el contenido del disco es el mismo que el editor conocía (git, sincronización en la nube, un formateador), Pulso lo ignora y no pregunta. La comparación por fecha no garantiza detectar todos los cambios simultáneos, y existe una ventana entre comprobar y reemplazar. Las copias de recuperación contienen texto sin cifrar en los datos de la aplicación. El reemplazo masivo usa la misma escritura atómica y comprobación por fecha que el guardado normal, con sus mismos límites.

## Terminal integrada

La terminal utiliza xterm.js y un pseudoterminal nativo; admite procesos interactivos y varias pestañas. En Windows detecta las shells disponibles entre PowerShell, CMD, Git Bash y WSL. Permite elegir shell, copiar/pegar, limpiar, redimensionar el panel, ejecutar una selección y abrir una terminal en la carpeta del archivo activo. La primera vez adopta, sin preguntar, la terminal de la persona: su shell, fuente y colores detectados en VS Code o Windows Terminal (solo si no los había fijado a mano; el comando «Terminal: Adaptar a mi terminal» sigue disponible). Los iconos de los prompts con Nerd Fonts (oh-my-posh, starship) se dibujan sin instalar nada: Pulso incluye *Symbols Nerd Font Mono* (licencia MIT, `src/assets/fonts/LICENSE-NerdFonts.txt`, 2,6 MB) como fuente de respaldo solo para esos símbolos; si tienes una Nerd Font instalada, se usa primero.

**Scripts de package.json.** La paleta (`Ctrl+Shift+P`) tiene **Tareas: Ejecutar un script de package.json**: lista los scripts de la carpeta abierta con su comando y el gestor detectado por el archivo de bloqueo (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`; si no hay, npm), y al elegir uno escribe `<gestor> run <script>` en la terminal activa (la crea si no hay). Se omiten los scripts cuyo nombre contenga caracteres que un shell interpretaría. Se ejecuta en el directorio en el que esté la terminal activa, que puede no ser la carpeta abierta si te moviste con `cd`.

## Inteligencia de proyecto: LSP

Pulso inicia un servidor local de TypeScript/JavaScript al abrir una carpeta. Ofrece diagnósticos, sugerencias, documentación al pasar el cursor, definiciones y referencias; sincroniza documentos abiertos y sus cambios sin guardar. Detecta extensiones TypeScript/JavaScript, incluidas variantes JSX/TSX.

**Sin instalar nada.** El servidor es el de **TypeScript 7**, un ejecutable nativo que viene con Pulso: no hace falta Node.js. TypeScript 7 retiró opciones antiguas de `tsconfig.json` (`baseUrl`, `moduleResolution: "node"`, `target: "es5"`, …) y las marca como error. Por eso, si el proyecto tiene instalado **TypeScript 5 o 6** en su `node_modules` (o en el de una carpeta superior), Pulso usa esa versión, como antes. Ese **modo compatible** necesita Node.js, que esos proyectos ya tienen. Si Node no está, Pulso usa TypeScript 7 y lo avisa en la barra de estado.

Con `Ctrl` pulsado (`Cmd` en macOS) el cursor pasa a mano sobre las palabras y, cuando el servidor confirma que hay definición, se subraya; `Ctrl+clic` abre el archivo de destino. Si el servidor aún está arrancando, el primer `Ctrl+clic` espera a que termine en vez de perderse.

La barra de estado muestra su estado («LSP: iniciando…», «LSP: activo» o «LSP: detenido»); al pulsarlo se explica el estado, con el motivo si se detuvo, y se puede reiniciar. Si el servidor falla, Pulso informa y vuelve a los servicios integrados de Monaco. Para reiniciarlo, abre la paleta y busca **Lenguaje: Reiniciar inteligencia de TypeScript y JavaScript**. **Renombrar (F2).** Con el cursor sobre un símbolo, `F2` pide el renombrado al servidor. También están conectadas las acciones de código (`Ctrl+.`), ayuda de firma, símbolos del documento (`Ctrl+Shift+O`) e inlay hints respetando las capacidades anunciadas por el servidor; el soporte de otros lenguajes requiere nuevos servidores.

**Formatear.** `Mayús+Alt+F` da formato al documento con el servidor de lenguaje (TypeScript y JavaScript, con el tamaño de tabulación del editor). La opción **Formatear al guardar** (Configuración o la paleta; apagada por defecto) lo hace al guardar con `Ctrl+S`, nunca en el autoguardado; si el formateo falla o tarda más de 4 s, se guarda el texto tal cual. Pulso no incluye Prettier ni otros formateadores.

**Panel de problemas (`Ctrl+Shift+M`).** Lista los errores, avisos e informaciones de los **archivos abiertos**, agrupados por archivo (primero los que tienen más errores) y ordenados por línea; un clic lleva a la posición. El botón ✖ deja solo los errores. La barra de estado muestra el recuento («✖ 2  ⚠ 1») y la barra de actividad una insignia. No analiza archivos que no están abiertos.

## Git y GitHub

Pulso lee el estado Git mediante el ejecutable `git`: muestra rama, cambios, decoraciones en el explorador y adelantos/atrasos cuando están disponibles. La vista de GitHub lee hasta 50 issues del remoto `origin`, permite filtrar por estado y abre la issue en el navegador. 

### Control de código fuente

La vista **Control de código** (`Ctrl+Shift+G`, icono de ramas en la barra de actividad) muestra los cambios del repositorio de la carpeta abierta, aunque la carpeta sea una subcarpeta del repositorio:

- Secciones **Conflictos**, **Cambios preparados** y **Cambios** (modificados, eliminados, renombrados y sin seguimiento, cada archivo por separado). La insignia de la barra de actividad cuenta los cambios.
- **Preparar / quitar de lo preparado** por archivo (botón `+` / `−` al pasar el ratón) o todo de una vez (botón de la cabecera de la sección). Quitar de lo preparado no modifica el contenido del archivo. También funciona en un repositorio sin ningún commit.
- **Diferencias**: un clic en un archivo abre una comparación lado a lado o en línea. Un archivo preparado se compara contra `HEAD`; uno sin preparar, contra el índice; uno nuevo, contra vacío. Esc la cierra. Los archivos binarios y los de más de 2 MB no se comparan.
- **Commit**: se escribe el mensaje (admite varias líneas) y se confirma con el botón o `Ctrl+Enter`. Se exige algo preparado y un mensaje. Si git rechaza el commit (por ejemplo, falta configurar tu nombre y correo), se muestra el mensaje de git tal cual.
- **Ramas**: el botón con el nombre de la rama (en el panel o en la barra de estado) abre un selector para cambiar de rama, crear una nueva o seguir una rama que solo existe en el remoto (se crea la local asociada). Si Git se niega a cambiar porque hay cambios que se perderían, se muestra su mensaje y no se toca nada.
- **Descartar**: en los cambios sin preparar, el botón de deshacer descarta un archivo, o todos desde la cabecera de la sección, siempre tras una confirmación que dice qué se pierde. Lo modificado o eliminado vuelve a su versión preparada (o a la última confirmada); los archivos nuevos sin seguimiento van a la papelera de reciclaje. No toca lo que ya está preparado y no se puede deshacer desde Pulso.
- **Push y pull**: los botones ↑ y ↓ del panel suben y traen cambios y muestran cuántos commits hay pendientes. Si la rama no tiene remoto asociado, el primer push la crea en `origin` y la deja asociada. El pull solo acepta avances limpios (`--ff-only`): si la historia divergió, lo explica y deja la resolución a la terminal. Cada operación se cancela a los 120 s.
- Comandos de la paleta: «Git: Preparar todos los cambios», «Git: Quitar todo de lo preparado», «Git: Confirmar los cambios preparados», «Git: Cambiar de rama o crear una nueva…», «Git: Traer cambios del remoto (pull)» y «Git: Subir commits al remoto (push)».

Autenticación: push y pull usan las credenciales que Git ya tenga en tu equipo (por ejemplo, Git Credential Manager); Pulso no gestiona contraseñas ni usa el token de las issues para esto. Si Git necesita iniciar sesión y no puede, la operación se cancela y el mensaje lo indica. Se probó contra un remoto local; no contra GitHub.

Límites: no hay preparar por fragmentos, historial, borrar o renombrar ramas, merge ni rebase, ni resolución asistida de conflictos (los archivos en conflicto se abren para editarlos y se marcan como resueltos al prepararlos). La comparación de un archivo sin preparar usa lo guardado en disco, no los cambios sin guardar del editor. Un renombrado detectado por git se prepara y se quita junto con el nombre anterior. Para repositorios con identidad sin configurar, git decide el resultado.

### Historial y culpa

- **Pestaña «Historial»** del panel de Git (junto a «Cambios»): los commits de la rama actual de 40 en 40 («Cargar más commits»), con asunto, autor, antigüedad, identificador corto y las ramas y etiquetas que apuntan a él. Pulsar un commit despliega sus archivos con su estado (M, A, D, R); pulsar un archivo abre sus diferencias (versión del padre contra la del commit) en el mismo visor que el panel de cambios. El botón de cada commit copia su identificador completo. Se recarga sola tras un commit, un pull o un cambio de rama, sin perder lo desplegado.
- **Historial de un archivo** («Git: Historial del archivo activo»): filtra la pestaña por ese archivo siguiendo sus renombrados (`git log --follow`); la «x» del filtro vuelve a todo el repositorio.
- **Culpa en línea** («Git: Alternar culpa en línea»; se recuerda): junto a la línea del cursor aparece quién la cambió, cuándo y el asunto del commit. Solo con archivos guardados (con cambios sin guardar los números de línea ya no coinciden con los de git y no se muestra nada); una línea que aún no está en ningún commit lo dice. Se actualiza al guardar y al confirmar.
- Límites: no hay vista de grafo de ramas, ni buscar en el historial, ni ver el historial de un fragmento. Las rutas se validan para no salir del repositorio, y los identificadores de commit solo admiten caracteres hexadecimales. Probado con repositorios temporales (Rust) y en la aplicación real.

### Asistente de IA

Chat con Claude Code usando tu propia sesión (tu suscripción), con respuesta en vivo, herramientas visibles, contexto adjunto a la vista (archivo y selección), modos «Solo leer» y «Puede editar», conversaciones guardadas por proyecto y el uso del plan al pie. Barra lateral o pantalla completa. Detalles, privacidad y límites en [Asistente de IA](CHAT-IA.md).

### Pull requests

Icono de la barra de actividad o «Ver: Pull requests». Usa la cuenta de GitHub conectada (si falta, ofrece conectar) y el remoto `origin` de la carpeta.

- **Lista** con filtro Abiertas / Cerradas / Todas: título, estado (abierta, borrador, fusionada o cerrada, con su color), número, autor, rama de origen → destino y antigüedad. Se actualiza sola cada 20 s con la vista visible y al volver a la ventana (consultas con ETag, sin gastar cuota si nada cambió).
- **Detalle**: título, estado, rama → destino, totales (archivos, +líneas, −líneas), descripción en texto plano, «Ver en GitHub» y la lista de archivos (hasta 300) con su estado y sus cambios. Cada archivo se abre en el visor de diferencias comparando el **ancestro común** con la punta de la rama (lo mismo que muestra GitHub, aunque la rama de destino haya avanzado); los archivos añadidos o eliminados comparan contra vacío, los renombrados contra su nombre anterior, y los binarios o de más de 2 MB lo avisan.
- **Nueva pull request**: parte de la rama actual. Comprueba antes de enviar que haya una rama activa, que no sea la de destino y que esté subida a GitHub (si no, explica qué hacer). Propone como título el del último commit (o el nombre de la rama en lenguaje normal), permite descripción y cambiar la rama de destino (por defecto, la principal del repositorio), y tras crearla abre su detalle. Si GitHub la rechaza (ya existe una abierta, no hay commits nuevos, falta permiso) lo explica en español.
- Límites: solo ramas del mismo repositorio (no forks); no se puede fusionar, cerrar, revisar, comentar ni ver los resultados de las comprobaciones desde Pulso; la descripción se muestra como texto, sin Markdown. Probado contra un GitHub simulado; **no se ha probado con tu repositorio real**.

### Tablero kanban de issues

El botón del tablero en la vista de Issues (o «Issues: Abrir el tablero kanban» en la paleta) muestra las issues del remoto `origin` de GitHub en cuatro columnas:

- **Por hacer**: issues abiertas sin etiqueta de estado.
- **En curso**: issues abiertas que llevan la etiqueta de progreso (por defecto `in progress`, sin distinguir mayúsculas; se cambia en Configuración → GitHub).
- **En revisión**: issues abiertas con la etiqueta `pulso: in review`.
- **Hecho**: issues cerradas.

Las tarjetas muestran número, título, etiquetas, a quién está asignada (o quién la abrió) y los comentarios; el icono de la esquina abre la issue en GitHub. Las pull requests no aparecen. Se cargan hasta 300 issues abiertas y 100 cerradas, las más recientemente actualizadas primero, y se avisa si hay más.

**Cerrar, reabrir y eliminar.** Cada tarjeta tiene, al pasar el ratón, botones para **cerrar** (o **reabrir** si está en «Hecho»), **eliminar** y abrir en GitHub. Eliminar pide confirmar y ofrece «Cerrar en su lugar»; borra la issue para siempre con la API GraphQL de GitHub (la REST no lo permite), y **solo quienes administran el repositorio pueden**: si no, Pulso lo explica y la tarjeta se queda. En la lista lateral de issues, pulsar una issue la abre para editarla en el tablero, y al pasar el ratón salen los botones de abrir en GitHub y eliminar. La lista se actualiza sola tras un cambio hecho desde el tablero y al volver a la ventana. La issue del chat (etiqueta `pulso-chat`) no aparece ni en el tablero ni en la lista.

**Mover tarjetas.** Se arrastran con el ratón (eventos de puntero propios, no el arrastrar y soltar de HTML5, que en la ventana de la aplicación no funcionaba): al moverse más de 6 px aparece la tarjeta flotando y la columna de destino se resalta; `Esc` cancela. Con el teclado, `Alt+←` y `Alt+→` sobre una tarjeta enfocada la pasan a la columna vecina. Un clic sin arrastrar abre su edición. **Nueva issue**: cada columna (menos «Hecho») tiene un botón fijo al pie, siempre visible aunque haya muchas tarjetas; el de la cabecera crea en «Por hacer». **Apertura rápida**: al reabrir el tablero en la misma sesión se pinta al instante la última lectura y se actualiza detrás; la primera vez muestra las columnas con marcadores de carga en vez de una pantalla vacía.

**Arrastrar una tarjeta modifica GitHub**: a «En curso» añade la etiqueta; de «En curso» a «Por hacer» la quita; a «Hecho» quita la etiqueta y cierra la issue; de «Hecho» a otra columna reabre la issue (y etiqueta si va a «En curso»). La primera vez en cada repositorio pide confirmación. Necesita un token con permiso de escritura en las issues; sin token no se intenta nada. La tarjeta se mueve al instante y, si GitHub rechaza el cambio, Pulso explica el motivo (token inválido, sin permiso, límite de la API) y vuelve a leer el estado real.

**Crear y editar**: «Nueva issue» (cabecera) o el `+` de «Por hacer» y «En curso» abren un formulario con título (obligatorio), descripción y etiquetas separadas por comas, y crean la issue en GitHub; en «En curso» nace con la etiqueta de progreso. Pulsar una tarjeta abre su edición con los datos actuales y solo envía a GitHub lo que cambió (no escribe nada si no tocaste nada). Las etiquetas del formulario reemplazan a las actuales: quitar o poner la etiqueta de progreso cambia la columna.

**Sincronización con GitHub**: lo que pasa en GitHub llega al tablero al pulsar «Recargar», al volver a la ventana (si pasaron al menos 5 s desde la última lectura) y, solo con token, cada 15 s mientras el tablero está abierto (la lista lateral, cada 15 s con su vista visible). Las consultas no usan la caché del navegador —GitHub responde con `max-age=60` y el tablero mostraría datos de hasta un minuto atrás— y repiten con ETag: si no cambió nada GitHub responde 304 y no gasta cuota. Sin token no hay recarga periódica, porque la API sin autenticar permite solo 60 consultas por hora. La recarga automática no actúa con un diálogo abierto, un arrastre o un cambio en curso, ni con la ventana oculta, y no repinta si nada cambió. No usa webhooks, así que no es instantánea.

Límites: columnas fijas (no hay columnas personalizadas ni GitHub Projects), sin orden manual dentro de una columna, sin cambiar el estado desde el formulario (se hace arrastrando), sin comentarios ni asignados editables, y se probó contra un servidor de GitHub simulado, no contra GitHub real.

**Chat del equipo.** Es una vista de la barra lateral (icono de mensajes) y un botón la pasa a pantalla completa (Esc vuelve; Pulso recuerda la elección). Chat de grupo de las personas del repositorio, sin configurar nada más que conectar la cuenta de GitHub: la sala se encuentra o se crea sola (una issue con la etiqueta `pulso-chat`), con burbujas, panel de personas, @menciones, enlaces e insignia de mensajes nuevos. Los mensajes llegan en unos segundos y tienen la visibilidad del repositorio. Detalles y límites en [Chat del equipo](CHAT-REPOSITORIO.md).

**Abrir enlaces.** Pulsar una issue de la lista lateral (o el icono de enlace de una tarjeta) la abre en el navegador del sistema. La ventana de Pulso no abre ventanas nuevas, así que se usa un comando propio que solo acepta enlaces http y https. El botón **Tablero** de la cabecera de Issues abre el tablero kanban.

**Conectar la cuenta de GitHub.** No hay que crear ni pegar ningún token. Con una carpeta con `origin` de GitHub, si la lista de issues o el tablero reciben 401, 403 o 404 (GitHub responde 404 a un repositorio privado al que no tienes acceso), aparece el botón **Conectar con GitHub**; también está en Configuración → GitHub, junto a «Volver a conectar» y «Desconectar». El botón pide a Git la credencial de GitHub (`git credential fill`): si Git Credential Manager ya tiene tu sesión se usa al instante; si no, el gestor abre el navegador para que autorices el acceso. Pulso comprueba la sesión con `GET /user`, muestra «Conectado como …» y guarda el token en el almacén de credenciales del sistema. Al iniciar, si no hay ningún token, Pulso adopta en silencio la sesión que Git ya tenga (nunca abre ventanas). Requisitos y límites: Git instalado y un gestor de credenciales (Git Credential Manager viene con Git para Windows); el permiso es el que concedió ese gestor (normalmente acceso a repositorios); si GitHub rechaza una sesión caducada, Pulso lo dice y no guarda nada. No se probó la autorización por navegador desde cero (sin sesión previa).

Para repositorios privados también se puede configurar un token a mano en Ajustes (avanzado). Pulso intenta guardarlo en el almacén de credenciales del sistema y migra el token de la ubicación antigua; si el almacén falla, se conserva en memoria durante la sesión.

## Personalización

Incluye temas de interfaz y sintaxis, colores de acento, configuración de la terminal y editor de atajos. Es posible importar temas de VS Code instalados o un archivo de tema JSON; esto no instala extensiones de VS Code.

**Idioma.** Se elige en Configuración → Apariencia → Idioma: «Automático» (español si el sistema está en español; si no, inglés), «Español» o «English». El cambio se aplica al recargar la ventana: el diálogo ofrece «Recargar ahora». Traducido al inglés por ahora:
- menús;
- paleta de comandos;
- barra de estado y barra de actividad;
- pantalla de inicio;
- diálogos comunes;
- actualizaciones;
- página de configuración;
- textos fijos de los paneles;
- explorador, búsqueda y reemplazo, pestañas, conflictos y recuperación de archivos;
- control de código (Git), historial, diferencias y pull requests;
- servidor de lenguaje y panel de problemas.

También issues, tablero, chat del equipo y «trabajar en una issue». También el asistente de IA, los temas, los atajos y la terminal. También los mensajes de error que llegan desde Rust. Siguen en español a propósito lo que se envía a la IA o se publica en GitHub para todo el equipo (como el título de la sala del chat o el cuerpo de las pull requests que crea el flujo de issues). Las opciones del propio editor Monaco (menú contextual, buscar en el documento) están siempre en inglés.

**Aspecto por defecto.** El tema «Pulso Oscuro» usa grafito neutro y un único acento azul (`#5b9cf5`); el color queda para estados, etiquetas y la acción principal, y la barra de estado es neutra. El texto de los botones con acento se elige por contraste (blanco o negro, el que más contraste dé). Quien tenía el acento morado de fábrica pasa al nuevo; uno elegido a propósito se respeta. La dirección completa y sus razones están en [DESIGN.md](../DESIGN.md).

## Atajos predeterminados

| Acción | Atajo |
| --- | --- |
| Abrir carpeta | `Ctrl+O` |
| Abrir archivo rápido | `Ctrl+P` |
| Paleta de comandos | `Ctrl+Shift+P` |
| Guardar / guardar todo | `Ctrl+S` / `Ctrl+Shift+S` |
| Buscar en el proyecto | `Ctrl+Shift+F` |
| Control de código fuente (Git) | `Ctrl+Shift+G` |
| Problemas (errores y avisos) | `Ctrl+Shift+M` |
| Renombrar símbolo (LSP) | `F2` |
| Mostrar terminal / nueva terminal | `Ctrl+J` / `Ctrl+Shift+J` |
| Dividir editor | `Ctrl+Shift+D` |
| Reabrir pestaña cerrada | `Ctrl+Shift+T` |
| Configuración | `Ctrl+,` |
| Alternar ajuste de línea | `Alt+Z` (también en la barra de estado: «Ajuste: sí/no») |

Estos valores pueden modificarse en Configuración.

## Comprobación manual sugerida

Usa una carpeta de prueba con archivos que puedas modificar:

1. Abre la carpeta, edita un archivo, guarda, divide el editor y vuelve a abrir la aplicación para comprobar la sesión.
2. Ejecuta `node --version` en la terminal y abre una segunda pestaña de terminal.
3. En un proyecto TypeScript, provoca un error de tipos, comprueba la sugerencia de una variable y navega a una definición en otro archivo.
4. Cambia un archivo abierto desde otro programa y comprueba el diálogo de conflicto antes de guardar.
5. Si la carpeta tiene Git, comprueba la rama y las marcas de archivos. Para issues, configura `origin` y, si corresponde, el token.
