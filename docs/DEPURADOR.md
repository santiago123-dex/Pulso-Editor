# Depurador integrado (DAP)

Pulso Editor incluye un cliente nativo del **Debug Adapter Protocol (DAP)** en Rust conectado al editor Monaco y a una vista dedicada en la barra lateral.

## Arquitectura

- **Backend Rust:**
  - `src-tauri/src/dap.rs`: framing `Content-Length`, correlación de peticiones/respuestas por `seq`, hilo lector de eventos (`dap-event`) y gestión del ciclo de vida con `procguard` (`configure_child`, `attach_job`, `kill_tree`) para no dejar procesos huérfanos.
  - `src-tauri/src/dap_config.rs`: lector JSON/JSONC de `.pulso/launch.json` y respaldo `.vscode/launch.json`, expansión de variables (`${workspaceFolder}`, `${file}`, `${fileBasename}`), detección del adaptador y comprobación de confianza (`trusted-folders.json`).
- **Frontend TypeScript:**
  - `src/debugModel.ts`: estado puro de puntos de interrupción, persistencia mediante `src/core/storage.ts` y consola de depuración.
  - `src/debugView.ts` + `src/debug.css`: margen de puntos de interrupción y línea activa en Monaco, vista lateral `#view-debug` (barra de control, variables expandibles, pila de llamadas, puntos de interrupción y consola con evaluación `evaluate`).

## Primer lenguaje soportado de punta a punta: Python (`debugpy`)

1. Instala `debugpy` en el entorno de Python del proyecto (o global):
   ```bash
   pip install debugpy
   ```
2. Pulso busca primero `.venv` / `venv` dentro del espacio de trabajo y después `python` / `python3` en el `PATH`, lanzando `python -m debugpy.adapter` por entrada/salida estándar.
3. Si abres un archivo `.py` y no tienes `launch.json`, Pulso ofrece automáticamente **«Python: Archivo actual»**.

## Configuración por proyecto (`.pulso/launch.json`)

Puedes pulsar el botón de configuración en la vista **Depurador** para crear `.pulso/launch.json`. Si el proyecto ya tiene `.vscode/launch.json` (incluso con comentarios `//` o comas finales), Pulso también lo lee automáticamente.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: Archivo actual",
      "type": "python",
      "request": "launch",
      "program": "${file}",
      "cwd": "${workspaceFolder}",
      "args": []
    }
  ]
}
```

También se admite cualquier adaptador DAP estándar por stdio indicando `"adapterCommand"` y `"adapterArgs"` en la configuración.

## Seguridad y confianza

- Todas las rutas (`program`, `cwd` y archivos con puntos de interrupción) se validan con `fsguard::WorkspaceGuard`.
- Antes de ejecutar código, el depurador exige que la carpeta esté marcada como de confianza en `trusted-folders.json` (compartido con la CLI `pulso` y el aviso de confianza del espacio de trabajo) y rechaza carpetas demasiado amplias (raíz de disco, carpeta personal, etc.).

## Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `F9` / clic en margen izquierdo | Alternar punto de interrupción |
| `F5` | Iniciar o continuar depuración |
| `Shift+F5` | Detener depuración |
| `F10` | Paso por encima (*Step Over*) |
| `Shift+F10` | Entrar en función (*Step Into*) |
| `Shift+F11` | Salir de función (*Step Out*) |
