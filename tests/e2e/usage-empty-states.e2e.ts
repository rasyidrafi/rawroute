import { expect, test, type Page } from "@playwright/test"
import type { DashboardPayload } from "../../src/lib/types"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

function dashboardPayload(overrides: Partial<Pick<DashboardPayload, "trend" | "keys" | "models">> = {}): DashboardPayload {
  const trend = overrides.trend ?? []
  const keys = overrides.keys ?? []
  const models = overrides.models ?? []
  const requests = Math.max(trend.reduce((sum, row) => sum + row.requests, 0), keys.reduce((sum, row) => sum + row.requests, 0))
  const tokens = Math.max(trend.reduce((sum, row) => sum + row.tokens, 0), keys.reduce((sum, row) => sum + row.tokens, 0))
  const costMicros = Math.max(trend.reduce((sum, row) => sum + row.costMicros, 0), keys.reduce((sum, row) => sum + row.costMicros, 0))
  return {
    generatedAt: "2026-10-11T12:00:00.000Z",
    range: { label: "All time", from: "2026-10-11T00:00:00.000Z", to: "2026-10-11T12:00:00.000Z", granularity: "hourly" },
    summary: { requests, tokens, costMicros, activeKeys: keys.length, pricedRequests: requests, unpricedRequests: 0 },
    trend,
    keys,
    models,
    freshness: { source: "memory", lastEventAt: keys[0]?.lastUsed ?? null },
    pricingConfidence: { pricedRequests: requests, unpricedRequests: 0 },
  }
}

const trendRow = { bucketStart: "2026-10-11T10:00:00.000Z", label: "10 AM", requests: 5, tokens: 120, costMicros: 15000 }

for (const publicView of [false, true]) test(`${publicView ? "public" : "workspace"} incomplete historical coverage does not claim quiet zero usage`, async ({ page }) => {
  const payload = dashboardPayload()
  payload.coverage = { partial: true, excludedSources: 1, tokenCoveredRequests: 0, statusCoveredRequests: 0, costCoveredRequests: 0, modelCoveredRequests: 0, keyCoveredRequests: 0, durationCount: 0, financialUnavailable: true, unsupportedTrendSources: 0 }
  await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", route => route.fulfill({ json: payload }))
  if (publicView) await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "default", name: "Default", isDefault: true }] } }))
  else await authenticate(page)
  await page.goto(publicView ? "/" : "/dashboard/ai/overview/usage")
  await expect(page.getByText("Partial analytics coverage", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(4)
  await expect(page.getByText("Usage unavailable", { exact: true })).toBeVisible()
  await expect(page.getByText("No usage yet", { exact: true })).toHaveCount(0)
  await expect(page.getByText(/unavailable data is not zero usage/)).toHaveCount(0)
})
const keyRow: DashboardPayload["keys"][number] = {
  id: "usage-empty-state-key",
  label: "E2E Usage Key",
  maskedKey: "sk-••••-test",
  requests: 5,
  tokens: 120,
  costMicros: 15000,
  models: ["gpt-5-e2e"],
  lastUsed: "2026-10-11T10:30:00.000Z",
}
const modelRow: DashboardPayload["models"][number] = { model: "gpt-5-e2e", requests: 5, tokens: 120, costMicros: 15000 }

