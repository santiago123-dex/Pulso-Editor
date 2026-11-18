# Chat del equipo

Chat de grupo para las personas de un repositorio de GitHub, dentro de Pulso. Se abre con el icono de mensajes de la barra de actividad (con una insignia cuando hay mensajes nuevos) como una vista más de la barra lateral. El botón de la esquina de la cabecera lo pasa a **pantalla completa** (con la lista de personas a la derecha); `Esc` o el mismo botón lo devuelven a la barra lateral, y Pulso recuerda la elección. En la barra lateral la lista de personas se despliega con el botón de personas.

## Cómo funciona

- **Sin configurar nada.** Pulso usa la cuenta de GitHub conectada (botón **Conectar con GitHub**, o el que aparece en el propio chat). No hay que pegar tokens ni compartir números de issue.
- **Una sala por repositorio.** La sala es una issue con la etiqueta `pulso-chat` y el título «💬 Chat de Pulso». Todas las personas que abran el chat en ese repositorio encuentran la misma sala solas (si por error hubiera varias, todas eligen la más antigua).
- **Crear la sala.** Si el repositorio aún no tiene chat, se ofrece **Crear el chat del equipo**, tras una confirmación que explica que se crea una issue con esa etiqueta y quién podrá verla. Basta con que una persona lo haga.
- **Cada mensaje es un comentario** de esa issue, publicado con tu cuenta.

## Qué ofrece

- Burbujas con avatar y nombre; los mensajes seguidos de la misma persona se agrupan; separadores «Hoy / Ayer / fecha»; hora al pie de cada grupo.
- **Enter** envía, **Mayús+Enter** salta de línea. El mensaje aparece al instante como «Enviando…» y, si falla, queda con **Reintentar**.
- **Panel de personas** a la derecha: colaboradores del repositorio (o contribuyentes, claramente marcados, si GitHub no deja ver los colaboradores), con «escribió hace…». Pulsar a una persona escribe su @mención. Quien escribió pero no aparece en la lista también se muestra.
- **Menciones**: al escribir `@` se ofrecen las personas (↑ ↓, Enter o Tab). Las menciones se resaltan; las que te nombran a ti llevan una marca.
- **Enlaces** `http(s)` se abren en el navegador del sistema.
- **Mensajes nuevos**: con el chat abierto se consulta GitHub cada 4 s (solo con la ventana visible), usando ETag, de modo que sin cambios la consulta no gasta cuota de la API. Si no estás al final de la conversación aparece «↓ Mensajes nuevos». Con el chat cerrado se consulta cada 45 s y la insignia cuenta los mensajes de otras personas que no has leído.
- Cada 5 minutos se relee la conversación completa para reflejar mensajes editados o borrados en GitHub.

## Límites

- **No es tiempo real**: los mensajes llegan en unos segundos, no al instante. No hay indicador de «escribiendo», presencia en línea ni confirmaciones de lectura.
- **Privacidad**: los mensajes tienen la visibilidad del repositorio. En un repositorio público cualquiera puede leerlos; en uno privado, cualquiera con acceso a esa issue, incluidas las personas administradoras. **No son mensajes directos ni grupos privados.** No publiques contraseñas ni tokens. Quien tenga permisos puede editarlos o borrarlos en GitHub.
- Se muestran los últimos 500 mensajes; el historial completo está en la issue de GitHub (botón **Ver en GitHub**). Los mensajes se muestran como texto: no se interpreta Markdown (salvo @menciones y enlaces).
- Máximo 4000 caracteres por mensaje. GitHub puede limitar la frecuencia de consultas y de comentarios.
- Si la issue de la sala se cierra o se borra en GitHub, el chat lo detecta en unos 30 segundos y ofrece crear otra. Mejor no cerrarla ni borrarla. La sala no aparece en el tablero ni en la lista de issues.
- Probado contra un GitHub simulado y con el aspecto revisado en la aplicación; **no se ha probado con dos personas reales** en un repositorio de GitHub.

## Repositorios privados

Cada integrante debe tener acceso al repositorio (invitación aceptada) y conectar su propia cuenta. Si la organización usa SAML SSO, puede ser necesario autorizar la sesión. Un 404 suele significar que la cuenta conectada no tiene acceso; un 403, permisos insuficientes o límites de GitHub.

## Para desarrolladores

El contrato `ChatStore` (`src/repoChatApi.ts`) separa la interfaz del almacenamiento en GitHub. La lógica pura (agrupar, menciones, no leídos) está en `src/chatModel.ts` con pruebas. Un servicio propio de chat (tiempo real, mensajes directos, presencia) necesitaría autenticación, autorización, almacenamiento y conexiones propios; la interfaz no tendría que cambiar.
