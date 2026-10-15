import { expect, test } from "bun:test"
import { formatCost, formatTokenCount } from "./usage-display"

test.each([
  [0, "0"], [999, "999"], [1000, "1.00K"], [43_542, "43.5K"],
  [999_499, "999K"], [999_500, "1.00M"], [1_000_000, "1.00M"],
  [28_500_000, "28.5M"], [999_500_000, "1.00B"], [1_000_000_000, "1.00B"],
  [999_500_000_000, "1.00T"], [1_000_000_000_000, "1.00T"], [-43_542, "-43.5K"],
])("formats %s tokens as %s", (value, expected) => {
  expect(formatTokenCount(value)).toBe(expected)
})

test.each([
  [0, "$0.00"], [1, "$0.000001"], [10, "$0.00001"], [100, "$0.0001"],
  [499, "$0.000499"], [5430, "$0.00543"], [999_999, "$0.999999"],
  [1_000_000, "$1.00"], [11_230_000, "$11.23"], [11_234_567, "$11.23"],
  [-1, "-$0.000001"], [-11_230_000, "-$11.23"],
])("formats %s micro-dollars as %s", (value, expected) => {
  expect(formatCost(value)).toBe(expected)
})
