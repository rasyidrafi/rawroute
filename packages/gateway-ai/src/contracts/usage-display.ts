const integerFormatter = new Intl.NumberFormat("en-US")
const requestFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const currencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
const subDollarCurrencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 })
const TOKEN_UNITS = ["", "K", "M", "B", "T"] as const

/** Compact request counts, with rounded values promoted to the next unit. */
export function formatRequestCount(value: number) {
  if (!Number.isFinite(value) || value < 0) return "Unavailable"
  return requestFormatter.format(value === 0 ? 0 : value).replace("K", "k")
}

/** Human-readable elapsed time, promoting units when rounding crosses a boundary. */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "Unavailable"
  if (ms === 0) return "0 ms"
  if (ms < 1) return "<1 ms"
  if (ms < 999.5) return `${Math.round(ms)} ms`
  const seconds = Math.round(ms / 10) / 100
  if (seconds < 60) return `${seconds} s`
  const wholeSeconds = Math.round(ms / 1000)
  if (wholeSeconds < 3600) {
    const remainder = wholeSeconds % 60
    return `${Math.floor(wholeSeconds / 60)} min${remainder ? ` ${remainder} s` : ""}`
  }
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1440) {
    const remainder = minutes % 60
    return `${Math.floor(minutes / 60)} h${remainder ? ` ${remainder} min` : ""}`
  }
  const hours = Math.round(ms / 3_600_000)
  const remainder = hours % 24
  return `${Math.floor(hours / 24)} d${remainder ? ` ${remainder} h` : ""}`
}

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
