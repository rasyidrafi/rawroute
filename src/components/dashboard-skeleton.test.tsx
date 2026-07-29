import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"

test("dashboard loading state preserves the dashboard navigation shell", () => {
  const markup = renderToStaticMarkup(<DashboardContentSkeleton />)
  const layout = readFileSync(new URL("../app/dashboard/layout.tsx", import.meta.url), "utf8")

  expect(markup).toContain('data-slot="dashboard-content-skeleton"')
  expect(markup).not.toContain("min-h-svh")
  expect(markup).not.toContain("h-9 w-28")
  expect(layout).toContain('<AppSidebar variant="inset" />')
  expect(layout).toContain("<SiteHeader />")
})
