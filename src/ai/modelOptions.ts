/** Qué modelos hay para cada proveedor, cuál está elegido y cómo se ve en el botón del modelo. */

import { type AiProvider, formatModelName } from "../aiModel";
import { t as tr } from "../i18n";
import { type AiModelInfo, EFFORTS, type ModelOption, PROVIDERS } from "./catalog";
import { S, q, tools } from "./chatState";
import { LEGACY_CODEX, splitLabelLevel, tierFromNote, titleFromId } from "./modelLabels";

export function providerCatalog(prov: AiProvider): { models: ModelOption[]; specific: ModelOption[] } {
  const meta = PROVIDERS[prov];
  if (prov === "claude") return { models: meta.models, specific: meta.specific };
  const detected = tools[prov]?.models ?? [];
  const toOption = (d: AiModelInfo): ModelOption => {
    const rawLabel = d.label || titleFromId(d.id);
    const { name, tier } = splitLabelLevel(rawLabel);
    const isNew =
      prov === "cloud"
        ? false
        : prov === "antigravity"
          ? /gemini-4|opus-5-5|sonnet-5-5|orchestrator/i.test(d.id)
          : /gpt-6|new|preview/i.test(d.id);
    return {
      value: d.id,
      label: name,
      tier: tier || tierFromNote(d.note),
      badge: /preview/i.test(d.id) ? "Preview" : isNew ? tr("Nuevo") : undefined,
      hint: d.note ? `${d.id} · ${d.note}` : d.id,
    };
  };
  if (prov === "codex") {
    return {
      models: [...meta.models, ...detected.filter((d) => !LEGACY_CODEX.test(d.note)).map(toOption)],
      specific: detected.filter((d) => LEGACY_CODEX.test(d.note)).map(toOption),
    };
  }
  // Antigravity: muestra TODOS los modelos reales directamente en la lista principal (sin ocultarlos).
  return {
    models: [...meta.models, ...detected.map(toOption)],
    specific: [],
  };
}

export function findModelOption(val: string, prov: AiProvider = S.activeProvider): ModelOption {
  const cat = providerCatalog(prov);
  return (
    cat.models.find((m) => m.value === val) ??
    cat.specific.find((m) => m.value === val) ?? {
      value: val,
      label: formatModelName(val) || val,
      tier: tr("Personalizado"),
      hint: tr("Modelo específico: {model}", { model: val }),
    }
  );
}

export function modelButtonText(): string {
  const prov = S.current?.convo.messages.length ? S.current.provider : S.activeProvider;
  const active = findModelOption(S.model, prov);
  const resolved = S.current?.convo.model;
  const base = !S.model && resolved ? formatModelName(resolved) : active.label;
  const fixedLevel = prov === "antigravity" && S.model ? active.tier : "";
  const eff = fixedLevel || (PROVIDERS[prov].supportsEffort ? EFFORTS.find((e) => e.value === S.effort)?.short : "");
  const prefix = prov === "claude" ? "" : `${PROVIDERS[prov].short} · `;
  return `${prefix}${eff ? `${base} · ${eff}` : base}`;
}

export function syncModelButton() {
  const label = q(".ai-model-btn-label");
  if (label) label.textContent = modelButtonText();
}
