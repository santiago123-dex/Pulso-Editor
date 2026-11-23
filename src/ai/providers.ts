/**
 * Conectar proveedores de modelos de la nube (catálogo de models.dev). La ventana solo manda la clave una vez para que Rust la
 * guarde en el almacén seguro del sistema; no la vuelve a ver: solo sabe si cada proveedor tiene una o no.
 */
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { promptText, quickPick, setStatus, type PickItem } from "../ui";

export interface ProviderBrief {
  id: string;
  name: string;
  doc: string;
  env: string[];
  models: number;
  configured: boolean;
  /** La clave sale de una variable de entorno: no se puede quitar desde Pulso. */
  from_env: boolean;
}

export interface CatalogView {
  providers: ProviderBrief[];
  warning: string | null;
}

/** Los conectados primero y, dentro de cada grupo, por nombre. */
export function sortProviders(list: readonly ProviderBrief[]): ProviderBrief[] {
  return [...list].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Línea de detalle de un proveedor en la lista: cuántos modelos tiene y su estado. */
export function providerDetail(p: ProviderBrief): string {
  const models = tr("{n} modelos", { n: p.models });
  if (p.configured) return `${models} · ${p.from_env ? tr("conectado (variable de entorno)") : tr("conectado")}`;
  return p.env[0] ? `${models} · ${p.env[0]}` : models;
}

/** Una clave plausible: sin espacios ni saltos de línea y de longitud razonable. */
export function validateKey(raw: string): string | null {
  const v = raw.trim();
  if (!v) return tr("Pega la clave del proveedor");
  if (/\s/.test(v)) return tr("La clave no debe tener espacios");
  if (v.length < 8 || v.length > 1024) return tr("La clave no parece válida");
  return null;
}

async function saveKey(p: ProviderBrief, onChanged: () => void): Promise<void> {
  const key = await promptText({
    title: tr("Clave de {provider}", { provider: p.name }),
    placeholder: p.env[0] ?? "API key",
    secret: true,
    validate: validateKey,
  });
  if (key === null) return;
  try {
    await invoke("provider_key_set", { id: p.id, key });
    setStatus(tr("{provider} conectado. Ya puedes elegir sus modelos en el asistente.", { provider: p.name }), 6000);
    onChanged();
  } catch (e) {
    setStatus(tr("No se pudo guardar la clave: {error}", { error: String(e) }), 8000);
  }
}

async function removeKey(p: ProviderBrief, onChanged: () => void): Promise<void> {
  try {
    await invoke("provider_key_delete", { id: p.id });
    setStatus(tr("Clave de {provider} eliminada", { provider: p.name }), 5000);
    onChanged();
  } catch (e) {
    setStatus(tr("No se pudo eliminar la clave: {error}", { error: String(e) }), 8000);
  }
}

/** Lista de proveedores: elegir uno para pegar su clave (o cambiarla o quitarla si ya está conectado). */
export function connectProvider(onChanged: () => void = () => {}): void {
  quickPick({
    placeholder: tr("Conectar un proveedor de modelos (OpenAI, Anthropic, Google, OpenRouter, DeepSeek…)"),
    empty: tr("No hay proveedores. Comprueba tu conexión a internet."),
    load: async () => {
      let view: CatalogView;
      try {
        view = await invoke<CatalogView>("catalog_get", { refresh: false });
      } catch (e) {
        setStatus(tr("No se pudo cargar el catálogo de modelos: {error}", { error: String(e) }), 8000);
        return [];
      }
      if (view.warning) setStatus(tr("Se usa la copia guardada del catálogo: {error}", { error: view.warning }), 6000);
      const refresh: PickItem = {
        label: tr("Actualizar el catálogo de models.dev"),
        detail: tr("Descarga la lista de proveedores y modelos"),
        keywords: "refresh actualizar catalogo",
        run: async () => {
          try {
            await invoke("catalog_get", { refresh: true });
            setStatus(tr("Catálogo actualizado"), 4000);
          } catch (e) {
            setStatus(tr("No se pudo actualizar el catálogo: {error}", { error: String(e) }), 8000);
          }
          onChanged();
        },
      };
      const items = sortProviders(view.providers).map<PickItem>((p) => ({
        label: p.name,
        detail: providerDetail(p),
        keywords: `${p.id} ${p.env.join(" ")}`,
        run: () => {
          if (p.configured && !p.from_env) {
            // Ya está conectado: cambiar la clave o quitarla.
            quickPick({
              placeholder: tr("{provider}: ¿qué quieres hacer?", { provider: p.name }),
              load: () => [
                { label: tr("Cambiar la clave"), run: () => void saveKey(p, onChanged) },
                { label: tr("Quitar la clave"), run: () => void removeKey(p, onChanged) },
              ],
            });
          } else if (p.configured) {
            setStatus(tr("{provider} usa la variable de entorno {name}.", { provider: p.name, name: p.env[0] ?? "" }), 6000);
          } else {
            void saveKey(p, onChanged);
          }
        },
      }));
      return [refresh, ...items];
    },
  });
}