for (const publicView of [false, true]) {
  test(`${publicView ? "public" : "workspace"} trend keeps dense hourly and daily points with responsive time ticks`, async ({ page }) => {
    await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", route => {
      const granularity = new URL(route.request().url()).searchParams.get("preset") === "today" ? "hourly" : "daily"
      const payload = dashboardPayload({ trend: Array.from({ length: granularity === "hourly" ? 24 : 31 }, (_, index) => ({ ...trendRow, bucketStart: new Date(Date.UTC(2026, 9, 1) + index * (granularity === "hourly" ? 3_600_000 : 86_400_000)).toISOString(), tokens: index === 0 ? 0 : index * 1000 })) })
      payload.range.granularity = granularity
      return route.fulfill({ json: payload })
    })
    if (publicView) await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "default", name: "Default", isDefault: true }] } }))
    else await authenticate(page)
    for (const grouping of ["hourly", "daily"] as const) {
      await page.emulateMedia({ colorScheme: grouping === "hourly" ? "light" : "dark" })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(publicView ? "/" : "/dashboard/ai/overview/usage")
      await page.locator("section").filter({ has: page.getByRole("heading", { name: "Usage dashboard", exact: true }) }).getByRole("combobox").first().click()
      await page.getByRole("option", { name: grouping === "hourly" ? "Today" : "This month", exact: true }).click()
      const selectedRangeLabel = await page.evaluate(({ from, to }) => {
        const date = (instant: string) => {
          const value = new Date(instant)
          return `${value.toLocaleString("en-US", { month: "short" })} ${String(value.getDate()).padStart(2, "0")}, ${value.getFullYear()}`
        }
        return `${date(from)} - ${date(to)}`
      }, dashboardPayload().range)
      await expect(page.getByRole("button", { name: selectedRangeLabel, exact: true })).toBeVisible()
      const trend = page.getByRole("img", { name: "Token usage trend" })
      await expect(trend.locator(".recharts-area-curve")).toHaveCount(2)
      await expect.poll(async () => ((await trend.locator(".recharts-area-curve").first().getAttribute("d"))?.match(/C/g) ?? []).length).toBe(grouping === "hourly" ? 23 : 30)
      const ticks = trend.locator(".recharts-xAxis-tick-labels text")
      await expect.poll(() => ticks.count()).toBeGreaterThan(2)
      const desktopTicks = await ticks.count()
      const path = await trend.locator(".recharts-area-curve").first().getAttribute("d")
      expect((path?.match(/C/g) ?? []).length).toBe(grouping === "hourly" ? 23 : 30)
      await page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(() => ticks.count()).toBeLessThan(desktopTicks)
      await expect(trend.locator(".recharts-legend-wrapper")).toHaveText("CostTokens")
      await expect(trend.locator(".recharts-area-curve").first()).toHaveAttribute("stroke", "var(--primary)")
      const card = page.locator('[data-slot="card"]').filter({ has: trend })
      await expect(card.locator('[data-slot="card-action"]')).toHaveCount(0)
      await page.mouse.move(0, 0)
      await trend.getByRole("application").focus()
      for (let index = 0; index < 31; index++) await page.keyboard.press("ArrowLeft")
      const tooltip = trend.locator(".recharts-tooltip-wrapper")
      await expect(tooltip).toContainText("Tokens0")
      await expect(tooltip).toContainText("Cost$0.015")
      if (grouping === "hourly") await expect(tooltip).toContainText(/\d{2}:\d{2}/)
      else await expect(tooltip).not.toContainText(/\d{2}:\d{2}/)
    }
  })
}

