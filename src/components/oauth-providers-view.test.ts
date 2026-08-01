import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("Codex OAuth accounts expose cached five-hour and weekly usage rows", () => {
  const view = readFileSync(new URL("./dashboard/oauth-providers-view.tsx", import.meta.url), "utf8")
  const quota = readFileSync(new URL("./dashboard/codex-quota.tsx", import.meta.url), "utf8")

  expect(view).toContain('"/api/admin/oauth-providers/usage"')
  expect(view).toContain("refreshInterval: 300000")
  expect(quota).toContain('label="5 hour"')
  expect(quota).toContain('label="Weekly"')
  expect(view).toContain("colSpan={5}")
  expect(quota).toContain("Not currently applied")

  const detail = readFileSync(new URL("./dashboard/provider-detail-view.tsx", import.meta.url), "utf8")
  expect(detail).toContain('"/api/admin/oauth-providers/usage"')
  expect(detail).toContain("colSpan={7}")
  expect(detail).toContain("CodexQuotaTableRow")
})
