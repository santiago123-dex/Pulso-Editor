import { t } from "./i18n";
import { explainStatus, githubFetch } from "./github";

/** Las etiquetas de estado deben existir antes de asignarlas: GitHub puede ignorar etiquetas desconocidas. */
export async function ensureBoardLabel(owner: string, repo: string, label: string): Promise<void> {
  if (!label.trim()) throw new Error(t("Configura una etiqueta de progreso para usar esta columna."));
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`;
  const existing = await githubFetch(`${base}/${encodeURIComponent(label)}`);
  if (existing.ok) return;
  if (existing.status !== 404) throw new Error(explainStatus(existing.status, false));
  const created = await githubFetch(base, {
    method: "POST",
    body: { name: label, color: "a371f7", description: "Estado de una issue en el tablero de Pulso" },
  });
  if (created.ok) return;
  // Otra persona podría haber creado la etiqueta al mismo tiempo.
  if (created.status === 422 && (await githubFetch(`${base}/${encodeURIComponent(label)}`)).ok) return;
  throw new Error(t("No se pudo crear la etiqueta «{label}».", { label }) + " " + explainStatus(created.status, true));
}
