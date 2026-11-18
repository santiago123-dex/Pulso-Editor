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

## Formas

- Radio 6-8 px en tarjetas, botones y cuadros de texto; etiquetas en píldora porque así lo marca la referencia y son lo único con esa forma.
- Sin sombras de «flotar» ni brillos: la elevación se marca con el tono de la superficie. Solo llevan sombra lo que de verdad está por encima (menús, cuadros de diálogo, la tarjeta que se arrastra).

## Dials

`Dial: ENERGY 1 / RHYTHM 2 / MOTION 1`

- **ENERGY 1:** es una herramienta de trabajo diario; la interfaz no debe competir con el código.
- **RHYTHM 2:** superficies consistentes con pocas rupturas deliberadas (tablero, chat, editor).
- **MOTION 1:** solo transiciones de estado (hover, foco, arrastre). Sin animaciones decorativas.

## Reglas de uso del acento

1. Un solo botón relleno con acento por superficie: la acción principal (Enviar, Crear, Guardar, Confirmar).
2. Las acciones secundarias son neutras (fondo de superficie y borde fino).
3. El acento nunca pinta el marco de la aplicación (barras, bandas, fondos).
