import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { BudgetUsageCard } from "@/components/dashboard/ai/overview-cards"
import type { OverviewDetails } from "@/lib/overview"

const data: OverviewDetails = {
  cacheUsageInputTokens: 0, cacheUsageReadTokens: 0, cacheUsageCoveredRequests: 0,
  inputTokens: 0, cacheReadTokens: 0, failedRequests: 0, statusCoveredRequests: 0,
  durationCount: 0, durationSumMs: 0,
  budgetWindow: { from: "2026-10-15T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z", bypassLimits: false },
  budgets: [
    { id: "one", name: "First key", enabled: true, limitMicros: 100_000_000, spentMicros: 20_000_000 },
    { id: "two", name: "Second key", enabled: false, limitMicros: 200_000_000, spentMicros: 40_000_000 },
  ],
}

function renderBudget(overview = data) {
  return renderToStaticMarkup(<MemoryRouter><BudgetUsageCard data={overview} /></MemoryRouter>)
}

test("overview summarizes all configured budgets rather than individual keys", () => {
  const html = renderBudget()
  expect(html).toContain("$300.00")
  expect(html).toContain("$60.00")
  expect(html).toContain("20% used · $60.00 spent")
  expect(html).not.toContain("First key")
  expect(html).not.toContain("Second key")
})

test("incomplete budget usage never renders a partial global total or progress", () => {
  const html = renderBudget({ ...data, budgets: [...data.budgets, { id: "missing", name: "Missing", enabled: true, limitMicros: 100_000_000, spentMicros: null }] })
  expect(html).toContain("Unavailable")
  expect(html).not.toContain("$60.00")
  expect(html).not.toContain('role="progressbar"')
})

test("overview handles unlimited mode and no configured budgets", () => {
  expect(renderBudget({ ...data, budgetWindow: { ...data.budgetWindow!, bypassLimits: true } })).toContain("Unlimited Mode active")
  expect(renderBudget({ ...data, budgets: [] })).toContain("No configured budgets.")
})
