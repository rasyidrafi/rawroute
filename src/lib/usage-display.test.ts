import { expect, test } from "bun:test"
import { formatCost, formatDuration, formatTokenCount } from "./usage-display"

test.each([
  [NaN, "Unavailable"], [Infinity, "Unavailable"], [-Infinity, "Unavailable"], [-1, "Unavailable"],
  [0, "0 ms"], [0.1, "<1 ms"], [1, "1 ms"], [1.5, "2 ms"],
  [999.4, "999 ms"], [999.5, "1 s"], [1000, "1 s"], [1005, "1.01 s"],
  [5285, "5.29 s"], [9300, "9.3 s"], [59_994, "59.99 s"], [59_995, "1 min"],
  [60_000, "1 min"], [65_000, "1 min 5 s"], [119_500, "2 min"],
  [3_599_499, "59 min 59 s"], [3_599_500, "1 h"], [3_600_000, "1 h"],
  [3_720_000, "1 h 2 min"], [7_170_000, "2 h"],
  [86_369_999, "23 h 59 min"], [86_370_000, "1 d"], [86_400_000, "1 d"],
  [93_600_000, "1 d 2 h"], [171_000_000, "2 d"],
])("formats %s milliseconds as %s", (value, expected) => {
  expect(formatDuration(value)).toBe(expected)
})

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
