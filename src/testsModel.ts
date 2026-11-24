/** Lógica pura de la vista de pruebas (agrupación por archivo y conteo). */

export interface DetectedRunner {
  id: string;
  label: string;
  cwd: string;
}

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestCaseResult {
  file: string;
  name: string;
  status: TestStatus;
  duration_ms?: number | null;
}

export interface TestRunResult {
  runner: string;
  ok: boolean;
  cases: TestCaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  output: string;
}

export interface FileTestGroup {
  file: string;
  cases: TestCaseResult[];
  passed: number;
  failed: number;
  skipped: number;
}

export function groupTestsByFile(cases: readonly TestCaseResult[], onlyFailed = false): FileTestGroup[] {
  const by = new Map<string, TestCaseResult[]>();
  for (const c of cases) {
    if (onlyFailed && c.status !== "failed") continue;
    const arr = by.get(c.file);
    if (arr) arr.push(c);
    else by.set(c.file, [c]);
  }
  const out: FileTestGroup[] = [];
  for (const [file, list] of by) {
    let passed = 0,
      failed = 0,
      skipped = 0;
    for (const c of list) {
      if (c.status === "passed") passed++;
      else if (c.status === "failed") failed++;
      else skipped++;
    }
    out.push({ file, cases: list, passed, failed, skipped });
  }
  return out.sort((a, b) => b.failed - a.failed || a.file.localeCompare(b.file));
}

export function testSummaryLine(res: Pick<TestRunResult, "passed" | "failed" | "skipped" | "duration_ms">): string {
  const parts: string[] = [];
  if (res.passed) parts.push(`${res.passed} ✓`);
  if (res.failed) parts.push(`${res.failed} ✖`);
  if (res.skipped) parts.push(`${res.skipped} ○`);
  const secs = `${(res.duration_ms / 1000).toFixed(1)} s`;
  return parts.length ? `${parts.join(" · ")} · ${secs}` : secs;
}
