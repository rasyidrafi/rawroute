import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"

import { DashboardContentSkeleton, DashboardRouteSkeleton } from "@/components/dashboard-skeleton"
import { UsageSummary } from "@/components/dashboard/ai/usage-summary"

for (const [path, heading] of [
  ["/dashboard/ai/overview/usage", "Usage summary"],
  ["/dashboard/settings", "Admin password"],
  ["/dashboard/system-logs", "System Logs"],
  ["/dashboard/cliproxy", "Connection details"],
  ["/dashboard/ai/codex-providers", "Usage Limits"],
  ["/dashboard/tools/overview", "Executor integration"],
]) {
  test(`route loading preserves the content for ${path}`, () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={[path!]}><DashboardRouteSkeleton /></MemoryRouter>)
    expect(markup).toContain(heading!)
    expect(markup).not.toContain("min-h-svh")
    expect(markup).not.toContain("API Endpoint")
    expect(markup).toContain('data-slot="card-header"')
    expect(markup).toContain('data-slot="card-content"')
  })
}

test("pricing and aliases placeholders use real card and table primitives", () => {
  for (const variant of ["model-pricing", "aliases"] as const) {
    const markup = renderToStaticMarkup(<DashboardContentSkeleton variant={variant} />)
    expect(markup).toContain('data-slot="page-content"')
    expect(markup).toContain('data-slot="card-header"')
    expect(markup).toContain('data-slot="table-cell"')
    expect(markup).not.toContain("rounded-xl border bg-card p-6")
  }
})

test("usage loading retains the current summary content and metric structure", () => {
  const markup = renderToStaticMarkup(<UsageSummary />)
  expect(markup.match(/data-slot="card-content"/g)).toHaveLength(4)
  expect(markup).toContain("Estimated spend")
  expect(markup).toContain('aria-busy="true"')
})