for (const publicView of [false, true]) {
  test(`${publicView ? "public" : "workspace"} top keys chart fits sparse and full rankings`, async ({ page }) => {
    if (!publicView) await authenticate(page)
    else await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "default", name: "Default", isDefault: true }] } }))
    let count = 1
    await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", route => route.fulfill({ json: dashboardPayload({
      trend: [trendRow],
      keys: Array.from({ length: count }, (_, index) => ({ ...keyRow, id: `key-${index}`, label: `Usage key ${index}`, costMicros: (index + 1) * 15000 })),
    }) }))
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      let previousListHeight: number | undefined
      for (count of [1, 2, 4, 5, 7]) {
        await page.goto(publicView ? "/" : "/dashboard/ai/overview/usage")
        const card = page.locator('[data-slot="card"]').filter({ has: page.getByText("Top keys by cost", { exact: true }) })
        const chart = card.locator('[data-slot="chart"]')
        const bars = chart.locator('.recharts-bar-rectangle path')
        const visibleCount = Math.min(count, 5)
        await expect(bars).toHaveCount(visibleCount)
        await expect.poll(() => chart.evaluate(element => element.getBoundingClientRect().height)).toBe(220)
        await expect.poll(() => chart.locator('.recharts-cartesian-grid-vertical line').evaluateAll(lines => lines.length > 0 && lines.every(line => Math.abs(Number(line.getAttribute('y2')) - Number(line.getAttribute('y1'))) === 210))).toBe(true)
        await expect.poll(() => bars.evaluateAll(elements => elements.every(element => {
          const height = element.getBoundingClientRect().height
          return height > 0 && height <= 28.5
        }))).toBe(true)
        const chartBounds = (await chart.boundingBox())!
        const listBounds = (await card.locator('[data-slot="scroll-area"]').boundingBox())!
        if (previousListHeight !== undefined) expect(listBounds.height).toBe(previousListHeight)
        expect(listBounds.y).toBeGreaterThanOrEqual(chartBounds.y + chartBounds.height)
        previousListHeight = listBounds.height
        const barBounds = await bars.evaluateAll(elements => elements.map(element => {
          const bounds = element.getBoundingClientRect()
          return { y: bounds.y, height: bounds.height }
        }))
        for (const [index, bounds] of barBounds.entries()) {
          expect(bounds.height).toBeCloseTo(28, 0)
          expect(bounds.y - chartBounds.y).toBeCloseTo(12 + index * 42, 0)
        }
        await expect(card.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-label').filter({ hasText: /Usage key/ })).toHaveCount(visibleCount)
        await expect(card.getByText("TBD", { exact: true })).toHaveCount(0)
        await expect(card.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-label').first()).toHaveText(new RegExp(`Usage key\\s*${count - 1}`))
        await expect(card.locator('[data-slot="scroll-area"] .text-sm.font-medium')).toHaveCount(visibleCount * 2)
        await expect(card.locator('[data-slot="scroll-area"]').getByText(`Usage key ${count - 1}`, { exact: true })).toBeVisible()
        const trend = page.locator('[data-slot="card"]').filter({ has: page.getByText("Usage Trend", { exact: true }) })
        expect((await card.boundingBox())!.height).toBe((await trend.boundingBox())!.height)
        await bars.first().hover({ force: true })
        await expect(chart.locator('.recharts-tooltip-wrapper').getByText("Cost", { exact: true })).toBeVisible()
        for (let slot = visibleCount; slot < 5; slot++) {
          await page.mouse.move(chartBounds.x + chartBounds.width / 2, chartBounds.y + 5 + slot * 42 + 21)
          await expect(chart.locator('.recharts-tooltip-wrapper').getByText("Cost", { exact: true })).not.toBeVisible()
        }
        await page.mouse.move(0, 0)
        await chart.getByRole("application").focus()
        await expect(chart.locator('.recharts-tooltip-wrapper').getByText("Cost", { exact: true })).toBeVisible()
        await expect(chart.locator('.recharts-tooltip-wrapper').getByText(`Usage key ${count - 1}`, { exact: true })).toBeVisible()
        for (let index = 1; index < visibleCount; index++) {
          await page.keyboard.press("ArrowLeft")
          await expect(chart.locator('.recharts-tooltip-wrapper').getByText(`Usage key ${count - 1 - index}`, { exact: true })).toBeVisible()
        }
        await page.keyboard.press("ArrowLeft")
        if (visibleCount === 5) {
          await expect(chart.locator('.recharts-tooltip-wrapper').getByText(`Usage key ${count - visibleCount}`, { exact: true })).toBeVisible()
        } else {
          for (let slot = visibleCount; slot < 5; slot++) {
            await expect(chart.locator('.recharts-tooltip-wrapper').getByText("Cost", { exact: true })).not.toBeVisible()
            await expect(chart.locator('.recharts-tooltip-wrapper')).not.toContainText("TBD")
            if (slot < 4) await page.keyboard.press("ArrowLeft")
          }
          for (let slot = 4; slot >= visibleCount; slot--) await page.keyboard.press("ArrowRight")
          await expect(chart.locator('.recharts-tooltip-wrapper').getByText(`Usage key ${count - visibleCount}`, { exact: true })).toBeVisible()
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      }
    }
  })
}

