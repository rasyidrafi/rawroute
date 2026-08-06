import { describe, expect, test } from "vitest"

import { DEFAULT_DASHBOARD_QUERY, parseDashboardQuery } from "@/lib/dashboard-query"

describe("parseDashboardQuery", () => {
  test("defaults missing presets to the budget window", () => {
    expect(parseDashboardQuery(new URLSearchParams())).toEqual(DEFAULT_DASHBOARD_QUERY)
  })

  test("preserves explicit presets", () => {
    expect(parseDashboardQuery(new URLSearchParams("preset=today"))).toMatchObject({ preset: "today" })
  })
})
