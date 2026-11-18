import { apiBase, explainStatus, getToken } from "./github";

/** Las etiquetas de estado deben existir antes de asignarlas: GitHub puede ignorar etiquetas desconocidas. */
export async function ensureBoardLabel(owner: string, repo: string, label: string): Promise<void> {
  if (!label.trim()) throw new Error("Configura una etiqueta de progreso para usar esta columna.");
  const base = `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`;
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${getToken()}`, "X-GitHub-Api-Version": "2022-11-28" };
  const existing = await fetch(`${base}/${encodeURIComponent(label)}`, { headers, cache: "no-store" });
  if (existing.ok) return;
  if (existing.status !== 404) throw new Error(explainStatus(existing.status, false));
  const created = await fetch(base, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: label, color: "a371f7", description: "Estado de una issue en el tablero de Pulso" }) });
  if (created.ok) return;
  // Otra persona podría haber creado la etiqueta al mismo tiempo.
  if (created.status === 422 && (await fetch(`${base}/${encodeURIComponent(label)}`, { headers })).ok) return;
  throw new Error(`No se pudo crear la etiqueta «${label}». ${explainStatus(created.status, true)}`);
}