for (const publicView of [false, true]) {
  test(`${publicView ? "public" : "workspace"} usage responsive panels match their loading layout`, async ({ page }) => {
    let release!: () => void
    let markReached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { markReached = resolve })
    await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", async route => {
      markReached()
      await gate
      await route.fulfill({ json: dashboardPayload({ trend: [trendRow], keys: [keyRow], models: [modelRow] }) })
    })
    if (publicView) await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "default", name: "Default", isDefault: true }] } }))
    else await authenticate(page)
    await page.goto(publicView ? "/" : "/dashboard/ai/overview/usage")
    await reached
    await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toBeVisible()

    for (const loading of [true, false]) {
      if (!loading) {
        release()
        await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toHaveCount(0)
        await expect(page.getByText("E2E Usage Key", { exact: true }).first()).toBeVisible()
      }
      for (const width of [1600, 1280, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 900 })
        if (!publicView && width >= 768) await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeVisible()
        const card = (title: string) => page.locator('[data-slot="card"]').filter({ has: page.getByText(title, { exact: true }) })
        expect(await card("Most used models").evaluate(element => getComputedStyle(element).alignSelf)).toBe(width >= 1280 ? "stretch" : "flex-start")
        for (const [title, description] of [["Usage Trend", "Token usage over time"], ["Top keys by cost", "Concentration"], ["Usage table", "Per-key detail"], ["Most used models", "Ranked by recorded requests"]] as const) {
          const header = card(title).locator('[data-slot="card-header"]')
          await expect(header.locator('[data-slot="card-title"]')).toHaveText(title)
          await expect(header.locator('[data-slot="card-description"]')).toHaveText(description)
          await expect(header.locator('[data-slot="card-title"] + [data-slot="card-description"]')).toHaveCount(1)
          const titleBounds = (await header.locator('[data-slot="card-title"]').boundingBox())!
          const descriptionBounds = (await header.locator('[data-slot="card-description"]').boundingBox())!
          expect(descriptionBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height)
        }
        for (const [leftTitle, rightTitle] of [["Usage Trend", "Top keys by cost"], ["Usage table", "Most used models"]] as const) {
          const left = (await card(leftTitle).boundingBox())!
          const right = (await card(rightTitle).boundingBox())!
          if (width >= 1280) {
            expect(Math.abs(left.y - right.y)).toBeLessThan(1)
            expect(Math.abs(left.height - right.height)).toBeLessThan(1)
            expect(right.x).toBeGreaterThanOrEqual(left.x + left.width)
            expect(right.width).toBeGreaterThanOrEqual(360)
          } else {
            expect(right.y).toBeGreaterThanOrEqual(left.y + left.height)
            expect(Math.abs(left.x - right.x)).toBeLessThan(1)
            if (rightTitle === "Most used models") expect(right.height).toBeLessThan(left.height)
          }
        }
        const summary = page.locator('[data-slot="usage-summary"] > .grid')
        expect(await summary.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(width >= 1280 ? 4 : width >= 640 ? 2 : 1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        const usageTable = card("Usage table")
        await expect(usageTable.getByRole("columnheader", { name: "Actions", exact: true })).toHaveCount(publicView ? 0 : 1)
        await expect(usageTable.locator("tbody tr").first().locator("td")).toHaveCount(publicView ? 8 : 9)
        if (loading && !publicView) {
          const actionSkeleton = usageTable.locator("tbody tr").first().locator("td").last().locator('[data-slot="skeleton"]')
          await expect(actionSkeleton).toHaveCSS("width", "28px")
          await expect(actionSkeleton).toHaveCSS("height", "28px")
        }
        const orderLabel = usageTable.getByText("Order rows by", { exact: true })
        const orderControl = orderLabel.locator("..").locator(loading ? '[data-slot="skeleton"]' : '[data-slot="select-trigger"]')
        const labelBounds = (await orderLabel.boundingBox())!
        const controlBounds = (await orderControl.boundingBox())!
        expect(controlBounds.x).toBeGreaterThanOrEqual(labelBounds.x + labelBounds.width)
        expect(Math.abs(labelBounds.y + labelBounds.height / 2 - controlBounds.y - controlBounds.height / 2)).toBeLessThan(1)
        await expect(usageTable).toHaveCSS("height", "640px")
        await expect(usageTable).not.toHaveCSS("box-shadow", "none")
        await expect(usageTable).toHaveCSS("border-radius", "14px")
        const tableWrapper = usageTable.locator('[data-slot="scroll-area"]').first()
        for (const side of ["top", "right", "bottom", "left"]) await expect(tableWrapper).toHaveCSS(`border-${side}-width`, "0px")
        await expect(tableWrapper).toHaveCSS("border-radius", "0px")
        await expect(usageTable.locator('thead tr')).toHaveCSS("border-bottom-width", "1px")
        await expect(usageTable.locator('tbody tr').last()).toHaveCSS("border-bottom-width", "0px")
        if (loading) await expect(usageTable.locator('tbody tr').first()).toHaveCSS("border-bottom-width", "1px")
        const tableViewport = usageTable.locator('[data-slot="scroll-area-viewport"]').first()
        expect(await tableViewport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
        await tableViewport.evaluate(element => { element.scrollLeft = 100 })
        await expect.poll(() => tableViewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
        if (!publicView) {
          const actions = usageTable.getByRole("columnheader", { name: "Actions", exact: true })
          const actionCell = usageTable.locator("tbody tr").first().locator("td").last()
          const content = actionCell.locator(loading ? '[data-slot="skeleton"]' : 'a')
          await expect(actions).toHaveCSS("position", "sticky")
          await expect(actionCell).toHaveCSS("position", "sticky")
          const before = (await actionCell.boundingBox())!
          const viewportBox = (await tableViewport.boundingBox())!
          expect(Math.abs(before.x + before.width - viewportBox.x - viewportBox.width)).toBeLessThanOrEqual(2)
          const contentBox = (await content.boundingBox())!
          expect(Math.abs(contentBox.x + contentBox.width / 2 - before.x - before.width / 2)).toBeLessThan(1)
          await tableViewport.evaluate(element => { element.scrollLeft = element.scrollWidth })
          const after = (await actionCell.boundingBox())!
          expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1)
        }
      }
    }
  })
}

