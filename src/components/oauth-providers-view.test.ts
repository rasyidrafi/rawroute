import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("Codex OAuth accounts expose dynamically detected usage limits", () => {
  const view = readFileSync(new URL("./dashboard/oauth-providers-view.tsx", import.meta.url), "utf8")
  const quota = readFileSync(new URL("./dashboard/codex-quota.tsx", import.meta.url), "utf8")

  expect(view).toContain('"/api/admin/oauth-providers/usage"')
  expect(view).toContain("refreshInterval: 300000")
  expect(quota).toContain('label: "5 hour"')
  expect(quota).toContain('label: "Weekly"')
  expect(quota).toContain("getAvailableQuotaWindows")
  expect(quota).toContain("CodexQuotaTableCell")
  expect(quota).not.toContain("overflow-hidden rounded-full")
  expect(view).toContain("Usage Limits")
  expect(view).toContain("<CodexQuotaTableCell")

  const detail = readFileSync(new URL("./dashboard/provider-detail-view.tsx", import.meta.url), "utf8")
  expect(detail).toContain('"/api/admin/oauth-providers/usage"')
  expect(detail).toContain("Usage Limits")
  expect(detail).toContain("<CodexQuotaTableCell")
  expect(detail).not.toContain("rowSpan")
  expect(detail).toContain('apiDelete(`/api/admin/oauth-providers/${account.id}`)')
  expect(detail).toContain('title={`Remove ${apiKey.name}?`}')
})
