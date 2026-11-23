# Plan para publicar Pulso

Resultado de una revisión completa del proyecto hecha el 22/11/2026: qué falta para entregarlo al público, qué hay que arreglar, qué funciones añadir y cómo depender menos de servicios de terceros. Complementa la [Hoja de ruta](HOJA-DE-RUTA.md), que recoge los pendientes de cada área. Las casillas marcadas ya están hechas.

Estado de partida:
- Pruebas: 436 de TypeScript y 126 de Rust. Las de TypeScript pasan todas.
- Las dos pruebas de Ctrl+C de la terminal fallan cuando las lanza una herramienta automatizada, pero pasan en una terminal normal (ver «Arreglos»).
- `tsc` no da errores.

Puntos fuertes:
- Una CSP estricta.
- Archivos limitados a la carpeta de trabajo (`fsguard`).
- Escritura atómica y copias de recuperación.
- Tokens guardados en el almacén de credenciales del sistema.
- Una documentación honesta sobre lo que no se ha probado.

## 1. Fase 0: imprescindible antes de publicar

- [x] **Licencia.** MIT en [`LICENSE`](../LICENSE), declarada en `package.json`, `Cargo.toml` y `tauri.conf.json`.
- [x] **Avisos de terceros.** Están en [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). Los 539 crates de Rust tienen licencias compatibles con MIT.
- [x] **Integración continua.** `.github/workflows/ci.yml` ejecuta en Windows y Ubuntu las pruebas TypeScript y Rust, `tsc` con la compilación web y la prueba del arranque del LSP. Todavía no se ha ejecutado en GitHub.
- [x] **Flujo de publicación.** `.github/workflows/release.yml` genera el instalador NSIS y los paquetes .deb, .rpm y AppImage al subir una etiqueta `vX.Y.Z`, y los deja en un borrador de release del repositorio público de releases. Todavía no se ha ejecutado (ver [Distribución](DISTRIBUCION.md)).
- [ ] **Firma del instalador.** Sin firma, SmartScreen avisa de «aplicación no reconocida» y mucha gente no la instala. Opciones:
  - **SignPath:** gratis para proyectos de código abierto.
  - **Azure Trusted Signing:** de pago, con una cuota mensual baja.