test("usage row opens live key detail with matching cards, chart tooltips and budget states", async ({ page }, testInfo) => {
  await authenticate(page)
  const real = await page.request.get("/api/admin/usage/keys/usage-empty-state-key", { headers: { "x-rawroute-workspace-id": "default" } })
  expect(real.ok()).toBe(true)
  expect((await real.json()).summary.requests).toBe(0)
  expect((await page.request.get("/api/admin/usage/keys/usage-empty-state-key")).status()).toBe(400)
  await page.route("**/api/admin/usage?*", route => route.fulfill({ json: dashboardPayload({ trend: [trendRow], keys: [keyRow], models: [modelRow] }) }))
  const budget = { enabled: true, weeklyLimitMicros: 1_000_000, spentMicros: 15000, remainingMicros: 985000, percentUsed: 1.5, bypassLimits: false, usageStartAt: "2026-10-11T00:00:00.000Z", windowStart: "2026-10-11T00:00:00.000Z", windowEnd: "2026-10-18T00:00:00.000Z" }
  let payload = dashboardPayload({ trend: [{ ...trendRow, bucketStart: "2026-10-11T00:00:00.000Z", costMicros: 6000 }, { ...trendRow, bucketStart: "2026-10-12T00:00:00.000Z", costMicros: 9000 }], keys: [{ ...keyRow, budget }], models: [modelRow] })
  payload.range.granularity = "daily"
  payload.range.from = budget.windowStart
  payload.range.to = budget.windowEnd
  await page.route("**/api/admin/usage/keys/usage-empty-state-key", route => route.fulfill({ json: payload }))
  await page.route("**/api/admin/request-logs?*", route => {
    const params = new URL(route.request().url()).searchParams
    expect(params.get("key")).toBe(keyRow.id)
    expect(params.get("from")).toBe(payload.range.from)
    expect(params.get("to")).toBe(payload.range.to)
    return route.fulfill({ json: { events: [], models: [], keys: [{ id: keyRow.id, name: keyRow.label }], nextCursor: null, from: params.get("from"), to: params.get("to") } })
  })
  await page.goto("/dashboard/ai/overview/usage")
  const action = page.getByRole("link", { name: "View usage for E2E Usage Key", exact: true })
  await expect(action).toHaveAttribute("href", "/dashboard/ai/overview/usage/keys/usage-empty-state-key")
  await action.click()
  await expect(page).toHaveURL(/\/usage\/keys\/usage-empty-state-key$/)
  await expect(page.getByRole("heading", { name: "E2E Usage Key", exact: true })).toBeVisible()
  await expect(page.getByRole("tab")).toHaveCount(0)
  await expect(page.getByText(/sample|dummy|design preview|illustrative/i)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  const card = (title: string) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${title}$`) }) })
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [first, second] of [["Budget balance", "Daily spend"], ["Where the spend goes", "Usage profile"]]) {
      const left = (await card(first!).boundingBox())!
      const right = (await card(second!).boundingBox())!
      if (width >= 1024) {
        expect(Math.abs(left.y - right.y)).toBeLessThan(1)
        expect(Math.abs(left.height - right.height)).toBeLessThan(1)
      } else expect(right.y).toBeGreaterThanOrEqual(left.y + left.height)
    }
    await card("Daily spend").locator(".recharts-bar-rectangle").first().hover()
    await expect(card("Daily spend").locator(".recharts-tooltip-wrapper")).toContainText("Cost")
    await expect(card("Daily spend").locator(".recharts-tooltip-wrapper")).toContainText("$0.006")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: testInfo.outputPath(`key-usage-live-${width}.png`), fullPage: true })
  }
  payload = { ...payload, keys: [{ ...keyRow }] }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card("Budget balance").getByText("No budget configured", { exact: true })).toBeVisible()
  await expect(card("Budget balance").getByText("Unlimited", { exact: true })).toBeVisible()
  await expect(card("Budget balance").getByRole("progressbar")).toHaveCount(0)
  payload = { ...payload, keys: [{ ...keyRow, budget: { ...budget, enabled: false } }] }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card("Budget balance").getByText("Budget limits disabled", { exact: true })).toBeVisible()
  await expect(card("Budget balance").getByRole("progressbar")).toHaveCount(0)
  payload = { ...payload, keys: [{ ...keyRow, budget: { ...budget, bypassLimits: true } }] }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card("Budget balance").getByText("Unlimited mode active", { exact: true })).toBeVisible()
  payload = { ...payload, keys: [{ ...keyRow, budget: { ...budget, usageAvailable: false, spentMicros: null, remainingMicros: null, percentUsed: null } }], coverage: { partial: true, excludedSources: 1, tokenCoveredRequests: 0, statusCoveredRequests: 0, costCoveredRequests: 0, modelCoveredRequests: 0, keyCoveredRequests: 0, durationCount: 0, financialUnavailable: true, unsupportedTrendSources: 0 } }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card("Budget balance").getByText("Remaining balance unavailable", { exact: true })).toBeVisible()
  await expect(card("Daily spend").getByText("Spend history unavailable: financial coverage is incomplete.", { exact: true })).toBeVisible()
  await expect(card("Budget balance").getByRole("progressbar")).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { name: "E2E Usage Key", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Back to usage", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/ai\/overview\/usage$/)
})

for (const publicView of [false, true]) {
  test(`${publicView ? "public" : "workspace"} usage pairs retain natural empty and stacked heights`, async ({ page }) => {
    let payload = dashboardPayload()
    await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", route => route.fulfill({ json: payload }))
    if (publicView) await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "default", name: "Default", isDefault: true }] } }))
    else await authenticate(page)
    for (const data of [{ keys: [keyRow] }, { models: [modelRow] }, { trend: [trendRow] }, {}]) {
      payload = dashboardPayload(data)
      await page.goto(publicView ? "/" : "/dashboard/ai/overview/usage")
      if (!payload.keys.length && !payload.models.length && !payload.trend.length) {
        await expect(page.getByText("No usage yet", { exact: true })).toBeVisible()
        await expect(page.getByText("Usage table", { exact: true })).toHaveCount(0)
        continue
      }
      const panel = (title: string) => page.locator('[data-slot="card"], [data-slot="empty-state"]').filter({ has: page.getByText(title, { exact: true }) })
      const left = panel(payload.keys.length ? "Usage table" : "No table rows")
      const right = panel(payload.models.length ? "Most used models" : "No model usage")
      await expect(left).toBeVisible()
      await expect(right).toBeVisible()
      for (const width of [1280, 1600, 390]) {
        await page.setViewportSize({ width, height: 900 })
        const a = (await left.boundingBox())!
        const b = (await right.boundingBox())!
        if (width >= 1280) {
          expect(Math.abs(a.y - b.y)).toBeLessThan(1)
          expect(Math.abs(a.height - b.height)).toBeLessThan(1)
        } else {
          expect(b.y).toBeGreaterThanOrEqual(a.y + a.height)
          expect(b.height).toBeLessThan(640)
          if (payload.keys.length) expect(a.height).toBe(640)
          else expect(a.height).toBeLessThan(640)
        }
      }
    }
  })

  test(`${publicView ? "public" : "workspace"} usage ranks all models by requests, not spend`, async ({ page }) => {
    const payload = dashboardPayload({
      trend: [{ ...trendRow, requests: 100_000 }],
      keys: [{ ...keyRow, requests: 1200 }],
      models: [
        { ...modelRow, model: "Expensive", requests: 1000, costMicros: 9_000_000 },
        { ...modelRow, model: "Popular", requests: 50_000, tokens: 43_542, costMicros: 10 },
        ...[4000, 3000, 2000, 1000].map((requests, index) => ({ ...modelRow, model: `Other ${index}`, requests })),
      ],
    })
    await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", route => route.fulfill({ json: payload }))
    if (publicView) await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "default", name: "Default", isDefault: true }] } }))
    else await authenticate(page)
    await page.goto(publicView ? "/" : "/dashboard/ai/overview/usage")
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText("Most used models", { exact: true }) })
    await expect(card.getByText("Ranked by recorded requests", { exact: true })).toBeVisible()
    await expect(card.getByRole("progressbar")).toHaveCount(6)
    await expect(card.getByRole("progressbar").first()).toHaveAttribute("aria-label", "Popular: 50.0 percent of requests")
    await expect(card.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "50")
    await expect(card.getByRole("progressbar").nth(1)).toHaveAttribute("aria-label", "Other 0: 4.0 percent of requests")
    await expect(card.getByText("50k requests · 43.5K tokens", { exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="usage-summary"]').getByText("100k", { exact: true })).toBeVisible()
    await expect(page.getByText("1.2k requests", { exact: true })).toBeVisible()
    await expect(page.getByRole("cell", { name: "1.2k", exact: true })).toBeVisible()
    const trend = page.locator('[data-slot="card"]').filter({ has: page.getByText("Usage Trend", { exact: true }) })
    await expect(trend.getByRole("application").getByText("30", { exact: true })).toBeVisible()
    await trend.getByRole("application").focus()
    await page.keyboard.press("ArrowRight")
    await expect(trend.locator(".recharts-tooltip-wrapper").getByText("120", { exact: true })).toBeVisible()
    await expect(card.getByText("$0.00001", { exact: true })).toBeVisible()
    await expect(card.getByRole("link")).toHaveCount(0)
    await expect(card.locator("a")).toHaveCount(0)
    await expect(card.locator("svg.recharts-surface")).toHaveCount(0)
    await expect(page.getByText("Spend allocation", { exact: true })).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

for (const view of ["workspace", "public-light", "public-dark"] as const) {
test(`${view} usage shares compact tokens and precise costs across summary, lists, and table`, async ({ page }) => {
  const publicView = view !== "workspace"
  await page.emulateMedia({ colorScheme: view === "public-dark" ? "dark" : "light" })
  const payload = dashboardPayload({
    trend: [{ ...trendRow, tokens: 28_500_000, costMicros: 10 }],
    keys: [{ ...keyRow, tokens: 43_542, costMicros: 10 }],
    models: [{ ...modelRow, tokens: 43_542, costMicros: 10 }],
  })
  const dashboardRequests: string[] = []
  const dashboardWorkspaces: (string | null)[] = []
  await page.route(publicView ? "**/api/public/dashboard?*" : "**/api/admin/usage?*", route => {
    dashboardRequests.push(route.request().headers()["x-rawroute-workspace-id"] ?? "")
    dashboardWorkspaces.push(new URL(route.request().url()).searchParams.get("workspace"))
    return route.fulfill({ json: payload })
  })
  if (publicView) await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "parity-public", name: "Public workspace", isDefault: true }] } }))
  else await authenticate(page)
  await page.goto(publicView ? "/?workspace=parity-public" : "/dashboard/ai/overview/usage")
  await expect(page.getByText("28.5M", { exact: true })).toBeVisible()
  await expect(page.getByRole("cell", { name: "43.5K", exact: true })).toBeVisible()
  await expect(page.getByText("5 requests · 43.5K tokens", { exact: true })).toBeVisible()
  await expect(page.getByText("$0.00001", { exact: true })).toHaveCount(5)
  if (publicView) {
    await expect(page.getByRole("heading", { name: "Usage dashboard", exact: true })).toHaveClass(/text-2xl/)
    for (const description of ["Input + cached input + output tokens", "Recorded model attempts in this period", "Based on configured model rates", "Keys that handled traffic in this window."]) {
      await expect(page.getByText(description, { exact: true })).toBeVisible()
    }
    await expect(page.getByText(keyRow.maskedKey, { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Admin login", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCSS("height", "28px")
    await expect(page.locator("html")).toHaveClass(new RegExp(view === "public-dark" ? "dark" : "light"))
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect.poll(() => dashboardRequests.length).toBe(2)
    expect(dashboardRequests).toEqual(["", ""])
    expect(dashboardWorkspaces).toEqual(["parity-public", "parity-public"])
  }
})
}

test("overview usage keeps loading, empty, sparse, and populated panels in sync", async ({ page }) => {
  const responses = [
    dashboardPayload({ trend: [trendRow] }),
    dashboardPayload({ keys: [keyRow] }),
    dashboardPayload({ trend: [trendRow], keys: [keyRow], models: [modelRow] }),
  ]
  let usageRequestCount = 0
  const workspaceHeaders: string[] = []
  let markInitialRequestReached!: () => void
  let releaseInitialRequest!: () => void
  let markRefreshReached!: () => void
  let releaseRefresh!: () => void
  const initialRequestReached = new Promise<void>(resolve => { markInitialRequestReached = resolve })
  const initialRequestGate = new Promise<void>(resolve => { releaseInitialRequest = resolve })
  const refreshReached = new Promise<void>(resolve => { markRefreshReached = resolve })
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })

  await page.route("**/api/admin/usage?*", async route => {
    const requestIndex = usageRequestCount++
    workspaceHeaders.push(route.request().headers()["x-rawroute-workspace-id"] ?? "")
    if (requestIndex === 0) {
      markInitialRequestReached()
      await initialRequestGate
      await route.fulfill({ json: dashboardPayload() })
      return
    }
    if (requestIndex === 4) {
      markRefreshReached()
      await refreshGate
      await route.fulfill({ json: responses[2] })
      return
    }
    await route.fulfill({ json: responses[Math.min(requestIndex - 1, responses.length - 1)] })
  })

  await authenticate(page)
  await page.goto("/dashboard/ai/overview/usage")
  await initialRequestReached
  await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toBeVisible()
  await expect(page.getByText("No usage yet", { exact: true })).toHaveCount(0)

  releaseInitialRequest()
  await expect(page.getByText("No usage yet", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="empty-state"][data-treatment="card"]').filter({ hasText: "No usage yet" })).toHaveCount(1)

  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("No key activity", { exact: true })).toBeVisible()
  await expect(page.getByText("No table rows", { exact: true })).toBeVisible()
  await expect(page.getByText("No model usage", { exact: true })).toBeVisible()
  await expect(page.getByText("Usage Trend", { exact: true })).toBeVisible()
  await expect(page.getByText("No usage yet", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("No trend data", { exact: true })).toBeVisible()
  await expect(page.getByText("No model usage", { exact: true })).toBeVisible()
  await expect(page.getByText("E2E Usage Key", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("No key activity", { exact: true })).toHaveCount(0)
  await expect(page.getByText("No table rows", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("gpt-5-e2e", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Usage Trend", { exact: true })).toBeVisible()
  await expect(page.getByText("No trend data", { exact: true })).toHaveCount(0)
  await expect(page.getByText("No model usage", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await refreshReached
  await expect(page.getByText("Refreshing data...", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("E2E Usage Key", { exact: true }).first()).toBeVisible()
  await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toHaveCount(0)
  releaseRefresh()
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(0)

  expect(workspaceHeaders).toHaveLength(5)
  expect(workspaceHeaders).toEqual(["default", "default", "default", "default", "default"])
})
