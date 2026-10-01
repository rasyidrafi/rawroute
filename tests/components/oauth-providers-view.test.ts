import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("Codex OAuth accounts expose dynamically detected usage limits", () => {
  const view = readFileSync(new URL("../../src/components/dashboard/oauth-providers-view.tsx", import.meta.url), "utf8")
  const quota = readFileSync(new URL("../../src/components/dashboard/codex-quota.tsx", import.meta.url), "utf8")
  const resetCredits = readFileSync(new URL("../../src/components/dashboard/codex-reset-credits.tsx", import.meta.url), "utf8")

  expect(view).toContain('"/api/admin/oauth-providers/usage"')
  expect(view).toContain("refreshInterval: 300000")
  expect(quota).toContain('label: "5 hour"')
  expect(quota).toContain('label: "Weekly"')
  expect(quota).toContain("getAvailableQuotaWindows")
  expect(quota).toContain("CodexQuotaTableCell")
  expect(quota).not.toContain("overflow-hidden rounded-full")
  expect(view).toContain("Usage Limits")
  expect(view).toContain("<CodexQuotaTableCell")
  expect(view).toContain('colSpan={6}')
  expect(view).toContain("<CodexResetCredits usage={usage} />")
  expect(resetCredits).toContain('count === undefined ? "Not Available"')
  expect(quota).toContain("Authentication token expired. Reauthorize this Codex account.")

  const detail = readFileSync(new URL("../../src/components/dashboard/provider-detail-view.tsx", import.meta.url), "utf8")
  expect(detail).toContain('"/api/admin/oauth-providers/usage"')
  expect(detail).toContain("Usage Limits")
  expect(detail).toContain("<CodexQuotaTableCell")
  expect(detail).toContain('colSpan={6}')
  expect(detail).toContain("Not Available")
  expect(detail).not.toContain("rowSpan")
  expect(detail).toContain('apiDelete(`/api/admin/oauth-providers/${account.id}`)')
  expect(detail).toContain('title={`Remove ${apiKey.name}?`}')
})
