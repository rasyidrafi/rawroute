import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { BudgetUsageCard } from "../../src/web/components/overview-cards"
import type { OverviewDetails } from "../../src/contracts/overview"

function render(spentMicros: number | null, options: { limitMicros?: number; usageAvailable?: boolean; bypassLimits?: boolean; budgets?: number } = {}) {
  const limitMicros = options.limitMicros ?? 1_000_000
  const budgets = Array.from({ length: options.budgets ?? 1 }, (_, index) => ({
    id: `key-${index}`,
    name: `Budget ${index}`,
    enabled: true,
    limitMicros,
    spentMicros,
    ...(options.usageAvailable === false ? { usageAvailable: false } : {}),
  }))
  const data: OverviewDetails = {
    cacheUsageInputTokens: 0,
    cacheUsageReadTokens: 0,
    cacheUsageCoveredRequests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    failedRequests: 0,
    statusCoveredRequests: 0,
    durationCount: 0,
    durationSumMs: 0,
    budgets,
    budgetWindow: { from: "2026-10-13T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z", bypassLimits: options.bypassLimits ?? false },
  }
  return renderToStaticMarkup(<MemoryRouter><BudgetUsageCard data={data} /></MemoryRouter>)
}

test("budget usage summary formats configured total and keeps displayed percentage above the clamped bar", () => {
  const normal = render(456_740_000, { limitMicros: 2_200_000_000 })
  expect(normal).toContain("Configured budget")
  expect(normal).toContain("21% used · $456.74 spent")
  expect(normal).not.toContain("bg-warning")

  const approaching = render(800_000)
  expect(approaching).toContain("Approaching limit")
  expect(approaching).toContain("bg-warning")

  const near = render(900_000)
  expect(near).toContain("Near limit")
  expect(near).toContain("bg-destructive")

  const reached = render(1_000_000)
  expect(reached).toContain("Limit reached")
  const exceeded = render(1_250_000)
  expect(exceeded).toContain("125% used")
  expect(exceeded).toContain("Exceeded")
})

test("budget summary retains unavailable, unlimited and no-budget states", () => {
  const unavailable = render(null, { usageAvailable: false })
  expect(unavailable).toContain("Unavailable")
  expect(unavailable).not.toContain("data-slot=\"progress\"")

  const unlimited = render(150_000, { bypassLimits: true })
  expect(unlimited).toContain("Unlimited Mode active")

  const empty = render(0, { budgets: 0 })
  expect(empty).toContain("No configured budgets.")
})
