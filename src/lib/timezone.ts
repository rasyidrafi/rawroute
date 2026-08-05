export const DEFAULT_TIME_ZONE = "Asia/Jakarta"
const DISPLAY_LOCALE = "en-GB"
const DAY_MS = 24 * 60 * 60 * 1000

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

function configuredTimeZone() {
  const value = process.env.NEXT_PUBLIC_TIMEZONE || process.env.TIMEZONE || DEFAULT_TIME_ZONE
  try {
    new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: value }).format()
    return value
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

function toDate(value: Date | string | number) {
  return value instanceof Date ? value : new Date(value)
}

function numericParts(value: Date, timeZone = configuredTimeZone()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value)
  const result = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]))
  return {
    year: result.year,
    month: result.month,
    day: result.day,
    hour: result.hour,
    minute: result.minute,
    second: result.second,
  }
}

function timeZoneOffsetMs(value: Date, timeZone = configuredTimeZone()) {
  const parts = numericParts(value, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - value.getTime()
}

function fromZonedParts(parts: Omit<ZonedParts, "millisecond"> & { millisecond?: number }) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond || 0)
  let result = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess)))
  result = new Date(utcGuess - timeZoneOffsetMs(result))
  return result
}

export function getAppTimeZone() {
  return configuredTimeZone()
}

export function getZonedParts(value: Date | string | number): ZonedParts {
  const date = toDate(value)
  if (!Number.isFinite(date.getTime())) return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN, millisecond: NaN }
  const parts = numericParts(date)
  return { ...parts, millisecond: date.getMilliseconds() }
}

export function formatAppDateTime(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return "Never"
  const date = toDate(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: configuredTimeZone(), dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(date)
}

export function formatAppDate(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return "Unknown"
  const date = toDate(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: configuredTimeZone(), dateStyle: "medium" }).format(date)
}

export function formatAppTime(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return "Unknown"
  const date = toDate(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: configuredTimeZone(), hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date)
}

export function formatAppWindowDate(value: Date | string | number) {
  const date = toDate(value)
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: configuredTimeZone(), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
}

export function formatAppTrendBucket(value: Date | string | number, granularity: string) {
  const date = toDate(value)
  const options: Intl.DateTimeFormatOptions = granularity === "hourly"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : granularity === "monthly"
      ? { month: "short", year: "numeric" }
      : { month: "short", day: "numeric" }
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { ...options, timeZone: configuredTimeZone() }).format(date)
}

export function calendarDateFromInstant(value: Date | string | number) {
  const parts = getZonedParts(value)
  return Number.isFinite(parts.year) ? new Date(parts.year, parts.month - 1, parts.day) : new Date(NaN)
}

export function zonedDateTimeToDate(value: Date, time = "00:00") {
  const [hour, minute] = time.split(":").map(Number)
  return fromZonedParts({
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    second: 0,
    millisecond: 0,
  })
}

export function zonedDateStringToDate(value: string, time = "00:00") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return new Date(NaN)
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return zonedDateTimeToDate(date, time)
}

export function addZonedDays(value: Date | string | number, days: number) {
  const parts = getZonedParts(value)
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond) + days * DAY_MS)
  return fromZonedParts({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  })
}

export function startOfZonedDay(value: Date | string | number) {
  const parts = getZonedParts(value)
  return fromZonedParts({ year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0, millisecond: 0 })
}

export function startOfZonedHour(value: Date | string | number) {
  const parts = getZonedParts(value)
  return fromZonedParts({ year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: 0, second: 0, millisecond: 0 })
}

export function startOfZonedMonth(value: Date | string | number) {
  const parts = getZonedParts(value)
  return fromZonedParts({ year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 })
}

export function addZonedMonths(value: Date | string | number, months: number) {
  const parts = getZonedParts(value)
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1))
  return fromZonedParts({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 })
}

export function startOfZonedYear(value: Date | string | number) {
  const parts = getZonedParts(value)
  return fromZonedParts({ year: parts.year, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 })
}

export function mondayInAppTimeZone(value: Date | string | number = new Date()) {
  const parts = getZonedParts(value)
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const day = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1))
  return fromZonedParts({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0, millisecond: 0 })
}
