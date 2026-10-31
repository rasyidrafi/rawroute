import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"

import { DashboardContentSkeleton, DashboardRouteSkeleton } from "../../apps/console/src/frontend/route-skeleton"
import { UsageSummary } from "../../packages/gateway-ai/src/web/components/usage-summary"

for (const [path, heading] of [
  ["/dashboard/ai/overview/usage", "Usage summary"],
  ["/dashboard/ai/overview/request-logs", "Request Logs"],
  ["/dashboard/settings", "Admin password"],
  ["/dashboard/system-logs", "System Logs"],
  ["/dashboard/ai/codex-providers", "Usage Limits"],
  ["/dashboard/ai/budgets", "Budget window"],
  ["/dashboard/tools/overview", "Executor integration"],
]) {
  test(`route loading preserves the content for ${path}`, () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={[path!]}><DashboardRouteSkeleton /></MemoryRouter>)
    expect(markup).toContain(heading!)
    if (path === "/dashboard/ai/overview/request-logs") {
      expect(markup).toMatch(/data-slot="card-description"[^>]*>Workspace requests with their recorded main and fallback attempts\.<\/div>/)
    }
    if (path === "/dashboard/ai/overview/usage") {
      expect(markup).toContain("Usage Trend")
      expect(markup).toContain("Token usage over time")
    }
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
  expect(markup).toContain("Recorded model attempts in this period")
  expect(markup).toContain('aria-busy="true"')
})

test("overview fallback has real-layout metric and four-row table skeletons, not preview values", () => {
  const markup = renderToStaticMarkup(<MemoryRouter><DashboardContentSkeleton variant="overview" /></MemoryRouter>)
  expect(markup).toContain("Your gateway at a glance")
  expect(markup).toContain("Tokens processed")
  expect(markup).toContain("Input + cached input + output tokens")
  expect(markup).toContain("Based on configured model rates")
  expect(markup).toContain("Usage Trend")
  expect(markup).toContain("Recent Requests")
  expect(markup).toMatch(/data-slot="card-description"[^>]*>Latest saved model attempts<\/div>/)
  expect(markup.match(/data-slot="overview-request-skeleton-row"/g)).toHaveLength(4)
  expect(markup).toContain('aria-busy="true"')
  expect(markup).not.toContain("6.42M")
  expect(markup).not.toContain("sample-")
  expect(markup).not.toContain("GPT-5")
})
