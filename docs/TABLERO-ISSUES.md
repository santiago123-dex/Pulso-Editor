# Issues y tablero de Pulso

En **Issues**, el botón con el signo **+** abre el formulario para crear una issue. El botón de tablero permite ver las issues agrupadas. Dentro del tablero, **Nueva issue**, el signo **+** de una columna o el área vacía de esa columna abren el formulario. También puedes hacer clic en una tarjeta para editarla y arrastrarla entre columnas. Con el teclado, enfoca una tarjeta y pulsa Intro o Espacio para editarla.

El tablero representa las issues de GitHub mediante etiquetas y el estado abierto/cerrado; no modifica un proyecto de GitHub Projects:

- **Por hacer:** issue abierta sin las etiquetas de estado.
- **En curso:** issue abierta con la etiqueta de progreso configurada en Pulso (por defecto `in progress`).
- **En revisión:** issue abierta con la etiqueta `pulso: in review`. Tiene prioridad sobre la etiqueta de progreso si están ambas.
- **Hecho:** issue cerrada. Volver a una columna abierta la reabre.

Al crear una issue en curso o en revisión, o mover una tarjeta a esas columnas, Pulso crea la etiqueta correspondiente en GitHub si todavía no existe. Es necesario un token con acceso al repositorio y permiso de lectura y escritura de issues. Si no se puede crear la etiqueta o actualizar la issue, Pulso informa el error; después de un fallo al mover vuelve a consultar el estado real. No configures `pulso: in review` como etiqueta de progreso: ambas columnas necesitan etiquetas distintas.

En un repositorio privado cada integrante debe tener acceso al repositorio y configurar su propio token. Las políticas de la organización pueden exigir su aprobación o autorización SSO. La guía [Chat del repositorio](CHAT-REPOSITORIO.md) explica cómo preparar el acceso privado; los mismos permisos de issues permiten trabajar con el tablero.