- [x] **Actualizaciones automáticas.** Usan `tauri-plugin-updater`, `latest.json` en GitHub Releases y paquetes firmados (ver [Distribución](DISTRIBUCION.md)). Para que funcionen faltan tres cosas:
  - [ ] guardar los secretos de la clave en GitHub;
  - [x] publicar las releases en un repositorio público aparte ([Pulso-Editor-releases](https://github.com/santiago123-dex/Pulso-Editor-releases)), porque este es privado;
  - [ ] crear el secreto `RELEASES_TOKEN` con un token limitado a ese repositorio;
  - [ ] probar una actualización real entre dos versiones.
- [x] **WebView2 garantizado.** El instalador ya lo instalaba si faltaba: es lo que hace Tauri por defecto, descargando el instalador de Microsoft sin preguntar. Ahora está fijado de forma explícita en `tauri.conf.json` (`downloadBootstrapper`). Necesita internet. Si hiciera falta instalar sin conexión, se puede publicar un segundo instalador con `offlineInstaller`, unos 127 MB más grande. Falta comprobarlo en un Windows sin WebView2 (punto siguiente).
- [ ] **Probar en un Windows limpio**, en una máquina virtual sin Node, Git ni WebView2: instalar, abrir, desinstalar.
- [x] **Separar desarrollo y producción.** Las compilaciones de desarrollo usan el identificador `dev.pulso.editor.dev` y ya no comparten datos con la instalada (ver [Distribución](DISTRIBUCION.md)).
- [ ] **Documentos para el público:**
  - un README pensado para quien instala, con capturas y enlace de descarga;
  - `CHANGELOG.md`;
  - `CONTRIBUTING.md`;
  - una plantilla para reportar errores;
  - una nota de privacidad: qué envía la IA a su proveedor, qué se publica en GitHub y qué se guarda sin cifrar en el equipo.
- [ ] **Diagnóstico local.** Un registro en archivo (con rotación) y un comando «Copiar información de diagnóstico»: versión, sistema, estado del LSP y de Git, sin datos personales. No hace falta ningún servicio externo de errores.

## 2. Arreglos detectados en la revisión

- [ ] **Chat del equipo y notificaciones.** Cada mensaje es un comentario en una issue, así que GitHub probablemente envía un correo a cada persona suscrita a esa issue, en cada mensaje. Hay que comprobarlo con dos cuentas reales antes de promocionar la función. Si se confirma, hay que avisarlo en la interfaz o cambiar de transporte (ver sección 4).
- [ ] **Terminal: fin de sesión antes de tiempo.** En `src-tauri/src/term.rs`, `drop(reader_done)` no espera a que el hilo lector termine, aunque el comentario lo diga: soltar un `JoinHandle` no lo une. El aviso de salida puede llegar antes que las últimas líneas de la shell. La solución no es un simple `join()`, porque con ConPTY el lector puede no recibir el fin de datos hasta que se cierra el maestro. Hay que esperar con un tiempo límite o cerrar el maestro antes.
- [ ] **Pruebas de Ctrl+C.** `ctrl_c_interrupts_a_running_command_in_shell` y `ctrl_c_interrupts_powershell_command` fallan cuando el proceso que las lanza no entrega Ctrl+C a la consola nueva. Desde la terminal de Pulso o desde PowerShell pasan. Si también fallan en los servidores de GitHub, se pueden marcar para saltarlas en la CI con una variable de entorno, sin quitarlas.
- [ ] **Archivos demasiado grandes.** Dividirlos por responsabilidad facilitaría revisarlos y probarlos:

  | Archivo | Líneas |
  | --- | --- |
  | `src/aiChat.ts` | 2082 |
  | `src-tauri/src/aichat.rs` | 1352 |
  | `src-tauri/src/bin/pulso.rs` | 1289 |
  | `src-tauri/src/gitops.rs` | 1124 |
  | `src-tauri/src/lib.rs` | 1044 |

- [ ] **Almacenamiento repartido.** Diez módulos usan `localStorage` directamente, aunque existe `src/core/storage.ts`. Centralizarlo facilita las migraciones, los límites de tamaño y las pruebas.
- [ ] **Interfaz solo en español.** Todos los textos están escritos directamente en el código. Para llegar a más público hace falta una capa de traducciones, como mínimo en español e inglés, y un selector de idioma.

## 3. Funciones nuevas

### Para la primera versión pública
- **Asistente de bienvenida** la primera vez: abrir una carpeta, detectar Node y Git, conectar GitHub y elegir tema.
- **Más lenguajes.** Un registro de servidores por lenguaje (pyright para Python, rust-analyzer para Rust, gopls para Go) que Pulso descargue y actualice solo.
- **IA:**
  - ver los cambios propuestos como diferencias y aceptarlos o rechazarlos antes de aplicarlos;
  - aprobar desde Pulso los permisos que pide la herramienta;
  - mencionar archivos con `@`;
  - adjuntar issues, pull requests y diffs como contexto.
- **Git:**
  - preparar por fragmentos;
  - corregir el último commit;
  - borrar y renombrar ramas;
  - merge y rebase;
  - resolver conflictos a tres bandas.
- **Problemas de todo el proyecto**, no solo de los archivos abiertos.
- **Vista previa** de Markdown e imágenes.

### Para la versión 1.0
- **Depurador** mediante el protocolo DAP: puntos de interrupción, variables, pila y consola. Es lo que más falta para competir con otros editores.
- **Vista de pruebas:** detectar y ejecutar pruebas y mostrar los resultados por archivo.
- **Autocompletado de IA en línea** (texto fantasma mientras se escribe).
- **Extensiones:** una API propia y acotada, por ejemplo con plugins WASM aislados, antes de prometer compatibilidad con extensiones de VS Code.
- **Git avanzado:** grafo de ramas, búsqueda en el historial, revisar y comentar pull requests, y ver el resultado de sus comprobaciones.
- **Trabajar en remoto:** WSL, SSH y contenedores.
- **Accesibilidad:** navegación completa con teclado, lector de pantalla y alto contraste.

## 4. Depender menos de terceros

| Dependencia actual | Riesgo | Propuesta |
| --- | --- | --- |
| CLIs de Claude Code, Codex y Gemini | Su formato de salida cambia entre versiones (solo se probó con Claude Code 2.1.304). Gemini ya no funciona con cuentas personales | **Agente propio en Rust.** El ciclo de herramientas (leer, buscar, editar con diferencias que se aprueban) vive en Pulso, y el modelo es intercambiable: API de Anthropic u OpenAI con clave propia, cualquier API compatible con OpenAI y **modelos locales con Ollama o llama.cpp**, que no dependen de nadie. Las CLIs actuales quedan como un proveedor más |
| Node.js en el PATH para el LSP | Es el mayor obstáculo al instalar: sin Node no hay inteligencia de TypeScript | Incluir Node en el instalador (unos 30 MB más), o evaluar **`tsgo`**, el TypeScript nativo de Microsoft, que no necesita Node. Hay que comprobar si ya es estable |
| Ejecutable `git` | Sin Git instalado, el panel no funciona | Usar `gix` o `git2` para estado, historial, culpa y diferencias, y dejar `git` solo para push y pull. O incluir MinGit en Windows |
| Git Credential Manager para conectar GitHub | Depende de lo que tenga instalado cada equipo | Hacer el inicio de sesión de GitHub desde Pulso con OAuth por código de dispositivo. Registrar la aplicación OAuth es gratis y no hace falta servidor |
| GitHub para issues, pull requests, tablero y chat | Sin GitHub no funciona nada de eso. Hay límites de la API, consultas cada 4 s y el posible problema de notificaciones del chat | Generalizar el contrato que ya existe (`ChatStore`) en una capa de proveedores: GitHub, GitLab y **Gitea o Forgejo, que se pueden alojar en un servidor propio**. Además, un **tablero local** guardado en el repositorio (`.pulso/board.json`) que funcione sin conexión ni cuenta |
| Chat en tiempo real | Con issues de GitHub no puede ser instantáneo | Exige un servidor propio. Puede ser un relé pequeño en Rust con WebSocket que cada equipo aloje, y la interfaz no cambiaría |
| Monaco, xterm, WebView2, almacén de credenciales | Riesgo bajo: licencia MIT o componentes del propio sistema | Mantenerlos |

## 5. Orden recomendado

1. **Terminar la Fase 0:**
   - subir la CI y comprobar que pasa en GitHub;
   - separar el identificador de desarrollo;
   - WebView2 garantizado;
   - actualizaciones automáticas;
   - firma;
   - prueba en un Windows limpio.
2. **Beta pública:**
   - traducciones;
   - ~~incluir Node o adoptar `tsgo`~~ hecho: TypeScript 7 nativo incluido;
   - inicio de sesión OAuth propio;
   - agente propio con modelos locales;
   - diferencias antes de aplicar los cambios de la IA;
   - asistente de bienvenida.
3. **Versión 1.0:**
   - depurador;
   - más lenguajes;
   - Git avanzado;
   - extensiones;
   - proveedores además de GitHub.
