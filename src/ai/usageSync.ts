/** Uso del plan de cada proveedor (Claude, Codex, Antigravity): leerlo, guardarlo y refrescarlo. */

import { type AiProvider, type Conversation, type UsageWindow, parseUsageText, pruneUsage, resetTimeFromIso } from "../aiModel";
import { writeJsonStorage, writeStorage } from "../core/storage";
import { t as tr } from "../i18n";
import { type AntigravityBucket, type ExtraUsage } from "./catalog";
import { S, USAGE_KEY, USAGE_SIG_KEY, tools } from "./chatState";
import { syncTelemetryViews } from "./quota";
import { usageIsDue } from "./usagePolicy";
import { invoke } from "@tauri-apps/api/core";

export function agyWindowFromBucket(b: AntigravityBucket): UsageWindow {
  return { utilization: 1 - Math.max(0, Math.min(1, b.remaining_fraction)), resetsAt: resetTimeFromIso(b.reset_time) };
}

export function agyPrimaryUsage(): Conversation["usage"] {
  const g = S.agyUsage?.groups?.[0];
  if (!g) return {};
  const five = g.buckets.find((b) => b.window === "5h");
  const week = g.buckets.find((b) => b.window === "weekly");
  return pruneUsage({
    fiveHour: five ? agyWindowFromBucket(five) : undefined,
    sevenDay: week ? agyWindowFromBucket(week) : undefined,
  });
}

let claudeAttemptedAt = 0;
let extraAttemptedAt = 0;

export function refreshExtraUsage(): Promise<boolean> {
  if (S.extraUsageInFlight) return S.extraUsageInFlight;
  extraAttemptedAt = Date.now();
  S.extraUsageInFlight = (async () => {
    try {
      const res = await invoke<ExtraUsage>("ai_extra_usage");
      if (res.codex) {
        S.codexUsage = pruneUsage({
          fiveHour: res.codex.five_hour
            ? { utilization: res.codex.five_hour.used_percent / 100, resetsAt: res.codex.five_hour.resets_at }
            : undefined,
          sevenDay: res.codex.seven_day
            ? { utilization: res.codex.seven_day.used_percent / 100, resetsAt: res.codex.seven_day.resets_at }
            : undefined,
        });
        if (res.codex.plan && tools.codex && tools.codex.auth_method !== "api_key") {
          tools.codex.plan = res.codex.plan;
        }
      }
      if (res.antigravity) S.agyUsage = res.antigravity;
      if (S.shown) syncTelemetryViews();
      return !!(res.codex || res.antigravity);
    } catch {
      return false;
    } finally {
      S.extraUsageInFlight = null;
    }
  })();
  return S.extraUsageInFlight;
}

export function providerUsage(prov: AiProvider = S.activeProvider): Conversation["usage"] {
  if (prov === "claude") {
    S.usage = pruneUsage(S.usage);
    return S.usage;
  }
  if (prov === "codex") {
    S.codexUsage = pruneUsage(S.codexUsage);
    return S.codexUsage;
  }
  if (prov === "local" || prov === "cloud") return {};
  return agyPrimaryUsage();
}

export function saveUsage(u: Conversation["usage"]) {
  S.usage = pruneUsage(u);
  S.usageError = "";
  const claudeTool = tools.claude ?? S.tool;
  if (claudeTool?.version.includes("falso")) return; // la herramienta de pruebas nunca deja cifras guardadas
  writeJsonStorage(USAGE_KEY, S.usage);
  if (claudeTool) writeStorage(USAGE_SIG_KEY, `${claudeTool.auth_method}:${claudeTool.plan}`);
}

/**
 * Pide a Claude Code el uso real del plan (`/usage`): no gasta cuota ni toca credenciales.
 * Con `quiet` no muestra «Actualizando…»: es la consulta de fondo.
 */
export function refreshUsage(quiet = false): Promise<boolean> {
  if (S.activeProvider !== "claude" && !tools.claude?.logged_in) return Promise.resolve(false);
  if (S.usageInFlight) return S.usageInFlight;
  claudeAttemptedAt = Date.now();
  if (!quiet) {
    S.usageSyncing = true;
    S.usageError = "";
    if (S.shown) syncTelemetryViews();
  }
  S.usageInFlight = (async () => {
    try {
      const next = parseUsageText(await invoke<string>("ai_usage"));
      if (!next.fiveHour && !next.sevenDay) {
        S.usageError = tr("La CLI no devolvió ventanas de uso reconocibles.");
        return false;
      }
      saveUsage(next);
      return true;
    } catch (e) {
      S.usageError = e instanceof Error ? e.message : String(e || tr("No se pudo consultar /usage."));
      return false;
    } finally {
      S.usageSyncing = false;
      S.usageInFlight = null;
      if (S.shown) syncTelemetryViews();
    }
  })();
  return S.usageInFlight;
}

/** Consulta de fondo: solo las cuentas conectadas cuyo último intento ya tenga `maxAgeMs`. */
export function autoRefreshUsage(maxAgeMs: number): void {
  const now = Date.now();
  if (tools.claude?.logged_in && usageIsDue(claudeAttemptedAt, maxAgeMs, now)) void refreshUsage(true);
  if ((tools.codex?.logged_in || tools.antigravity?.logged_in) && usageIsDue(extraAttemptedAt, maxAgeMs, now)) {
    void refreshExtraUsage();
  }
}

/** Al terminar un turno. Si ya había una consulta en marcha, empezó antes del final: se repite. */
export async function refreshUsageAfterTurn(prov: AiProvider): Promise<void> {
  if (prov === "claude") {
    await S.usageInFlight;
    await refreshUsage(true);
  } else if (prov === "codex" || prov === "antigravity") {
    await S.extraUsageInFlight;
    await refreshExtraUsage();
  }
}
