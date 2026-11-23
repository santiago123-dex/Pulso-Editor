// Las pruebas comprueban los textos en español. Con el idioma en «automático» dependerían del sistema
// donde corren (los servidores de la CI están en inglés), así que se fija aquí. No basta con fijar el
// idioma del módulo ya cargado: las pruebas que usan vi.resetModules() lo vuelven a cargar y entonces
// se lee de nuevo el idioma del sistema, así que también se fija ese.
import { setLangForTests } from "../i18n";

const SYSTEM_LANGUAGES = ["es-ES"];
Object.defineProperty(globalThis.navigator, "languages", { value: SYSTEM_LANGUAGES, configurable: true });
setLangForTests("es");
