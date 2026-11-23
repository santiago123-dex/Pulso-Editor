# Hoja de ruta y mejoras pendientes

Estas son propuestas, no funciones ya implementadas. El orden es una recomendación y puede cambiar según el uso de Pulso. Lo necesario para publicar Pulso, con su orden, está en el [Plan para publicar](PLAN-LANZAMIENTO.md).

## Prioridad 1: confianza y pruebas en Windows

1. Probar el instalador y la aplicación instalada en un Windows limpio, con y sin Node, Git y WebView2 disponibles. Ya se probó en el equipo de desarrollo, con y sin Node y Git en el `PATH` (ver [Distribución](DISTRIBUCION.md)); falta un Windows limpio, el MSI y la firma. La CSP ya está acotada (solo scripts propios, conexiones a la API de GitHub y avatares de GitHub).
2. Ampliar pruebas de recuperación y guardado ante cierres inesperados, permisos, disco lleno, archivos grandes, enlaces y operaciones simultáneas.
3. Hecho: las copias pendientes se escriben al perder el foco. Falta avisar de fallos de manera persistente y evaluar límites de almacenamiento y privacidad de las copias.
4. Hecho: un cambio de fecha con el mismo contenido ya no se trata como conflicto. Falta mostrar las diferencias al resolver un conflicto, y estudiar mecanismos que reduzcan la carrera entre comprobar y reemplazar. No prometer protección absoluta sin pruebas por plataforma.
5. Estudiar deshacer los reemplazos masivos (hoy hay revisión previa, escritura atómica y comprobación de cambios, pero no deshacer) y reemplazar también en documentos con cambios sin guardar.

## Prioridad 2: inteligencia de proyecto

1. Probar el cliente LSP dentro de la aplicación instalada con proyectos reales, archivos sin guardar, cambios de carpeta y reinicios del servidor.
2. Hecho: renombrado (F2) y panel de problemas de los archivos abiertos. Falta conectar acciones de código, formato y ayuda de firma mediante LSP, respetando las capacidades que anuncie cada servidor, y analizar el proyecto completo, no solo lo abierto.
3. Ya hay indicador de estado, motivo y reinicio en la barra; falta registro de salida del servidor, configuración y límites de recursos.
4. Diseñar un registro de servidores por lenguaje y carpeta antes de añadir Python, Rust u otros. Evaluar cómo distribuir o instalar servidores y cómo encontrar sus runtimes sin obligar a configurar cada proyecto manualmente.
5. Hecho: el servidor nativo de TypeScript 7 viene incluido y no necesita Node. Node solo hace falta en el modo compatible, para proyectos con TypeScript 5 o 6.

La prueba `test:lsp:ui` ya comprueba una compilación de desarrollo en WebView2 con un alias, hover de símbolo y error, Ctrl+clic y reapertura del archivo. Falta verificar la versión instalada con proyectos reales y otros escenarios de Windows.

## Prioridad 3: Git y flujo de trabajo

1. Hecho: vista de diferencias, preparar/quitar, commits, ramas, descartar, push y pull, historial (de todo el repositorio y de un archivo) y culpa en línea (ver Funciones). Falta preparar por fragmentos, corregir el último commit y probar push/pull contra un remoto real con autenticación.
2. Hecho: historial y culpa en línea, y pull requests (lista, detalle con diferencias y crear). Falta borrar y renombrar ramas, merge/rebase, asistencia para conflictos, y en las pull requests: fusionar, revisar, comentar, resultados de comprobaciones y forks.
3. Tablero kanban hecho (ver Funciones; probado solo contra un GitHub simulado): faltan probarlo con GitHub real, columnas personalizadas o GitHub Projects, orden dentro de la columna, comentarios y asignados editables, y webhooks para sincronizar al instante. Además, paginación y filtros del listado lateral de issues, pull requests y la relación entre una issue y los cambios locales.
4. Hecho: panel de problemas de los archivos abiertos, formateo por LSP y ejecución de scripts de package.json. Falta analizar el proyecto completo, formateadores y linters externos (Prettier, ESLint), una vista de resultados de pruebas y depuración.

## Después

- Búsqueda que respete `.gitignore` y ofrezca filtros glob configurables.
- Rendimiento: ya hay medición (`npm run perf`, ver [Rendimiento](RENDIMIENTO.md)). Falta perfilar los picos al escribir en archivos muy grandes, acotar la memoria del servidor de lenguaje y medir en compilación de producción y con proyectos reales antes de fijar metas.
- Hecho: política CSP estricta. Falta acotar los comandos nativos de archivos (hoy aceptan cualquier ruta, como cualquier editor local) para reducir el impacto de una eventual inyección de código.
- Perfiles, accesibilidad y pruebas de uso con distintos tamaños de ventana.
- Sistema de extensibilidad definido y acotado antes de prometer compatibilidad con extensiones de VS Code.
- Hecho: asistente de IA con Claude Code (ver Funciones). Falta Codex y otros proveedores, claves de API propias, aprobar permisos desde Pulso, mostrar los cambios propuestos como diferencias antes de aplicarlos, adjuntar issues, pull requests y diffs, y flujos como issue → plan → cambios → revisión.
- Hecho: licencia MIT, avisos de terceros, CI y un flujo que genera los instaladores en un borrador de release (ver [Distribución](DISTRIBUCION.md)). Falta firmar los instaladores, las actualizaciones automáticas, macOS y separar el identificador de la versión de desarrollo del de la instalada.
