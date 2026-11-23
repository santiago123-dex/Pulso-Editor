import { describe, expect, it } from "vitest";
import { shouldShowOnboarding } from "./onboarding";

describe("shouldShowOnboarding", () => {
  it("se muestra solo la primera vez cuando no hay carpeta abierta ni recientes", () => {
    expect(shouldShowOnboarding({ done: false, hasRecent: false, hasRoot: false })).toBe(true);
    expect(shouldShowOnboarding({ done: true, hasRecent: false, hasRoot: false })).toBe(false);
    expect(shouldShowOnboarding({ done: false, hasRecent: true, hasRoot: false })).toBe(false);
    expect(shouldShowOnboarding({ done: false, hasRecent: false, hasRoot: true })).toBe(false);
  });
});
