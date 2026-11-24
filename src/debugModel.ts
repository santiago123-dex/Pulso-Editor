/** Lógica pura del depurador (DAP): puntos de interrupción, consola y formato de marcos. */
import { readJsonStorage, writeJsonStorage } from "./core/storage";
import { baseName, norm } from "./util";

export interface DebugStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type DebugSessionStatus = "idle" | "running" | "paused";

export interface LaunchConfig {
  name: string;
  type: string;
  request: string;
  program: string;
  args: string[];
  cwd?: string | null;
  env: Record<string, string>;
  adapterCommand?: string | null;
  adapterArgs: string[];
  source: string;
}

export interface DapBreakpointInput {
  path: string;
  lines: number[];
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: string | null;
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type: string;
  variablesReference: number;
}

export interface DapEvalResult {
  result: string;
  type: string;
  variablesReference: number;
}

export interface DebugConsoleEntry {
  kind: "stdout" | "stderr" | "eval" | "error" | "info";
  text: string;
}

export type BreakpointMap = Record<string, number[]>;

const BP_STORAGE_KEY = "pulso.debug.breakpoints";

export function normalizeBpPath(path: string): string {
  return norm(path).trim();
}

export function toggleBreakpoint(map: BreakpointMap, rawPath: string, line: number): BreakpointMap {
  const path = normalizeBpPath(rawPath);
  if (!path || !Number.isInteger(line) || line < 1) return map;
  const current = map[path] ?? [];
  const exists = current.includes(line);
  const nextLines = exists ? current.filter((l) => l !== line) : [...current, line].sort((a, b) => a - b);
  const next: BreakpointMap = { ...map };
  if (nextLines.length === 0) delete next[path];
  else next[path] = nextLines;
  return next;
}

export function removeBreakpoint(map: BreakpointMap, rawPath: string, line: number): BreakpointMap {
  const path = normalizeBpPath(rawPath);
  const current = map[path];
  if (!current || !current.includes(line)) return map;
  return toggleBreakpoint(map, path, line);
}

export function breakpointsForFile(map: BreakpointMap, rawPath: string): number[] {
  const path = normalizeBpPath(rawPath);
  return map[path] ?? [];
}

export function countBreakpoints(map: BreakpointMap): number {
  let total = 0;
  for (const lines of Object.values(map)) total += lines.length;
  return total;
}

export function toDapBreakpoints(map: BreakpointMap): DapBreakpointInput[] {
  return Object.entries(map)
    .filter(([, lines]) => lines.length > 0)
    .map(([path, lines]) => ({ path, lines: [...lines] }));
}

export function loadBreakpoints(store?: DebugStore): BreakpointMap {
  let parsed: Record<string, unknown> = {};
  if (store) {
    try {
      const raw = store.getItem(BP_STORAGE_KEY);
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
  } else {
    parsed = readJsonStorage<Record<string, unknown>>(BP_STORAGE_KEY, {});
  }
  const out: BreakpointMap = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [k, v] of Object.entries(parsed)) {
    const path = normalizeBpPath(k);
    if (!path || !Array.isArray(v)) continue;
    const clean = Array.from(new Set(v.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1))).sort(
      (a, b) => a - b,
    );
    if (clean.length > 0) out[path] = clean;
  }
  return out;
}

export function saveBreakpoints(map: BreakpointMap, store?: DebugStore): void {
  if (store) {
    try {
      store.setItem(BP_STORAGE_KEY, JSON.stringify(map));
    } catch {
      /* sin espacio */
    }
    return;
  }
  writeJsonStorage(BP_STORAGE_KEY, map);
}

export function appendConsole(entries: readonly DebugConsoleEntry[], entry: DebugConsoleEntry, max = 300): DebugConsoleEntry[] {
  const next = [...entries, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function formatFrameLocation(frame: DapStackFrame): string {
  if (!frame.source) return `:${frame.line}`;
  return `${baseName(frame.source)}:${frame.line}`;
}
