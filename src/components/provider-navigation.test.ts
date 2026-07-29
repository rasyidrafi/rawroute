import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("providers use a list page and a dynamic detail page", () => {
  const dashboard = readFileSync(new URL("./gateway-dashboard.tsx", import.meta.url), "utf8")
  const detailPage = readFileSync(new URL("../app/dashboard/providers/[providerId]/page.tsx", import.meta.url), "utf8")

  expect(dashboard).toContain("/dashboard/providers/${provider.id}")
  expect(dashboard).toContain('buttonLabel="Delete provider"')
  expect(dashboard).toContain("onDeleteProviderList")
  expect(dashboard).toContain("API keys and")
  expect(dashboard.match(/nativeButton=\{false\}/g)).toHaveLength(3)
  expect(detailPage).toContain('view="provider-detail"')
  expect(detailPage).toContain("providerId={providerId}")
})
