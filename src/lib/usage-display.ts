const integerFormatter = new Intl.NumberFormat("en-US")
const currencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
const subDollarCurrencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 })
const TOKEN_UNITS = ["", "K", "M", "B", "T"] as const

/** Compact token counts, promoting rounded values into the next unit. */
export function formatTokenCount(value: number) {
  if (Math.abs(value) < 1000) return integerFormatter.format(Math.round(value))
  let index = Math.min(Math.floor(Math.log10(Math.abs(value)) / 3), TOKEN_UNITS.length - 1)
  let scaled = value / 1000 ** index
  if (Math.abs(scaled) >= 999.5 && index < TOKEN_UNITS.length - 1) {
    index += 1
    scaled = value / 1000 ** index
  }
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)}${TOKEN_UNITS[index]}`
}

/** USD from micro-dollars; retain storage precision for sub-dollar costs. */
export function formatCost(micros: number) {
  const value = micros / 1_000_000
  return (Math.abs(value) < 1 ? subDollarCurrencyFormatter : currencyFormatter).format(value)
}
