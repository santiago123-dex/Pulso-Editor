# Changelog

Todos los cambios notables en Pulso Editor se documentan en este archivo.

## [0.2.0] - 2026-11-23

### Añadido
- Asistente de IA con modelos locales mediante Ollama sin cuentas ni herramientas de terceros.
- Soporte para adjuntar imágenes al chat de IA (botón, pegado `Ctrl+V` y arrastrar/soltar) con visor ampliado (lightbox) y limpieza automática de imágenes huérfanas.
- Soporte para abrir proyectos en nuevas ventanas independientes (`Archivo → Abrir carpeta en nueva ventana…`).
- Memoria de pestañas y grupos abiertos por carpeta de proyecto.
- Aviso interactivo si hay un agente de IA respondiendo al cambiar o cerrar carpeta.
- Diagnóstico local con registro rotativo y comando `Ayuda: Copiar información de diagnóstico`.
- Inicio de sesión con GitHub mediante OAuth por código de dispositivo.
- Interfaz completa en español e inglés (incluyendo mensajes del backend en Rust y la CLI `pulso`).
- Servidor nativo de TypeScript 7 (`tsgo`) integrado sin dependencia obligatoria de Node.js.

### Corregido
- Al cambiar o cerrar proyecto se resetean por completo el chat de IA, búsqueda, Git/SCM, historial, PRs, tablero Kanban, visor de diff, historial Atrás/Adelante y pila de pestañas cerradas.
- Corregido el parpadeo/salto de la burbuja del asistente de IA durante respuestas en streaming.
- La cabecera de cada terminal integrada muestra su carpeta real (`cwd`) al cambiar de proyecto.
