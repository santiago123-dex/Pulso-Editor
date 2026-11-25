# Firma de código en Windows

Guía para pedir la firma gratuita de [SignPath Foundation](https://signpath.org/terms.html) y conectarla a la publicación. **Estado: sin solicitar. Los instaladores salen sin firmar.**

Condiciones consultadas el 25 de noviembre de 2026; pueden cambiar. Hay que revisarlas antes de enviar la solicitud.

## Antes de solicitar

| Condición | Pulso Editor | Pulso Desktop |
| --- | --- | --- |
| Licencia aprobada por la OSI, sin doble licencia comercial | MIT | MIT |
| Sin componentes propietarios | Vistas las licencias de npm y Cargo; falta revisar todo lo que entra en el instalador | Falta revisar sus dependencias |
| Repositorio público | **Falta** | Sí |
| Ya publicado y con mantenimiento | Sí | Sí |
| Funciones documentadas en la página de descarga | **Falta** en `Pulso-Editor-releases` | Revisar la página de sus releases |
| «Code signing policy» en la página principal y en la de descargas | README; **falta** en las descargas | README; **falta** en el texto de las releases |
| Política de privacidad | `PRIVACY.md` | `PRIVACY.md` |
| Verificación en dos pasos en GitHub y en SignPath | **Falta confirmarlo** | **Falta confirmarlo** |
| Instalador con desinstalador | Sí (NSIS) | Sí (NSIS) |

Tres riesgos que decide SignPath y que no se resuelven con documentos:

- **Reputación.** Para programas piden una reputación verificable y no publican una cifra. La aceptación queda a su criterio; un proyecto nuevo puede ser rechazado.
- **Envíos automáticos.** Si consideran que un programa envía datos a sitios que la persona no indicó, exigen mostrar la política durante la instalación y poder desactivar el envío. Las dos aplicaciones consultan actualizaciones al arrancar y no tienen un ajuste para desactivarlo. Esa consulta no incluye datos del proyecto, pero pueden pedir el ajuste.
- **Historial entre proveedores.** El Editor entrega el historial al cambiar de proveedor sin pedir confirmación, incluso desde un modelo local (issue 93). El Desktop también lo envía cuando llama a una API. Está descrito en las políticas; conviene corregirlo antes de solicitar.

## Antes de hacer público el Editor

Hacerlo público no se deshace en la práctica: lo que otros copien o indexen no se recupera. Quedan visibles:

- El historial y las ramas. Parte de los commits llevan un correo personal.
- Las issues, los pull requests, sus comentarios y los registros de la CI, incluidos los fallos de seguridad sin corregir.

Una búsqueda de formatos conocidos de claves y tokens en los cambios del historial no encontró coincidencias (25 de noviembre de 2026). No cubrió issues, comentarios, registros de la CI ni secretos con otro formato.

Después de hacerlo público conviene activar el análisis de secretos de GitHub y proteger `main` y `develop`.

## Solicitud

Se envía en <https://signpath.org/apply.html>. No se pudieron leer los campos del formulario. Datos preparados:

- **Repository:** `https://github.com/santiago123-dex/Pulso-Editor`
- **Download page:** `https://github.com/santiago123-dex/Pulso-Editor-releases/releases`
- **License:** MIT
- **Code signing policy:** `https://github.com/santiago123-dex/Pulso-Editor#code-signing-policy`
- **Privacy policy:** `https://github.com/santiago123-dex/Pulso-Editor/blob/main/PRIVACY.md`
- **Description:** Pulso Editor is an open source desktop code editor built with Tauri, Rust, TypeScript and Monaco. It includes a file explorer, an integrated terminal, search, Git and GitHub integration, language server support, a debugger and an AI assistant that works with the tools and providers chosen by the user. Windows installers are built from this repository by GitHub Actions.

Las dos direcciones de la rama principal solo funcionarán cuando estos documentos lleguen a `main` y el repositorio sea público.

## Conectar la firma a la publicación (si la aprueban)

Todavía no se puede escribir: hacen falta los identificadores y el token que da SignPath.

**El orden es obligatorio.** El actualizador comprueba una firma (`.sig`) calculada sobre el instalador exacto, y la firma de Windows modifica ese archivo. Por eso hay que:

1. Compilar el instalador en GitHub Actions.
2. Enviarlo a SignPath y aprobar la solicitud.
3. Descargar el instalador firmado.
4. **Generar de nuevo** el `.sig` sobre ese archivo (`tauri signer sign`).
5. Escribir esa firma en `latest.json` y subir los tres archivos a la release en borrador.

Si se publica el `.sig` generado antes de la firma de Windows, **las aplicaciones instaladas rechazarán la actualización**. Hoy `tauri-action` compila, firma y sube en un solo paso: habrá que separarlo.

También hay que comprobar con SignPath si se debe firmar el ejecutable que va **dentro** del instalador además del instalador. Los paquetes de Linux no cambian.

## Qué cambia para quien descarga

Windows mostraría «SignPath Foundation» como editor. Firmar no quita de inmediato la advertencia de SmartScreen: la reputación se gana con el tiempo ([documentación de Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).

## Texto para la página de descargas

Para el `README.md` de `Pulso-Editor-releases`, cuando el Editor sea público:

```markdown
# Pulso Editor: descargas

Pulso Editor es un editor de código de escritorio de código abierto (licencia MIT) con terminal, búsqueda, Git y GitHub, depurador y asistente de IA.
El código está en https://github.com/santiago123-dex/Pulso-Editor

## Code signing policy

> **Estado:** los instaladores actuales no tienen firma de código. Esta política se aplicará si SignPath Foundation aprueba la solicitud.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Roles y privacidad: https://github.com/santiago123-dex/Pulso-Editor#code-signing-policy
```
