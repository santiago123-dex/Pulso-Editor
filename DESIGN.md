# Dirección visual de Pulso Editor

Dirección dada por la persona dueña del producto. Esto es lo que se aplica; el filtro anti-slop va por encima.

## Identidad

- **Para quién:** programadores.
- **Cómo debe sentirse:** moderno, innovador, sencillo de ver y de usar.
- **Punto de partida:** el diseño actual gusta (estructura, tablero, chat), pero se prefieren los colores de la imagen de referencia (un tablero kanban en grafito neutro).

## Paleta (tomada de la imagen de referencia; valores aproximados)

Principio: **superficies de grafito neutro y color solo donde significa algo** (estado, etiqueta, acción principal). Nada de colores en el marco de la aplicación.

| Papel | Valor | Razón |
|---|---|---|
| Fondo de ventana / actividad | `#0e0e0f` / `#111111` | La referencia es casi negra y sin tinte. |
| Editor | `#151515` | Una superficie más clara que el marco, sin morado ni azul de fondo. |
| Barra lateral | `#191919` | Separa el panel del editor sin necesitar un borde grueso. |
| Bordes | `#2a2a2a` | Líneas finas, las justas para separar. |
| Tarjetas / hover | `#232323` | Tarjeta algo más clara que la columna, como en la referencia. |
| Selección | `#2d2d2d` | Estado seleccionado neutro. |
| Texto | `#e8e8e8` / secundario `#8a8a8a` | Contraste AA sobre las superficies (el secundario supera 5:1). |
| Acento único | `#5b9cf5` | El azul de «En curso» de la referencia: un solo acento, para la acción principal, el foco y el elemento activo. |
| Estados del tablero | gris `#85878a`, azul `#609cff`, amarillo `#e9bc43`, morado `#b27bf1` | Los puntos de «Por hacer / En curso / En revisión / Hecho» de la referencia. El morado queda solo como estado «Hecho» y en la sintaxis. |
| Etiquetas de issues | color de la etiqueta de GitHub, **mezclado al 23 % con el fondo** y borde al 45 % | Etiquetas legibles y discretas, como en la referencia. |

La barra de estado deja de ser una banda de color: usa el color de la barra de actividad con texto secundario, como en la referencia.

## Tipografía

- Interfaz: Segoe UI Variable (la de Windows 11) con respaldo en Segoe UI. Razón: es la fuente nativa del sistema donde corre Pulso, no añade archivos y se ve limpia a 12-13 px.
- Código y datos técnicos (repositorio, rutas, números de issue): la fuente monoespaciada del editor. Razón: son datos para copiar y comparar.

## Profundidad (actualizado el 22/11/2026)

La persona dueña pidió que Pulso deje de verse plano y parecido al resto de editores, que se vea más pulido, con movimiento moderado, manteniendo el azul. Eligió delegar la personalidad: **esta sección es una propuesta del agente** y, como tal, tiende a gustos por defecto; corrígela con lo que no te convenza.

- **Marco y hojas.** Barra de título, barra de actividad y barra de estado forman un solo marco oscuro (`--activity`), sin bordes entre ellas. La barra lateral y el editor son **hojas** con esquinas de 10 px, separadas del marco por 6 px. Razón: la jerarquía se lee por profundidad y no por líneas; es la diferencia más visible con la retícula de paneles pegados de los demás editores.
- **Luz arriba.** Cada hoja lleva una línea de luz de 1 px en el borde superior (`--edge-light`) y una sombra baja y difusa (`--sheet-drop`). Razón: la sombra marca que la hoja está por encima del marco (elevación real), y la luz superior da volumen sin degradados.
- **Baldosas.** El elemento activo de la barra de actividad es una baldosa con la misma luz, y su icono toma el acento; no hay franjas laterales de color. Razón: repetir el gesto de la hoja en pequeño.
- **Pestañas.** La pestaña activa sale de la hoja del editor como una lengüeta; en el grupo con el foco, su luz superior es azul. Razón: dice dónde se escribe sin pintar barras.
- **Motivo: el pulso.** El trazo del logotipo (un latido) es el indicador de que la IA trabaja: late mientras trabaja y se queda quieto al terminar. Ya se usaba para el latido de la barra de título al guardar. Razón: un gesto propio del nombre del producto, repetido, que además informa.
- Todo se deriva de las variables del tema (`--fg`, `--activity`, `--editor`, `--sidebar`), así que funciona con los temas importados.

## Formas

- Radio 10 px en hojas, 8 px en botones, pestañas y tarjetas de la IA, 7 px en controles pequeños; las píldoras solo para etiquetas y estados.
- Sombra solo en lo que está por encima: las hojas, los menús, los cuadros de diálogo y la tarjeta que se arrastra.

## Asistente de IA

- Cada respuesta tiene **una sola tarjeta de actividad, plegada**: el pulso, «Trabajando» con los segundos en vivo y la acción actual. Al terminar dice «Trabajó 40 s · 3 archivos leídos · 1 edición». Desplegada, muestra una línea de tiempo con los pasos, los razonamientos y los textos intermedios. La respuesta final queda fuera, legible. Razón: la persona quiere saber que trabaja sin leer cada paso.
- El mensaje de la persona va a la derecha en una hoja tintada de azul; quién habla se lee por la posición, sin etiquetas «#01 · TÚ».
- Sin fondo de puntos por defecto (sigue disponible en Apariencia) y sin rótulos en monoespaciada mayúscula: las etiquetas van en frase.

## Dials

`Dial: ENERGY 2 / RHYTHM 2 / MOTION 2`

- **ENERGY 2:** sigue siendo una herramienta de todo el día, pero con presencia: profundidad, luz y un motivo propio.
- **RHYTHM 2:** superficies consistentes con pocas rupturas deliberadas (tablero, chat, editor).
- **MOTION 2:** transiciones cortas con propósito: cambiar de vista (fundido de 180 ms), desplegar la actividad, llegar un mensaje nuevo y el pulso mientras la IA trabaja. Nada decorativo en bucle salvo el pulso, que informa. Con «reducir movimiento» del sistema se desactiva todo.

## Reglas de uso del acento

1. Un solo botón relleno con acento por superficie: la acción principal (Enviar, Crear, Guardar, Confirmar).
2. Las acciones secundarias son neutras (fondo de superficie y borde fino).
3. El acento nunca pinta el marco de la aplicación (barras, bandas, fondos).
