import { expect, test } from "bun:test"
import { formatRequestCost } from "./request-log-display"

test("request costs distinguish zero from tiny positive micro-dollar amounts", () => {
  expect(formatRequestCost(0)).toBe("$0.00")
  expect(formatRequestCost(1)).toBe("$0.000001")
  expect(formatRequestCost(10)).toBe("$0.00001")
  expect(formatRequestCost(100)).toBe("$0.0001")
  expect(formatRequestCost(499)).toBe("$0.000499")
  expect(formatRequestCost(1_230_000)).toBe("$1.23")
})
