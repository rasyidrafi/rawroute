import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("admin usage does not seed a browser-selected workspace with Default data", () => {
  const page = readFileSync(new URL("../../app/dashboard/usage/page.tsx", import.meta.url), "utf8")
  const wrapper = readFileSync(new URL("./admin-usage-view.tsx", import.meta.url), "utf8")

  expect(page).not.toContain("getDashboardPayload")
  expect(page).toContain("<AdminUsageView />")
  expect(wrapper).toContain("<UsageView key={workspace.id} workspaceId={workspace.id} />")
})
