import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("Codex OAuth accounts expose cached five-hour and weekly usage rows", () => {
  const view = readFileSync(new URL("./dashboard/oauth-providers-view.tsx", import.meta.url), "utf8")

  expect(view).toContain('"/api/admin/oauth-providers/usage"')
  expect(view).toContain("refreshInterval: 300000")
  expect(view).toContain('label="5 hour"')
  expect(view).toContain('label="Weekly"')
  expect(view).toContain("colSpan={5}")
  expect(view).toContain("Not currently applied")
})
