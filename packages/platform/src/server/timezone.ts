import { configureTimeZoneSource } from "@rawroute/observability/contracts/timezone"

// The browser module has no process/environment access. Preserve dynamic server
// TIMEZONE selection (including offline scripts and tests) at this adapter.
configureTimeZoneSource(() => process.env.TIMEZONE)
export {
  addZonedDays, addZonedMonths, formatAppDateTime, formatAppTrendBucket,
  getAppTimeZone, getZonedParts, mondayInAppTimeZone, startOfZonedDay,
  startOfZonedHour, startOfZonedMonth, startOfZonedYear, zonedDateStringToDate,
} from "@rawroute/observability/contracts/timezone"
