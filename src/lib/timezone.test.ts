import { afterEach, describe, expect, test } from "vitest"

import { addZonedDays, formatAppDateTime, formatAppTrendBucket, getAppTimeZone, mondayInAppTimeZone, startOfZonedDay, zonedDateStringToDate } from "@/lib/timezone"

const originalTimezone = process.env.TIMEZONE
const originalPublicTimezone = process.env.NEXT_PUBLIC_TIMEZONE

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TIMEZONE
  else process.env.TIMEZONE = originalTimezone
  if (originalPublicTimezone === undefined) delete process.env.NEXT_PUBLIC_TIMEZONE
  else process.env.NEXT_PUBLIC_TIMEZONE = originalPublicTimezone
})

describe("application timezone", () => {
  test("defaults to Jakarta and formats in 24-hour time", () => {
    delete process.env.NEXT_PUBLIC_TIMEZONE
    delete process.env.TIMEZONE
    expect(getAppTimeZone()).toBe("Asia/Jakarta")
    expect(formatAppDateTime("2026-08-05T00:00:00.000Z")).toContain("5 Aug 2026, 07:00")
  })

  test("supports a configured timezone override", () => {
    delete process.env.NEXT_PUBLIC_TIMEZONE
    process.env.TIMEZONE = "America/New_York"
    expect(getAppTimeZone()).toBe("America/New_York")
    expect(formatAppDateTime("2026-08-05T00:00:00.000Z")).toContain("4 Aug 2026, 20:00")
  })

  test("converts calendar dates and weekly boundaries in the configured zone", () => {
    delete process.env.NEXT_PUBLIC_TIMEZONE
    process.env.TIMEZONE = "Asia/Jakarta"
    expect(zonedDateStringToDate("2026-08-05", "13:30").toISOString()).toBe("2026-08-05T06:30:00.000Z")
    expect(startOfZonedDay("2026-08-04T18:00:00.000Z").toISOString()).toBe("2026-08-04T17:00:00.000Z")
    expect(mondayInAppTimeZone("2026-08-05T00:00:00.000Z").toISOString()).toBe("2026-08-02T17:00:00.000Z")
    expect(addZonedDays("2026-08-03T17:00:00.000Z", 7).toISOString()).toBe("2026-08-10T17:00:00.000Z")
  })

  test("uses hour-only labels for hourly today and yesterday trends", () => {
    delete process.env.NEXT_PUBLIC_TIMEZONE
    delete process.env.TIMEZONE
    expect(formatAppTrendBucket("2026-08-06T02:00:00.000Z", "hourly", "hour")).toBe("09:00")
  })
})
