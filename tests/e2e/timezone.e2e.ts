import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"

test("browser formatting and calendar round trips use the native zone, including DST", async ({ browser }) => {
  // Exercise the browser-target bundle rather than mocking Intl or the server environment.
  const source = execFileSync("bun", ["build", "src/lib/timezone.ts", "--target", "browser"], { encoding: "utf8" })
  for (const timeZone of ["America/New_York", "Asia/Tokyo"]) {
    const context = await browser.newContext({ timezoneId: timeZone })
    const page = await context.newPage()
    await page.goto("about:blank")
    const result = await page.evaluate(async code => {
      const moduleUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
      const tz: typeof import("../../src/lib/timezone") = await import(moduleUrl)
      URL.revokeObjectURL(moduleUrl)
      const instant = "2026-08-05T00:00:00.000Z"
      const calendar = tz.calendarDateFromInstant(instant)
      return {
        zone: tz.getAppTimeZone(),
        summer: tz.formatAppDateTime(instant),
        winter: tz.formatAppDateTime("2026-01-05T00:00:00.000Z"),
        time: tz.formatAppTime(instant),
        date: tz.formatAppDate(instant),
        window: tz.formatAppWindowDate(instant),
        trend: tz.formatAppTrendBucket(instant, "hourly", "hour"),
        roundTrip: tz.zonedDateTimeToDate(calendar, tz.formatAppTime(instant).slice(0, 5)).toISOString(),
        midnight: tz.startOfZonedDay(instant).toISOString(),
        spring: tz.addZonedDays(tz.zonedDateStringToDate("2026-03-07", "12:00"), 1).toISOString(),
        fall: tz.addZonedDays(tz.zonedDateStringToDate("2026-10-31", "12:00"), 1).toISOString(),
      }
    }, source)
    expect(result.zone).toBe(timeZone)
    expect(result.roundTrip).toBe("2026-08-05T00:00:00.000Z")
    if (timeZone === "America/New_York") {
      expect(result).toMatchObject({
        summer: "4 Aug 2026, 20:00", winter: "4 Jan 2026, 19:00",
        time: "20:00:00", date: "4 Aug 2026", window: "4 Aug, 20:00", trend: "20:00",
        midnight: "2026-08-04T04:00:00.000Z", spring: "2026-03-08T16:00:00.000Z", fall: "2026-11-01T17:00:00.000Z",
      })
    } else {
      expect(result.summer).toBe("5 Aug 2026, 09:00")
      expect(result.midnight).toBe("2026-08-04T15:00:00.000Z")
    }
    await context.close()
  }
})

test("the dashboard displays the browser zone without a configuration bootstrap", async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: "America/New_York" })
  try {
    const page = await context.newPage()
    const configRequests: string[] = []
    await page.route("**/api/config", route => {
      configRequests.push(route.request().url())
      return route.abort()
    })
    await page.route("**/api/public/dashboard?*", async route => {
      const response = await route.fetch()
      const payload = await response.json()
      await route.fulfill({ response, json: {
        ...payload,
        generatedAt: "2026-08-05T00:00:00.000Z",
        range: { ...payload.range, granularity: "daily" },
        trend: [
          { bucketStart: "2026-08-05T00:00:00.000Z", label: "Server label", requests: 1, tokens: 1, costMicros: 0 },
          { bucketStart: "2026-08-06T00:00:00.000Z", label: "Server label", requests: 1, tokens: 1, costMicros: 0 },
        ],
      } })
    })
    await page.goto("/")
    await expect(page.getByText("4 Aug 2026, 20:00", { exact: true })).toBeVisible()
    await expect(page.getByRole("application").getByText("4 Aug", { exact: true })).toBeVisible()
    await expect(page.getByText("Server label", { exact: true })).toHaveCount(0)
    expect(configRequests).toEqual([])
  } finally {
    await context.close()
  }
})
