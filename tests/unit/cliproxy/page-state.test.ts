import { expect, test } from "bun:test";
import { canInstallExactRelease } from "../../../packages/gateway-ai/src/web/cliproxy/page-state";

test("disables installing the current release for both latest and exact selections", () => {
  expect(canInstallExactRelease("8.0.27", "8.0.27")).toBe(false);
});

test("allows upgrades, downgrades, and first installation", () => {
  expect(canInstallExactRelease("8.0.28", "8.0.27")).toBe(true);
  expect(canInstallExactRelease("8.0.26", "8.0.27")).toBe(true);
  expect(canInstallExactRelease("8.0.27", null)).toBe(true);
});

test("requires an available target release", () => {
  expect(canInstallExactRelease(null, "8.0.27")).toBe(false);
  expect(canInstallExactRelease("", "8.0.27")).toBe(false);
});
