import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"

test("dashboard loading state preserves the dashboard navigation shell", () => {
  const markup = renderToStaticMarkup(<DashboardContentSkeleton />)
  const layout = readFileSync(new URL("../app/dashboard/layout.tsx", import.meta.url), "utf8")
  const shell = readFileSync(new URL("../components/dashboard/dashboard-shell.tsx", import.meta.url), "utf8")

  expect(markup).toContain('data-slot="dashboard-content-skeleton"')
  expect(markup).not.toContain("min-h-svh")
  expect(markup).not.toContain("h-9 w-28")
  expect(layout).toContain("<DashboardShell>")
  expect(shell).toContain('<AppSidebar variant="inset" />')
  expect(shell).toContain("<SiteHeader />")
})

test("model pricing loading state uses the shared dashboard content spacing", () => {
  const markup = renderToStaticMarkup(<DashboardContentSkeleton variant="model-pricing" />)

  expect(markup).toContain('aria-label="Loading model pricing"')
  expect(markup).toContain("rounded-xl border bg-card p-6")
  expect(markup).toContain("minmax(14rem, 1.4fr)")
  expect(markup).not.toContain("xl:grid-cols-6")
  expect(markup).not.toContain('data-slot="card-header"')
})
