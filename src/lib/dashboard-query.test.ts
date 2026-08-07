import { describe, expect, test } from "vitest"

import { DEFAULT_DASHBOARD_QUERY, parseDashboardQuery } from "@/lib/dashboard-query"

describe("parseDashboardQuery", () => {
  test("defaults missing presets to the budget window", () => {
    expect(parseDashboardQuery(new URLSearchParams())).toEqual(DEFAULT_DASHBOARD_QUERY)
  })

  test("preserves explicit presets and discards irrelevant range noise", () => {
    expect(parseDashboardQuery(new URLSearchParams("preset=today&from=2000-01-01&to=9999-12-31"))).toEqual({ preset: "today", granularity: "auto" })
  })

  test("accepts valid bounded custom ranges", () => {
    expect(parseDashboardQuery(new URLSearchParams("preset=custom&from=2026-02-01&to=2026-02-28&granularity=daily"), { maxCustomRangeDays: 30 })).toEqual({
      preset: "custom",
      from: "2026-02-01",
      to: "2026-02-28",
      granularity: "daily",
    })
  })

  test("canonicalizes invalid or oversized custom ranges to the default query", () => {
    expect(parseDashboardQuery(new URLSearchParams("preset=custom&from=2026-02-30&to=2026-03-01&granularity=hourly"))).toEqual(DEFAULT_DASHBOARD_QUERY)
    expect(parseDashboardQuery(new URLSearchParams("preset=custom&from=2026-01-01&to=2026-02-01"), { maxCustomRangeDays: 31 })).toEqual(DEFAULT_DASHBOARD_QUERY)
  })
})
