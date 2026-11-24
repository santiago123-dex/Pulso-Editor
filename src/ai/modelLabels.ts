/** Textos de los modelos de las herramientas externas: nombre, nivel de esfuerzo y etiqueta de la descripción. */
import { t as tr } from "../i18n";

export const LEGACY_CODEX = /\blegacy\b|previous generation/i;

/** «Gemini 4 Hydrogen (High)» → { name: «Gemini 4 Hydrogen», tier: «High» }. */
export function splitLabelLevel(raw: string): { name: string; tier: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(raw.trim());
  if (m && /^(Low|Medium|High|XHigh|Max)$/i.test(m[2])) {
    return { name: m[1].trim(), tier: m[2].trim() };
  }
  return { name: raw.trim(), tier: "" };
}

export function titleFromId(id: string): string {
  return id.split("-").map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(" ");
}

export function tierFromNote(note: string): string {
  if (/legacy/i.test(note)) return tr("Legado");
  if (/previous generation/i.test(note)) return tr("Anterior");
  if (/most capable|complex/i.test(note)) return tr("Más capaz");
  if (/affordable|easier|simpler/i.test(note)) return tr("Ligero");
  if (/visual/i.test(note)) return tr("Visión");
  if (/fast|go-to/i.test(note)) return tr("Rápido");
  if (/^(Low|Medium|High|XHigh|Max)$/i.test(note)) return note;
  return tr("Disponible");
}
