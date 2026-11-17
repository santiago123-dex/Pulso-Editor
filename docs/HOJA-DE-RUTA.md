# Hoja de ruta y mejoras pendientes

Estas son propuestas, no funciones ya implementadas. El orden es una recomendación y puede cambiar según el uso de Pulso.

## Prioridad 1: confianza y pruebas en Windows

1. Probar el instalador y la aplicación instalada en un Windows limpio, con y sin Node, Git y WebView2 disponibles.
2. Ampliar pruebas de recuperación y guardado ante cierres inesperados, permisos, disco lleno, archivos grandes, enlaces y operaciones simultáneas.
3. Reducir la ventana sin copia de recuperación, avisar de fallos de manera persistente y evaluar límites de almacenamiento y privacidad de las copias.
4. Mejorar la detección de conflictos más allá de la fecha, y estudiar mecanismos que reduzcan la carrera entre comprobar y reemplazar. No prometer protección absoluta sin pruebas por plataforma.
5. Estudiar deshacer los reemplazos masivos (hoy hay revisión previa, escritura atómica y comprobación de cambios, pero no deshacer) y reemplazar también en documentos con cambios sin guardar.

## Prioridad 2: inteligencia de proyecto

1. Probar el cliente LSP dentro de la aplicación instalada con proyectos reales, archivos sin guardar, cambios de carpeta y reinicios del servidor.
2. Conectar renombrado, acciones de código, formato y ayuda de firma mediante LSP, respetando las capacidades que anuncie cada servidor.
3. Ya hay indicador de estado, motivo y reinicio en la barra; falta registro de salida del servidor, configuración y límites de recursos.
4. Diseñar un registro de servidores por lenguaje y carpeta antes de añadir Python, Rust u otros. Evaluar cómo distribuir o instalar servidores y cómo encontrar sus runtimes sin obligar a configurar cada proyecto manualmente.
5. Decidir si se distribuye un runtime compatible o se mantiene Node como requisito explícito para TypeScript/JavaScript.

La prueba `test:lsp:ui` ya comprueba una compilación de desarrollo en WebView2 con un alias, hover de símbolo y error, Ctrl+clic y reapertura del archivo. Falta verificar la versión instalada con proyectos reales y otros escenarios de Windows.

## Prioridad 3: Git y flujo de trabajo

1. Hecho: vista de diferencias, preparar/quitar y creación de commits (ver Funciones). Falta descartar cambios, preparar por fragmentos, push/pull y corregir el último commit.
2. Historial, cambio de rama y asistencia para conflictos.
3. Paginación y mejores filtros de issues; evaluar pull requests y relación entre un issue y los cambios locales.
4. Panel de problemas del proyecto, formateadores, linters, ejecución de pruebas y depuración para lenguajes prioritarios.

## Después

- Búsqueda que respete `.gitignore` y ofrezca filtros glob configurables.
- Rendimiento: ya hay medición (`npm run perf`, ver [Rendimiento](RENDIMIENTO.md)). Falta perfilar los picos al escribir en archivos muy grandes, acotar la memoria del servidor de lenguaje y medir en compilación de producción y con proyectos reales antes de fijar metas.
- Revisar la política CSP y acotar los comandos nativos expuestos a la interfaz para reducir el impacto de una eventual inyección de código.
- Perfiles, accesibilidad y pruebas de uso con distintos tamaños de ventana.
- Sistema de extensibilidad definido y acotado antes de prometer compatibilidad con extensiones de VS Code.
- Funciones de IA ligadas a un flujo concreto, por ejemplo issue → plan → cambios → revisión, con acciones visibles y reversibles.
- Distribución de versiones, actualizaciones y firma de instaladores cuando el proyecto esté preparado para entregarse a otras personas.
