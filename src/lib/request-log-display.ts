const requestCostFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 })

/** Request costs retain micro-dollar precision instead of aggregate rounding. */
export function formatRequestCost(costMicros: number) {
  return requestCostFormatter.format(costMicros / 1_000_000)
}
