# Rendimiento: cómo se mide y qué se midió

`npm run perf` mide la aplicación real mediante el puerto de depuración de WebView2 (igual que `npm run e2e`). Crea un proyecto sintético en una carpeta temporal, lo borra al terminar y restaura la sesión guardada. Solo muestra números; no falla por ningún umbral, porque todavía no hay metas definidas. `npm run perf -- --json` produce salida para máquinas. `PERF_FILES=N` cambia el número de archivos.

Qué mide: arranque hasta explorador listo (3 veces), apertura de archivos de 1 KB, 0,5 MB y 5 MB, latencia al escribir en el de 5 MB, pegado de 20.000 líneas, búsqueda en el proyecto, listado para abrir rápido, estado de Git y memoria (JavaScript y procesos de Pulso).

## Primera medición

Condiciones: compilación **de depuración** (sin optimizar), servidor de desarrollo, Windows 11, un solo equipo, proyecto sintético de 3.000 archivos TypeScript de 40 líneas más tres archivos grandes, repositorio Git nuevo. Son cifras de referencia para comparar cambios, no promesas.

| Medida | Resultado |
| --- | --- |
| Arranque hasta explorador listo | 0,75–0,9 s |
| Abrir archivo pequeño / 0,5 MB / 5 MB | 45–510 ms / 120–175 ms / 500–600 ms |
| Escribir en archivo de 5 MB (mediana / p95 / peor) | 35–38 ms / 145–175 ms / 350–490 ms antes del modo de archivo grande; después 37 ms / 75–110 ms / 400–700 ms (ver más abajo) |
| Pegar 20.000 líneas en archivo de 5 MB | 40–80 ms |
| Buscar un texto con 1 resultado (≈ 9 MB y 3.000 archivos) | 0,8–1,0 s |
| Buscar un texto con 5.000 resultados | 0,23–0,29 s |
| Listar 3.004 archivos para abrir rápido | 50–60 ms |
| Estado de Git (3.000 archivos sin seguimiento) | 140 ms |
| Memoria del JavaScript | 150–390 MB |
| Memoria de procesos | WebView2 ≈ 2 GB (7 procesos), Node ≈ 1,9 GB (servidor de lenguaje), Pulso ≈ 40 MB |

## Lo que reveló la medición

1. **Arranque de 12 s con copias de recuperación pendientes (corregido).** Si había copias sin recuperar, el aviso de recuperación esperaba la respuesta de la persona mientras la pantalla de carga seguía encima; solo desaparecía por el límite de 12 s. Ahora la pantalla se retira antes de mostrar el aviso. La prueba e2e lo comprueba.
2. **Un congelamiento que no era de Pulso.** Simular un pegado grande con `Input.insertText` de CDP congela Monaco más de 100 s, porque ese camino imita escritura y no un pegado. Con un evento de pegado real, 20.000 líneas tardan menos de 100 ms. La medición usa el evento de pegado. Queda sin comprobar si dictado o métodos de entrada que inserten bloques grandes sufren lo mismo.
3. **Escribir en archivos muy grandes tenía picos (mejorado, no resuelto).** Con 5 MB la mediana es buena (≈ 37 ms), pero el p95 rondaba 145–175 ms. El perfilador mostró que Monaco gastaba ≈ 30 % del tiempo de CPU buscando los corchetes que encierran el cursor, recorriendo el documento entero. Ahora, por encima de 1 millón de caracteres, se desactivan esa búsqueda, el resaltado de coincidencias y la coloración de pares de corchetes (ver «Archivos grandes» en Funciones). En tres pasadas del perfilador el p95 bajó a 75–110 ms; en una pasada completa de `npm run perf` dio 159 ms, así que la mejora es probable pero la medición es ruidosa. El peor caso sigue entre 400 y 700 ms: queda sin explicar. Sospechas sin confirmar: la copia de recuperación envía el texto completo cada segundo y el servidor de lenguaje procesa cada cambio.
4. **La memoria es alta con proyectos TypeScript grandes.** El servidor de lenguaje (Node) y WebView2 suman cerca de 4 GB en este proyecto sintético. Falta ver cuánto depende de los archivos de 5 MB y de los 3.000 archivos, y si hay que limitar recursos del servidor.
5. **La búsqueda lee todo el disco cada vez.** Es rápida con muchos resultados pero tarda cerca de 1 s si hay que recorrer todo y casi nada coincide.

## Límites de esta medición

- Compilación de depuración: una compilación de producción será más rápida, sobre todo Rust.
- Proyecto sintético: no se parece a un proyecto real (dependencias, historial de Git, archivos de tipos).
- Un solo equipo y pocas repeticiones; los rangos de la tabla son de varias pasadas, no estadística.
- No se midió consumo de CPU en reposo, batería ni arranque en frío tras reiniciar el sistema.

## Compilación de producción (versión instalada)

Misma medición contra la aplicación instalada, sin servidor de desarrollo: arranque 0,9–1,2 s; abrir 5 MB en 0,36 s; escribir en 5 MB 35 ms de mediana (p95 ≈ 185 ms, peor ≈ 370 ms, así que los picos no vienen del modo de depuración); pegado de 20.000 líneas 40 ms; buscar con un solo resultado 1,2 s (limitado por la lectura de disco, el análisis antivirus de Windows puede influir); memoria total ≈ 3,5 GB, con WebView2 ≈ 1,6 GB y el servidor de lenguaje ≈ 1,8 GB.

## Optimizaciones aplicadas (Frente I)

- **Retirado `ts.worker` de Monaco (−6,01 MB en `dist/assets/`):** al usar el servidor LSP propio de Pulso (TypeScript 7 nativo o compatible), se eliminó el worker duplicado de TypeScript de Monaco y su validación redundante en WebView2.
- **Límite de memoria del LSP (`src-tauri/src/lsp.rs`):** `GOMEMLIMIT=1536MiB` para TypeScript 7 nativo y `--max-old-space-size=1536` para el modo compatible Node (configurable con `PULSO_LSP_MAX_MB` entre 256 y 8192 MiB).
- **Archivos grandes (`src/largeFile.ts`, `src/docs.ts`):** además de desactivar corchetes/coincidencias, se desactivan `folding` y `links`, y las copias de recuperación pasan a un debounce de 8 s para no serializar varios MB en mitad de la escritura.
- **Búsqueda y listado rápido respetando `.gitignore` (`src-tauri/src/lib.rs`):** tanto `search_files` como `list_files` usan `ignore::WalkBuilder` con `.gitignore` y `.git/info/exclude`.
- **Revisión de Monaco y fuente de símbolos:** `index.js` queda en ~478 KB (~161 KB gzip); `monaco.js` (~3,9 MB) y `SymbolsNerdFontMono-Regular.ttf` (~2,6 MB) se conservan íntegros porque la terminal integrada depende de los glifos completos de Nerd Font y dividir `monaco-editor` internamente introduce chunks circulares en Rollup.
