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
      for (const width of [1440, 1280, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 900 })
        if (!publicView && width >= 768) await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeVisible()
        const card = (title: string) => page.locator('[data-slot="card"]').filter({ has: page.getByText(title, { exact: true }) })
        if (!loading) expect(await card("Most used models").evaluate(element => getComputedStyle(element).alignSelf)).toBe("flex-start")
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
            expect(right.x).toBeGreaterThanOrEqual(left.x + left.width)
            expect(right.width).toBeGreaterThanOrEqual(360)
          } else {
            expect(right.y).toBeGreaterThanOrEqual(left.y + left.height)
            expect(Math.abs(left.x - right.x)).toBeLessThan(1)
          }
        }
        const summary = page.locator('[data-slot="usage-summary"] > .grid')
        expect(await summary.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(width >= 1280 ? 4 : width >= 640 ? 2 : 1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        const tableViewport = card("Usage table").locator('[data-slot="scroll-area-viewport"]').first()
        expect(await tableViewport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      }
    }
  })
}

for (const publicView of [false, true]) {
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
    await expect(trend.getByRole("application").getByText("25k", { exact: true })).toBeVisible()
    await trend.getByRole("application").focus()
    await page.keyboard.press("ArrowRight")
    await expect(trend.locator(".recharts-tooltip-wrapper").getByText("100k", { exact: true })).toBeVisible()
    await expect(card.getByText("$0.00001", { exact: true })).toBeVisible()
    await expect(card.getByRole("link")).toHaveCount(0)
    await expect(card.locator("a")).toHaveCount(0)
    await expect(card.locator("svg.recharts-surface")).toHaveCount(0)
    await expect(page.getByText("Spend allocation", { exact: true })).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test("usage shares compact tokens and precise costs across summary, lists, and table", async ({ page }) => {
  const payload = dashboardPayload({
    trend: [{ ...trendRow, tokens: 28_500_000, costMicros: 10 }],
    keys: [{ ...keyRow, tokens: 43_542, costMicros: 10 }],
    models: [{ ...modelRow, tokens: 43_542, costMicros: 10 }],
  })
  await page.route("**/api/admin/usage?*", route => route.fulfill({ json: payload }))
  await authenticate(page)
  await page.goto("/dashboard/ai/overview/usage")
  await expect(page.getByText("28.5M", { exact: true })).toBeVisible()
  await expect(page.getByRole("cell", { name: "43.5K", exact: true })).toBeVisible()
  await expect(page.getByText("5 requests · 43.5K tokens", { exact: true })).toBeVisible()
  await expect(page.getByText("$0.00001", { exact: true })).toHaveCount(4)
})

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
