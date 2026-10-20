import { describe, expect, test } from "bun:test"

import { sortPricingGroups } from "@/components/dashboard/ai/model-pricing-view"

describe("sortPricingGroups", () => {
  test("lists missing pricing first and sorts names with an ID tie-breaker", () => {
    const groups = [
      { id: "configured-z", name: "Echo", currentVersion: {} },
      { id: "missing-z", name: "Echo", currentVersion: null },
      { id: "configured-a", name: "Aardvark", currentVersion: {} },
      { id: "missing-later", name: "Zenith", currentVersion: undefined },
      { id: "missing-a", name: "Echo", currentVersion: null },
      { id: "missing-earlier", name: "Alpha", currentVersion: null },
    ]

    expect(sortPricingGroups(groups).map((group) => group.id)).toEqual([
      "missing-earlier",
      "missing-a",
      "missing-z",
      "missing-later",
      "configured-a",
      "configured-z",
    ])
    expect(groups.map((group) => group.id)).toEqual([
      "configured-z",
      "missing-z",
      "configured-a",
      "missing-later",
      "missing-a",
      "missing-earlier",
    ])
  })
})
