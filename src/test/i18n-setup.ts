// Las pruebas comprueban los textos en español. Con el idioma en «automático» dependerían del sistema
// donde corren (los servidores de la CI están en inglés), así que se fija aquí.
import { setLangForTests } from "../i18n";

setLangForTests("es");
