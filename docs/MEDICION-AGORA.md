# Medición aislada del LSP con Agora-Client

El 18 de noviembre de 2026 se ejecutó el servidor TypeScript/JavaScript usado por Pulso con el proyecto real `Agora-Client`. Se abrió en memoria `app/auth/forgot-password/page.tsx` (180 bytes) y se solicitó información del símbolo importado `ForgotPasswordForm`. No se cambió ningún archivo del proyecto. La prueba usa la versión local del servidor de Pulso y la configuración del proyecto.

En dos ejecuciones consecutivas con el símbolo correcto, la respuesta `initialize` tardó 138 y 143 ms desde el inicio del proceso; el primer `hover` respondió en 570 y 573 ms y devolvió información. Cinco segundos después, los procesos Node nuevos observados sumaron aproximadamente 379 y 470 MiB de memoria residente. La lista se obtiene comparando procesos antes y después, por lo que podría incluir otros procesos Node iniciados al mismo tiempo; no debe interpretarse como una atribución definitiva a cada subproceso. Ninguna de las dos ejecuciones recibió una notificación de diagnósticos en ese intervalo.

Son dos muestras de un archivo pequeño y una sola máquina; no miden CPU sostenida, navegación a definición, escritura, varios archivos abiertos, memoria de WebView2 ni del proceso del editor. Tampoco son comparables directamente con los 3,5 GB de la prueba sintética anterior: allí se abrieron archivos grandes y se midieron más procesos. No permiten afirmar una mejora ni identificar con certeza un cuello de botella.

En una medición adicional con seis archivos reales abiertos (7.131 bytes en total), `initialize` tardó 182 ms y el primer hover 1.047 ms; la memoria residente de los procesos Node nuevos observados sumó aproximadamente 480 MiB a los cinco segundos. Es una única muestra, capturada mientras se ejecutaban pruebas de desarrollo. No justifica por sí sola imponer un límite de memoria al servidor.

Para repetirla desde la raíz de Pulso:

```powershell
node scripts/perf-real-lsp.mjs 'C:\Users\ASUS\Documents\Agora-Client' 'app\auth\forgot-password\page.tsx'
```

El script lee los archivos, los envía como documentos abiertos al LSP y consulta `hover` del primero; no los guarda. Se pueden añadir más rutas relativas después de la primera. Inicia y cierra su propio servidor, sin usar ni cambiar la sesión de Pulso. La memoria por proceso se obtiene con `Get-Process` en Windows. Las consultas del sistema de archivos y carga del servidor pueden calentar cachés del sistema y usar CPU temporalmente.

En el editor, las notificaciones a pestañas y explorador se limitan a cambios del estado de guardado. Además, si una copia de recuperación está tardando, se agrupan las escrituras pendientes y se captura solo el contenido más reciente al poder escribir. La frecuencia de programación y el vaciado al perder el foco no cambian. Estas mejoras están verificadas con pruebas, pero todavía no se ha medido su impacto real en latencia ni memoria.

Siguiente medición necesaria: una instancia aislada de la aplicación instalada con Agora abierto, sin sobrescribir sesiones ni recuperación existentes, y muestras separadas de Pulso, WebView2 y todos los procesos del LSP. Medir arranque, apertura, edición sin guardar y navegación en varios archivos; después repetir bajo las mismas condiciones para evaluar cualquier cambio.

## Intento con la aplicación de producción

El 18 de noviembre se compiló una copia de producción con identificador de aplicación distinto, almacén de credenciales separado y conexión automática a GitHub desactivada. La compilación terminó correctamente. La prueba de WebView2 y la medición de la aplicación no pudieron conectarse al puerto local de depuración desde el entorno restringido: incluso una prueba independiente de conexión a `127.0.0.1` devolvió `EACCES`. Por tanto no hay una medición de la interfaz ni una comparación antes/después de estas mejoras. La copia de compilación temporal se retiró al terminar.

Para repetir la preparación desde la raíz de Pulso, `node scripts/perf-prepare-isolated.mjs` imprime la ruta de una copia con identificador propio. Desde esa copia se puede ejecutar `npm run tauri build -- --no-bundle` y luego establecer `PULSO_ISOLATED_EXE` a su `src-tauri/target/release/pulso-editor.exe` para ejecutar `node scripts/perf-agora-ui.mjs <proyecto> <archivo>`. El medidor exige que se use el ejecutable de esa copia, desactiva autoguardado y no guarda la edición. La copia puede ocupar varios GB; bórrala cuando ya no se necesite.
