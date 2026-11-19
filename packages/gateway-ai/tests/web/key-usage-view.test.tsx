import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { trendUnavailable } from "../../src/web/components/key-usage-view"
import { KeyUsageTrend } from "../../src/web/components/key-usage-trend"
import type { AnalyticsCoverage, DashboardPayload } from "../../src/contracts/domain"

const coverage: AnalyticsCoverage = {
  partial: false,
  excludedSources: 0,
  tokenCoveredRequests: 2,
  statusCoveredRequests: 2,
  costCoveredRequests: 2,
  modelCoveredRequests: 2,
  keyCoveredRequests: 2,
  durationCount: 2,
  financialUnavailable: false,
  unsupportedTrendSources: 0,
}

function payload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  return {
    coverage,
    generatedAt: "2026-10-02T12:00:00.000Z",
    range: { label: "Oct 2", from: "2026-10-02T00:00:00.000Z", to: "2026-10-02T23:59:59.999Z", granularity: "hourly" },
    summary: { requests: 2, tokens: 48, costMicros: 80, activeKeys: 1, pricedRequests: 2, unpricedRequests: 0 },
    trend: [],
    keys: [],
    models: [],
    freshness: { source: "sqlite", lastEventAt: null },
    pricingConfidence: { pricedRequests: 2, unpricedRequests: 0 },
    ...overrides,
  }
}

// Fixture shape from tests/unit/usage-range.test.ts: fully covered daily history
// grouped hourly counts requests but withholds every trend point.
const withheldHistory = payload({ coverage: { ...coverage, partial: true, unsupportedTrendSources: 1 } })
const point = { bucketStart: "2026-10-02T12:00:00.000Z", label: "12 PM", requests: 2, tokens: 48, costMicros: 80 }

test("recorded requests with withheld hourly trend points are unavailable, not an idle window", () => {
  expect(withheldHistory.summary.requests).toBeGreaterThan(0)
  expect(withheldHistory.trend).toEqual([])
  expect(trendUnavailable(withheldHistory)).toBe(true)
})

test("idle window without recorded requests stays an empty trend", () => {
  const idle = payload({
    summary: { requests: 0, tokens: 0, costMicros: 0, activeKeys: 0, pricedRequests: 0, unpricedRequests: 0 },
    coverage: { ...coverage, tokenCoveredRequests: 0, statusCoveredRequests: 0, costCoveredRequests: 0, modelCoveredRequests: 0, keyCoveredRequests: 0, durationCount: 0 },
  })
  expect(trendUnavailable(idle)).toBe(false)
})

test("populated trend stays available even with unsupported historical sources", () => {
  expect(trendUnavailable(payload({ trend: [point], coverage: { ...coverage, partial: true, unsupportedTrendSources: 1 } }))).toBe(false)
  expect(trendUnavailable(payload({ trend: [point] }))).toBe(false)
})

test("existing cost and token coverage conditions still mark the trend unavailable", () => {
  expect(trendUnavailable(payload({ coverage: { ...coverage, financialUnavailable: true } }))).toBe(true)
  expect(trendUnavailable(payload({ coverage: { ...coverage, excludedSources: 1 } }))).toBe(true)
  expect(trendUnavailable(payload({ coverage: { ...coverage, tokenCoveredRequests: 0 } }))).toBe(true)
})

test("key usage trend renders the unavailable message for withheld history and the idle message for an empty window", () => {
  expect(renderToStaticMarkup(<KeyUsageTrend data={withheldHistory} unavailable={trendUnavailable(withheldHistory)} />)).toContain("Usage trend unavailable: recorded coverage is incomplete.")
  const idle = payload({
    summary: { requests: 0, tokens: 0, costMicros: 0, activeKeys: 0, pricedRequests: 0, unpricedRequests: 0 },
    coverage: { ...coverage, tokenCoveredRequests: 0, statusCoveredRequests: 0, costCoveredRequests: 0, modelCoveredRequests: 0, keyCoveredRequests: 0, durationCount: 0 },
  })
  expect(renderToStaticMarkup(<KeyUsageTrend data={idle} unavailable={trendUnavailable(idle)} />)).toContain("No usage recorded in this window.")
})

test("key usage trend shows the shared refreshing overlay only while a user refetch is in flight", () => {
  const data = payload({ trend: [point] })
  const refreshing = renderToStaticMarkup(<KeyUsageTrend data={data} unavailable={false} refreshing />)
  expect(refreshing).toContain("Refreshing data...")
  expect(refreshing).toContain('aria-busy="true"')
  expect(refreshing).toContain("animate-spin")
  const idle = renderToStaticMarkup(<KeyUsageTrend data={data} unavailable={false} />)
  expect(idle).not.toContain("Refreshing data...")
  expect(idle).not.toContain('aria-busy="true"')
})
