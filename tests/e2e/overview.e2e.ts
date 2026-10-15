import { expect, test } from "@playwright/test"

test("Overview loads scoped aggregates and four compact recent attempts with retry and rolling controls", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() }
  // Exercise the real registered endpoint before using deterministic UI fixtures.
  const to = Date.now()
  const params = new URLSearchParams({ from: new Date(to - 86_400_000).toISOString(), to: new Date(to).toISOString() })
  const response = await page.request.get(`/api/admin/overview?${params}`, { headers: { "x-rawroute-workspace-id": "default" } })
  expect(response.ok()).toBe(true)
  expect((await response.json()).summary.requests).toBe(0)
  expect((await page.request.get(`/api/admin/overview?${params}`)).status()).toBe(400)
  expect((await page.request.get("/api/admin/overview?from=bad&to=bad", { headers: { "x-rawroute-workspace-id": "default" } })).status()).toBe(400)

  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let fail = false
  let failRecent = false
  let holdNext = false
  let releaseOld: (() => void) | undefined
  let heldUrl = ""
  let sparse = false
  const aggregateRanges: URLSearchParams[] = []
  const recentRanges: URLSearchParams[] = []
  await page.route("**/api/admin/overview?*", async route => {
    expect(route.request().headers()["x-rawroute-workspace-id"]).toBeTruthy()
    const query = new URL(route.request().url()).searchParams
    aggregateRanges.push(query)
    const held = holdNext
    holdNext = false
    if (held) { heldUrl = route.request().url(); await new Promise<void>(resolve => { releaseOld = resolve }) }
    await gate
    if (fail) { await route.fulfill({ status: 500, json: { error: { message: "Unavailable" } } }); return }
    await route.fulfill({ json: {
      generatedAt: range.to, range: { from: query.get("from"), to: query.get("to"), granularity: "hourly" },
      summary: { requests: 40, tokens: held ? 9999 : 4800, costMicros: 2500000, activeKeys: 1, pricedRequests: 35, unpricedRequests: 1 },
      overview: { inputTokens: sparse ? 0 : 4000, cacheReadTokens: sparse ? 0 : 1000, failedRequests: 4, statusCoveredRequests: sparse ? 0 : 40, durationCount: sparse ? 0 : 38, durationSumMs: sparse ? 0 : 76000, budgets: [{ id: "quiet", name: "Quiet key", enabled: true, limitMicros: 10000000, spentMicros: 1000000 }], budgetWindow: { ...range, bypassLimits: false } },
      models: [{ model: "Real model", requests: 40, tokens: 4800, costMicros: 2500000 }], keys: [], trend: [{ bucketStart: query.get("from"), tokens: 1200, requests: 10, costMicros: 500000 }, { bucketStart: query.get("to"), tokens: 3600, requests: 30, costMicros: 2000000 }],
    } })
  })
  await page.route("**/api/admin/request-logs?*", async route => {
    recentRanges.push(new URL(route.request().url()).searchParams)
    await gate
    if (failRecent) { await route.fulfill({ status: 500, json: { error: { message: "Unavailable" } } }); return }
    await route.fulfill({ json: { events: Array.from({ length: 25 }, (_, index) => ({ id: `attempt-${index}`, gatewayKeyId: "key", keyName: "Live key", gatewayModelId: "model", modelName: `Live model ${index}`, status: index ? 200 : 500, durationMs: 250, completedAt: range.to })), models: [], ...range, nextCursor: "unused" } })
  })
  await page.goto("/dashboard/ai/overview")
  await expect(page.locator('[data-slot="overview-request-skeleton-row"]')).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Refreshing…", exact: true })).toBeDisabled()
  const skeletonHeight = (await page.locator('[data-slot="overview-request-skeleton-row"]').first().boundingBox())!.height
  const bars = page.locator('[data-slot="overview-request-skeleton-row"]').first().getByRole("cell").first().locator('[data-slot="skeleton"]')
  const firstBar = (await bars.nth(0).boundingBox())!
  const secondBar = (await bars.nth(1).boundingBox())!
  expect(secondBar.y - firstBar.y - firstBar.height).toBe(8)
  await expect(page.getByText("6.42M", { exact: true })).toHaveCount(0)
  release!()
  await expect(page.getByText("4,800", { exact: true })).toBeVisible()
  await expect(page.getByText("90.0%", { exact: true })).toBeVisible()
  await expect(page.getByText("25.0%", { exact: true })).toBeVisible()
  await expect(page.getByText("2.00s", { exact: true })).toBeVisible()
  await expect(page.getByText("Quiet key", { exact: true })).toBeVisible()
  const recent = page.locator('[data-slot="card"]').filter({ has: page.getByText("Recent Requests", { exact: true }) })
  await expect(recent.getByRole("columnheader")).toHaveText(["Request / model", "Status", "Duration", /^Time \(.+\)$/])
  await expect(recent.getByRole("row")).toHaveCount(5)
  expect(Math.abs((await recent.getByRole("row").nth(1).boundingBox())!.height - skeletonHeight)).toBeLessThanOrEqual(2)
  await expect(recent.getByText("Live model 3", { exact: true })).toBeVisible()
  await expect(recent.getByText("Live model 4", { exact: true })).toHaveCount(0)
  await expect(recent.locator("a", { hasText: "View all" })).toHaveAttribute("href", "/dashboard/ai/overview/request-logs")
  expect(aggregateRanges[0]!.toString()).toBe(recentRanges[0]!.toString())
  await page.getByRole("button", { name: "7 days", exact: true }).click()
  await expect.poll(() => Date.parse(aggregateRanges.at(-1)!.get("to")!) - Date.parse(aggregateRanges.at(-1)!.get("from")!)).toBe(7 * 86_400_000)
  await expect(page.getByText("4,800", { exact: true })).toBeVisible()
  // A late old-period response cannot replace the currently selected range.
  holdNext = true
  await page.getByRole("button", { name: "Past 24h", exact: true }).click()
  await expect.poll(() => !!releaseOld).toBe(true)
  await expect(page.getByText("4,800", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "30 days", exact: true }).click()
  await expect.poll(() => Date.parse(aggregateRanges.at(-1)!.get("to")!) - Date.parse(aggregateRanges.at(-1)!.get("from")!)).toBe(30 * 86_400_000)
  await expect(page.getByText("4,800", { exact: true })).toBeVisible()
  const oldResponse = page.waitForResponse(response => response.url() === heldUrl)
  releaseOld!()
  await (await oldResponse).finished()
  await expect(page.getByText("9,999", { exact: true })).toHaveCount(0)
  failRecent = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("button", { name: "Retry recent requests" })).toBeVisible()
  await expect(page.getByText("4,800", { exact: true })).toBeVisible()
  sparse = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3)
  await expect(page.getByText("Historical status coverage is incomplete", { exact: true })).toBeVisible()
  failRecent = false
  await page.getByRole("button", { name: "Retry recent requests" }).click()
  await expect(recent.getByRole("row")).toHaveCount(5)
  fail = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("button", { name: "Retry overview" })).toBeVisible()
  await expect(page.getByText("4,800", { exact: true })).toHaveCount(0)
  fail = false
  await page.getByRole("button", { name: "Retry overview" }).click()
  await expect(page.getByText("4,800", { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await recent.getByRole("table").evaluate(table => table.getBoundingClientRect().width > table.closest('[data-slot="table-container"]')!.getBoundingClientRect().width)).toBe(true)
})
