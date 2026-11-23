# Componentes de terceros

Pulso se distribuye bajo la [licencia MIT](LICENSE). El instalador incluye los componentes siguientes, cada uno con su propia licencia. El texto completo de cada una está en la carpeta del paquete dentro de `node_modules` (o en el repositorio de cada proyecto).

## Interfaz y recursos incluidos

| Componente | Versión | Licencia | Uso en Pulso |
| --- | --- | --- | --- |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | 0.52 | MIT (con `ThirdPartyNotices.txt` propio) | Superficie de edición |
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`, `@xterm/addon-fit`) | 6.0 / 0.11 | MIT | Terminal integrada |
| [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) | 5.40 | MIT | Iconos del explorador |
| [Symbols Nerd Font Mono](https://github.com/ryanoasis/nerd-fonts) | — | MIT ([`src/assets/fonts/LICENSE-NerdFonts.txt`](src/assets/fonts/LICENSE-NerdFonts.txt)) | Símbolos de prompts en la terminal |
| [TypeScript](https://github.com/microsoft/typescript-go) (ejecutable nativo `@typescript/typescript-<plataforma>`) | 7.0 | Apache-2.0 (con `NOTICE.txt` propio) | Servidor de lenguaje (incluido en `lsp/typescript/`) |
| [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) | 6.1 | Apache-2.0 | Modo compatible del servidor de lenguaje (incluido en `lsp/`) |
| [Tauri](https://github.com/tauri-apps/tauri) (`@tauri-apps/api`, `tauri`, plugins) | 2 | MIT o Apache-2.0 | Aplicación de escritorio |

## Crates de Rust

El ejecutable enlaza unos 540 crates (contando los de todas las plataformas). Según `cargo metadata`, sus licencias son MIT, Apache-2.0, BSD-2/3-Clause, ISC, Zlib, Unicode-3.0, CC0, Unlicense, BSL-1.0, CDLA-Permissive-2.0 y MPL-2.0 (7 crates, sin modificar), todas compatibles con distribuir Pulso bajo MIT. Para ver la lista exacta:

```powershell
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --locked
```

## Programas externos que Pulso no incluye

Pulso ejecuta, si están instalados en el equipo, Node.js, Git, Claude Code, Codex y Gemini CLI. No forman parte del instalador y cada uno se rige por sus propios términos.
