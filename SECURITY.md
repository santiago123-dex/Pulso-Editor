# Política de seguridad

## Cómo reportar una vulnerabilidad

**No abras una issue pública** para una vulnerabilidad. Usa el aviso privado de GitHub: en la pestaña **Security** del repositorio, «Report a vulnerability» (<https://github.com/santiago123-dex/Pulso-Editor/security/advisories/new>).

Incluye, si puedes:
- la versión de Pulso Editor y el sistema operativo;
- los pasos para reproducirlo y qué esperabas que pasara;
- el impacto (qué podría hacer alguien que lo aproveche).

Responderemos lo antes posible, normalmente en unos días. Es un proyecto mantenido por pocas personas: pedimos un plazo razonable para corregirlo antes de que se haga público, y daremos crédito a quien lo reporte si lo desea.

## Versiones con soporte

Solo se corrige la última versión publicada en [Releases](https://github.com/santiago123-dex/Pulso-Editor-releases/releases).

## Qué consideramos una vulnerabilidad

Por ejemplo: que la ventana pueda leer o escribir fuera de la carpeta abierta, que un proyecto ajeno consiga ejecutar comandos sin que la persona los apruebe, que se filtre el token de GitHub o una clave de modelo, o que una actualización pueda instalar un paquete sin firma válida.

Cómo está protegido hoy (guardián de carpetas, lista de permitidos de GitHub, claves en el almacén del sistema, CSP estricta, aprobación de comandos del agente) está descrito en [Arquitectura](docs/ARQUITECTURA.md) y [Agente](docs/AGENTE.md).
