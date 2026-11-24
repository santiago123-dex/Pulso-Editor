# Sistema de extensiones de Pulso Editor

Pulso Editor adopta una **API de extensiones declarativa y acotada** basada en `manifest.json`, diseñada para aportar valor inmediato sin ejecutar código arbitrario de terceros en la primera versión.

## Principios de diseño (v1)

1. **Sin ejecución de código arbitrario de terceros:** en esta primera versión una extensión no carga JavaScript ni binarios nativos dentro de la ventana ni del backend.
2. **Validación estricta del manifiesto:** toda extensión debe pasar validación de identificador (`^[a-z0-9][a-z0-9._-]{1,63}$`), versión semántica (`X.Y.Z`), permisos conocidos y rutas relativas sin `..`.
3. **Permisos explícitos antes de instalar:** cada extensión declara los permisos que necesita y la pantalla de instalación los muestra claramente antes de copiarla a la carpeta del usuario.
4. **Carpeta del usuario:** las extensiones instaladas viven en `%APPDATA%/dev.pulso.editor/extensions/<id>/` (Windows) o `~/.config/dev.pulso.editor/extensions/<id>/` (Linux/macOS), y su estado activo/inactivo se guarda en `extensions-state.json`.

## Qué pueden aportar las extensiones declarativas

- **Temas (`contributes.themes`):** archivos JSON de tema relativos a la carpeta de la extensión.
- **Fragmentos (`contributes.snippets`):** definiciones declarativas de snippets por lenguaje.
- **Comandos (`contributes.commands`):** accesos rápidos que proponen ejecutar un script/comando (requieren permiso `terminal` y aprobación del usuario).
- **Servidores de lenguaje (`contributes.languageServers`):** declaración de un servidor LSP adicional para un lenguaje concreto (requieren permiso `terminal` y/o `files`).

## Permisos declarables

| Permiso | Significado |
| --- | --- |
| `files` | Leer o aportar archivos dentro del proyecto (temas, fragmentos, análisis). |
| `network` | Realizar consultas de red externas (si el servidor o recurso lo requiere). |
| `terminal` | Proponer comandos de terminal o iniciar un servidor de lenguaje externo. |

## Ejemplo de `manifest.json`

```json
{
  "id": "pulso.tema-aurora",
  "name": "Tema Aurora",
  "version": "1.0.0",
  "description": "Paleta oscura de alto contraste para Pulso Editor.",
  "author": "Comunidad Pulso",
  "permissions": ["files"],
  "contributes": {
    "themes": [
      { "id": "aurora-dark", "label": "Aurora Dark", "path": "themes/aurora.json" }
    ],
    "snippets": [],
    "commands": [],
    "languageServers": []
  }
}
```

## Cómo crear y probar tu propia extensión

El repositorio incluye una extensión declarativa completa lista para instalar en `examples/extension-ejemplo/`:

```text
examples/extension-ejemplo/
├── manifest.json
├── themes/aurora.json
└── snippets/typescript.json
```

### Paso a paso

1. Crea una carpeta nueva con un archivo `manifest.json` válido (`id` en minúsculas de 2 a 64 caracteres, versión semántica `X.Y.Z` y permisos mínimos necesarios).
2. Añade tus recursos (temas en `themes/*.json` o fragmentos en `snippets/*.json`) usando siempre rutas relativas sin `..`.
3. Abre la vista **Extensiones** en la barra lateral de Pulso Editor y pulsa **`+` (Instalar desde carpeta…)**.
4. Selecciona la carpeta de tu extensión (por ejemplo `examples/extension-ejemplo`).
5. Revisa el diálogo de permisos solicitados y pulsa **«Conceder permisos e instalar»**.
6. La extensión aparecerá en la lista con sus badges de permisos y podrás **Desactivar**, **Activar** o **Desinstalar** en cualquier momento.

## Decisión sobre plugins WASM aislados (futuro)

Se **pospone el soporte de plugins WASM aislados para una fase posterior (v2)** por tres motivos:
- Validar primero la ergonomía del formato declarativo y los puntos de contribución reales que necesita la comunidad.
- Evitar añadir un runtime WASM (~5–10 MB en el binario) antes de fijar la superficie de host-functions y capacidades WASI.
- Cuando se incorporen, deberán correr en un sandbox sin acceso directo al sistema de archivos ni red salvo los permisos ya modelados en `manifest.json`.
