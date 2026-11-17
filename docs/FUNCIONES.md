# Funciones y guía de uso

Este inventario describe la implementación presente en el repositorio. Las propuestas para versiones futuras están en [Hoja de ruta](HOJA-DE-RUTA.md).

## Espacio de trabajo y archivos

- Se abre una carpeta de trabajo y se mantienen carpetas recientes. Al reiniciar se intenta restaurar la última sesión: carpeta, grupos y pestañas.
- El explorador permite crear, renombrar, mover y enviar archivos o carpetas a la papelera; ofrece menús contextuales y permite mostrar un elemento en el explorador del sistema.
- El editor admite pestañas fijadas, reapertura de pestañas y hasta cuatro grupos, en disposición horizontal o vertical. Un documento abierto en varios grupos comparte su contenido.
- Hay paleta de comandos, apertura rápida de archivos, navegación atrás/adelante y atajos editables.
- El explorador oculta `.git`, `node_modules` y `target`. La apertura rápida recorre hasta 20.000 archivos y omite, además, varios directorios de compilación habituales.

## Edición y búsqueda

Monaco proporciona la superficie de edición, resaltado de sintaxis y funciones propias como selección, deshacer/rehacer y búsqueda en el documento. Pulso permite ajustar fuente, tamaño, ligaduras, números de línea, minimapa, espacios visibles, ajuste de línea, tamaño de tabulación y autoguardado. La barra de estado muestra posición, lenguaje, espacios y fin de línea; se puede alternar entre LF y CRLF. En archivos de más de un millón de caracteres Pulso desactiva el resaltado de corchetes, de coincidencias y la coloración de pares de corchetes para mantener fluida la escritura; no hay aviso visible ni opción para cambiarlo todavía.

La búsqueda en el proyecto admite mayúsculas/minúsculas, palabra completa y expresiones regulares. La búsqueda incluye el contenido en pantalla de los documentos abiertos con cambios sin guardar (se marcan «sin guardar»). El reemplazo muestra primero los archivos y recuentos afectados y pide confirmación; no modifica documentos con cambios sin guardar y los lista. Cada archivo se reemplaza con las mismas reglas que la búsqueda (línea a línea, conservando CRLF/LF), con escritura atómica y comprobación de que no cambió desde la búsqueda; si falla algún archivo se informa cuáles. Solo reemplaza archivos de texto UTF-8 de hasta 2 MB. No se puede deshacer desde Pulso. Los filtros de inclusión son sencillos (sufijos como `*.ts` o fragmentos de ruta), no una implementación completa de glob. La búsqueda omite archivos binarios, no UTF-8 o mayores de 2 MB, y muestra como máximo 5.000 coincidencias. Los directorios excluidos están definidos en el código; no se aplica automáticamente todo `.gitignore`.

## Confiabilidad y recuperación

- Al guardar se compara la fecha de modificación conocida con la del disco. Si cambió, Pulso ofrece cancelar, cargar la versión del disco o sobrescribirla.
- El guardado normal escribe en un archivo temporal del mismo directorio y lo reemplaza; si no puede reemplazarlo, comunica el error. Los enlaces simbólicos existentes se resuelven hacia su destino.
- Los cambios sin guardar generan copias de recuperación aproximadamente cada segundo mientras hay ediciones. Al iniciar, Pulso permite restaurarlas, descartarlas o dejarlas para después. Los errores al actualizar una copia se muestran en la barra de estado.
- Al cerrar pestañas o la aplicación con cambios pendientes, Pulso pregunta qué hacer. Si se edita mientras hay un guardado en curso, el documento sigue marcado como pendiente.

Límites: un fallo antes de que termine la primera copia o entre actualizaciones puede perder las últimas ediciones. La comparación por fecha no garantiza detectar todos los cambios simultáneos, y existe una ventana entre comprobar y reemplazar. Las copias de recuperación contienen texto sin cifrar en los datos de la aplicación. El reemplazo masivo usa la misma escritura atómica y comprobación por fecha que el guardado normal, con sus mismos límites.

## Terminal integrada

La terminal utiliza xterm.js y un pseudoterminal nativo; admite procesos interactivos y varias pestañas. En Windows detecta las shells disponibles entre PowerShell, CMD, Git Bash y WSL. Permite elegir shell, copiar/pegar, limpiar, redimensionar el panel, ejecutar una selección y abrir una terminal en la carpeta del archivo activo. Puede proponer adaptar fuente, colores y shell a preferencias detectadas en VS Code o Windows Terminal.

## Inteligencia de proyecto: LSP

Pulso inicia un servidor local de TypeScript/JavaScript al abrir una carpeta. Ofrece diagnósticos, sugerencias, documentación al pasar el cursor, definiciones y referencias; sincroniza documentos abiertos y sus cambios sin guardar. Detecta extensiones TypeScript/JavaScript, incluidas variantes JSX/TSX. El proyecto puede aportar su propia configuración y versión de TypeScript.

Con `Ctrl` pulsado (`Cmd` en macOS) el cursor pasa a mano sobre las palabras y, cuando el servidor confirma que hay definición, se subraya; `Ctrl+clic` abre el archivo de destino. Si el servidor aún está arrancando, el primer `Ctrl+clic` espera a que termine en vez de perderse.

Se requiere Node.js 22.22.2 o posterior en `PATH`. La barra de estado muestra su estado («LSP: iniciando…», «LSP: activo» o «LSP: detenido»); al pulsarlo se explica el estado, con el motivo si se detuvo, y se puede reiniciar. Si el servidor falla, Pulso informa y vuelve a los servicios integrados de Monaco. Para reiniciarlo, abre la paleta y busca **Lenguaje: Reiniciar inteligencia de TypeScript y JavaScript**. El renombrado y las acciones de código aún no están conectados mediante LSP; el soporte de otros lenguajes requiere nuevos servidores.

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

Para repositorios privados se puede configurar un token en Ajustes. Pulso intenta guardarlo en el almacén de credenciales del sistema y migra el token de la ubicación antigua; si el almacén falla, se conserva en memoria durante la sesión.

## Personalización

Incluye temas de interfaz y sintaxis, colores de acento, configuración de la terminal y editor de atajos. Es posible importar temas de VS Code instalados o un archivo de tema JSON; esto no instala extensiones de VS Code.

## Atajos predeterminados

| Acción | Atajo |
| --- | --- |
| Abrir carpeta | `Ctrl+O` |
| Abrir archivo rápido | `Ctrl+P` |
| Paleta de comandos | `Ctrl+Shift+P` |
| Guardar / guardar todo | `Ctrl+S` / `Ctrl+Shift+S` |
| Buscar en el proyecto | `Ctrl+Shift+F` |
| Control de código fuente (Git) | `Ctrl+Shift+G` |
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
