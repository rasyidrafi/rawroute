import { expect, type Page, type Request } from "@playwright/test"
import { test } from "./empty-workspace.fixture"

test.use({ timezoneId: "Asia/Tokyo" })

function observeRequestSettlement(page: Page, expectedRequest: Request): Promise<"finished" | "failed"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Browser request did not settle: ${expectedRequest.url()}`))
    }, 5_000)
    const cleanup = () => {
      clearTimeout(timeout)
      page.off("requestfinished", onFinished)
      page.off("requestfailed", onFailed)
    }
    const onFinished = (request: Request) => {
      if (request !== expectedRequest) return
      cleanup()
      resolve("finished")
    }
    const onFailed = (request: Request) => {
      if (request !== expectedRequest) return
      cleanup()
      resolve("failed")
    }
    page.on("requestfinished", onFinished)
    page.on("requestfailed", onFailed)
  })
}

// Consume a browser request after the clock tick before sampling the route log.
async function flushBrowserNetworkEvents(page: Page) {
  const responseBody = await page.evaluate(async () => {
    const response = await fetch("/__e2e/network-barrier", { cache: "no-store" })
    if (!response.ok) throw new Error("Browser network barrier failed")
    return await response.text()
  })
  expect(responseBody).toBe("settled")
}

test("request log filters, pagination, refresh and feedback states", async ({ page, emptyWorkspaceId }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  const headers = { "x-rawroute-workspace-id": emptyWorkspaceId }
  expect((await page.request.get("/api/admin/request-logs?from=invalid", { headers })).status()).toBe(400)
  const from = new Date(Date.now() - 86_400_000).toISOString()
  const to = new Date().toISOString()
  const actual = await page.request.get(`/api/admin/request-logs?from=${from}&to=${to}`, { headers })
  expect(actual.ok()).toBe(true)
  expect((await actual.json()).events).toEqual([])

  const requests: URLSearchParams[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let mode: "normal" | "error" = "normal"
  await page.route("**/api/admin/request-logs?*", async route => {
    const params = new URL(route.request().url()).searchParams
    requests.push(params)
    await gate
    if (mode === "error") { await route.fulfill({ status: 500, json: { error: { message: "Unavailable" } } }); return }
    const older = params.has("cursor")
    const empty = params.get("status") === "failed"
    const events = empty ? [] : Array.from({ length: older ? 1 : 25 }, (_, i) => ({
      id: `${older ? "older" : "newest"}-${i}`, gatewayKeyId: "old-key", keyName: older ? null : "Demo key", gatewayModelId: "old-model", modelName: older ? null : "Demo model", protocol: "openai-chat", startedAt: to, completedAt: to, status: 200, durationMs: [5285, 9300, 999.5, 59_995, 65_000, 3_599_500, 3_720_000, 86_370_000][i] ?? 250, inputTokens: 28_500, outputTokens: 5_042, cacheReadTokens: 8_000, cacheCreationTokens: 2_000, totalTokens: 43_542, costMicros: 10, pricingConfidence: older ? "unpriced" : "assumed", usageAvailable: true,
      ...(older ? {} : i === 0 ? { reasoningEffort: "medium", toolCount: 2 } : i === 1 ? { reasoningEffort: "low", toolCount: 0 } : {}),
    }))
    await route.fulfill({ json: { events, models: [{ id: "old-model", name: older ? "old-model" : "Demo model" }], keys: [{ id: "old-key", name: "Demo key" }], from: params.get("from"), to: params.get("to"), nextCursor: older || empty ? null : "test-cursor" } })
  })
  await page.goto("/dashboard/ai/overview/request-logs")
  const loading = page.getByRole("status", { name: "Loading request logs" })
  await expect(loading).toBeVisible()
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ["Date range", "Status", "Key", "Model"]) {
      const label = page.locator("label").filter({ hasText: new RegExp(`^${name}$`) })
      const trigger = page.getByRole("combobox", { name, exact: true })
      await expect(label).toBeVisible()
      await expect(label).toHaveAttribute("for", (await trigger.getAttribute("id"))!)
      const left = (await label.boundingBox())!
      const right = (await trigger.boundingBox())!
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.width)
      expect(Math.abs(left.y + left.height / 2 - right.y - right.height / 2)).toBeLessThan(1)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
  const refresh = page.getByRole("button", { name: "Refresh", exact: true })
  await expect(refresh).toBeDisabled()
  await expect(refresh.locator("svg")).toHaveClass(/animate-spin/)
  const controls = refresh.locator("..")
  expect(await controls.evaluate(element => Math.abs(element.getBoundingClientRect().right - element.parentElement!.getBoundingClientRect().right))).toBeLessThanOrEqual(1)
  await expect(page.locator('[data-slot="card-description"]')).toHaveText("Workspace history of recorded model attempts.")
  await expect(loading).toHaveAttribute("aria-busy", "true")
  await expect(loading.getByRole("columnheader")).toHaveText(["Request / model", "Reasoning / tools", "Key", "Status", "Tokens", "Cost", "Duration", "Time"])
  await expect(page.locator("body")).not.toContainText(/Asia\/(?:Jakarta|Tokyo)|\b(?:UTC|GMT)\b/)
  const placeholderRows = loading.locator('[data-slot="request-log-skeleton-row"]')
  await expect(placeholderRows).toHaveCount(9)
  await expect(placeholderRows.first().getByRole("cell")).toHaveCount(8)
  await expect(placeholderRows.first().locator('[data-slot="skeleton"]')).toHaveCount(11)
  await expect(placeholderRows.first().getByRole("cell").nth(1).locator('[data-slot="skeleton"]')).toHaveCount(2)
  await expect(placeholderRows.first().getByRole("cell").nth(2).locator('[data-slot="skeleton"]')).toHaveCount(1)
  for (const column of [0, 4]) {
    const bars = placeholderRows.first().getByRole("cell").nth(column).locator('[data-slot="skeleton"]')
    const first = (await bars.nth(0).boundingBox())!
    const second = (await bars.nth(1).boundingBox())!
    expect(second.y - first.y - first.height).toBe(8)
  }
  const loadingRowHeight = (await placeholderRows.first().boundingBox())!.height
  const loadingColumns = await loading.getByRole("columnheader").evaluateAll(headers => headers.map(header => header.getBoundingClientRect().width))
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled()
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 640, height: viewport.height })
  expect(await controls.evaluate(element => Math.abs(element.getBoundingClientRect().right - element.parentElement!.getBoundingClientRect().right))).toBeLessThanOrEqual(1)
  expect(await loading.getByRole("table").evaluate(table => table.getBoundingClientRect().width > table.closest('[data-slot="table-container"]')!.getBoundingClientRect().width)).toBe(true)
  const logCard = page.locator('[data-slot="card"]').filter({ has: page.getByText("Request Logs", { exact: true }) })
  const logContent = logCard.locator('[data-slot="card-content"]')
  await expect(logContent).toHaveCSS("overflow-x", "clip")
  expect(await logContent.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(await logContent.evaluate(element => element.clientWidth))
  await expect(logCard.locator('[data-slot="table-container"] [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize(viewport)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(placeholderRows.first().locator('[data-slot="skeleton"]').first()).toHaveCSS("animation-name", "none")
  release!()
  await expect(page.getByRole("row")).toHaveCount(26)
  await expect(refresh).toBeEnabled()
  await expect(refresh.locator("svg")).not.toHaveClass(/animate-spin/)
  await expect(page.getByRole("columnheader")).toHaveText(["Request / model", "Reasoning / tools", "Key", "Status", "Tokens", "Cost", "Duration", "Time"])
  await expect(page.locator("tbody tr").first().getByRole("cell").nth(1)).toContainText("medium")
  await expect(page.locator("tbody tr").first().getByRole("cell").nth(1)).toContainText("2 declared tools")
  await expect(page.locator("tbody tr").nth(1).getByRole("cell").nth(1)).toContainText("0 declared tools")
  await expect(page.locator("tbody tr").first().getByRole("cell").nth(0)).not.toContainText("Demo key")
  await expect(page.locator("tbody tr").first().getByRole("cell").nth(2)).toHaveText("Demo key")
  await expect(page.locator("body")).not.toContainText(/Asia\/(?:Jakarta|Tokyo)|\b(?:UTC|GMT)\b/)
  await expect(page.getByText("Newest first · 25 per page", { exact: true })).toBeVisible()
  await expect(loading).toHaveCount(0)
  await expect(page.locator('[data-slot="card-description"]')).toHaveText("Workspace history of recorded model attempts.")
  await expect(page.locator('[data-slot="request-log-skeleton-row"]')).toHaveCount(0)
  const loadedRowHeight = (await page.getByRole("row").nth(1).boundingBox())!.height
  expect(Math.abs(loadedRowHeight - loadingRowHeight)).toBeLessThanOrEqual(2)
  const loadedColumns = await page.getByRole("columnheader").evaluateAll(headers => headers.map(header => header.getBoundingClientRect().width))
  for (const [index, width] of loadingColumns.entries()) expect(Math.abs(loadedColumns[index]! - width)).toBeLessThanOrEqual(1)
  await expect(page.getByText("Estimated", { exact: true })).toHaveCount(25)
  for (const duration of ["5.29 s", "9.3 s", "1 s", "1 min", "1 min 5 s", "1 h", "1 h 2 min", "1 d"]) {
    await expect(page.getByRole("cell", { name: duration, exact: true })).toHaveCount(1)
  }
  await expect(page.getByRole("cell", { name: "$0.00001 Estimated", exact: true })).toHaveCount(25)
  await expect(page.getByRole("cell", { name: "43.5K 28.5K in · 10.0K cache · 5.04K out", exact: true })).toHaveCount(25)
  await page.getByRole("combobox", { name: "Key", exact: true }).click()
  await page.getByRole("option", { name: "Demo key", exact: true }).click()
  await expect(page.getByRole("row")).toHaveCount(26)
  expect(requests.at(-1)!.get("key")).toBe("old-key")
  expect(requests.at(-1)!.has("cursor")).toBe(false)
  const frozenTo = requests.at(-1)!.get("to")
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await expect(page.getByText("Unknown key (old-key)", { exact: false })).toBeVisible()
  await expect(page.getByText("Unpriced", { exact: true })).toBeVisible()
  expect(requests.at(-1)!.get("to")).toBe(frozenTo)
  expect(requests.at(-1)!.get("key")).toBe("old-key")
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Newer", exact: true }).click()
  await expect(page.getByRole("row")).toHaveCount(26)
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await expect(page.getByText("Unpriced", { exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Key", exact: true }).click()
  await page.getByRole("option", { name: "All keys", exact: true }).click()
  await expect(page.getByRole("row")).toHaveCount(26)
  expect(requests.at(-1)!.get("key")).toBe("")
  expect(requests.at(-1)!.has("cursor")).toBe(false)
  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  await page.getByRole("option", { name: "Demo model", exact: true }).click()
  await expect(page.getByRole("row")).toHaveCount(26)
  expect(requests.at(-1)!.get("model")).toBe("old-model")
  expect(requests.at(-1)!.has("cursor")).toBe(false)
  await page.getByRole("combobox", { name: "Status", exact: true }).click()
  await page.getByRole("option", { name: "Failed", exact: true }).click()
  await expect(page.getByText("No recorded attempts", { exact: true })).toBeVisible()
  expect(requests.at(-1)!.has("cursor")).toBe(false)
  await page.getByRole("combobox", { name: "Date range" }).click()
  await page.getByRole("option", { name: "Last 7 days" }).click()
  await expect.poll(() => Number(new Date(requests.at(-1)!.get("to")!)) - Number(new Date(requests.at(-1)!.get("from")!))).toBe(7 * 86_400_000)
  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  await page.getByRole("option", { name: "Demo model", exact: true }).click()
  await expect.poll(() => requests.at(-1)!.get("model")).toBe("old-model")
  const previousTo = requests.at(-1)!.get("to")
  mode = "error"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Unable to load request logs. Try refreshing. Existing entries may be stale.")).toBeVisible()
  expect(requests.at(-1)!.get("to")).not.toBe(previousTo)
  await expect(page.getByRole("row")).toHaveCount(0)
})

test("live snapshots roll, pause safely for history, retain rows on failure and recover", async ({ page, emptyWorkspaceId }) => {
  test.setTimeout(60_000)
  let login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  const requests: URLSearchParams[] = []
  let newest = 24
  let fail: boolean | "network" = false
  let hold = false
  let release: (() => void) | undefined
  let heldRequest: Request | undefined
  let active = 0
  let maxActive = 0
  // Drain mock handlers only after the browser-side request settlement is asserted.
  const idleWaiters = new Set<() => void>()
  const routeHandlersIdle = () => active === 0
    ? Promise.resolve()
    : new Promise<void>(resolve => idleWaiters.add(resolve))
  await page.route("**/api/admin/request-logs?*", async route => {
    const params = new URL(route.request().url()).searchParams
    requests.push(params)
    active++
    maxActive = Math.max(maxActive, active)
    try {
      if (hold && !params.has("cursor")) {
        heldRequest = route.request()
        await new Promise<void>(resolve => { release = resolve })
        if (route.request().failure()) return
      }
      if (fail === "network") { await route.abort("failed"); return }
      if (fail) { await route.fulfill({ status: 500, json: { error: { message: "Unavailable" } } }); return }
      const events = Array.from({ length: params.has("cursor") ? 1 : 25 }, (_, i) => ({
        id: `event-${params.has("cursor") ? "history" : newest - i}`, gatewayKeyId: "key", keyName: "Key", gatewayModelId: "model", modelName: `${route.request().headers()["x-rawroute-workspace-id"] === emptyWorkspaceId ? "Workspace attempt" : params.get("status") === "failed" ? "Filtered attempt" : "Attempt"} ${params.has("cursor") ? "history" : newest - i}`, protocol: "openai-chat", startedAt: params.get("to"), completedAt: params.get("to"), status: 200, durationMs: 100, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2, costMicros: 0, pricingConfidence: "unpriced", usageAvailable: true,
      }))
      await route.fulfill({ json: { events, models: [{ id: "model", name: "Model" }], keys: [{ id: "key", name: "Key" }], from: params.get("from"), to: params.get("to"), nextCursor: params.has("cursor") ? null : "cursor" } })
    } finally {
      if (heldRequest === route.request()) heldRequest = undefined
      active--
      if (active === 0) {
        for (const resolve of idleWaiters) resolve()
        idleWaiters.clear()
      }
    }
  })
  await page.route("**/__e2e/network-barrier", route => route.fulfill({ body: "settled" }))
  await page.clock.install()
  await page.goto("/dashboard/ai/overview/request-logs")
  const live = page.getByRole("checkbox")
  await expect(live).toBeChecked()
  await expect(page.getByText("Attempt 0", { exact: true })).toBeVisible()
  const firstTo = requests.at(-1)!.get("to")
  await page.getByRole("table").evaluate(table => table.setAttribute("data-live-mounted", "yes"))
  await page.getByRole("button", { name: "Refresh", exact: true }).focus()
  newest = 25
  await page.clock.fastForward(3_000)
  await expect(page.getByText("Attempt 25", { exact: true })).toBeVisible({ timeout: 6000 })
  await expect(page.getByText("Attempt 0", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("row")).toHaveCount(26)
  await expect(page.getByRole("table")).toHaveAttribute("data-live-mounted", "yes")
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeFocused()
  expect(requests.at(-1)!.get("to")).not.toBe(firstTo)
  expect(Number(new Date(requests.at(-1)!.get("to")!)) - Number(new Date(requests.at(-1)!.get("from")!))).toBe(86_400_000)
  fail = true
  await page.clock.fastForward(3_000)
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 6000 })
  await expect(page.getByText("Attempt 25", { exact: true })).toBeVisible()
  await expect(page.getByRole("table")).toHaveAttribute("data-live-mounted", "yes")
  fail = false
  newest = 26
  await page.clock.fastForward(3_000)
  await expect(page.getByText("Attempt 26", { exact: true })).toBeVisible({ timeout: 6000 })
  await expect(page.getByRole("alert")).toHaveCount(0)
  fail = "network"
  await page.clock.fastForward(3_000)
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 6000 })
  await expect(page.getByText("Attempt 26", { exact: true })).toBeVisible()
  fail = false
  await page.clock.fastForward(3_000)
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 6000 })
  expect(maxActive).toBe(1)
  hold = true
  await page.clock.fastForward(3_000)
  await expect.poll(() => !!release, { timeout: 6000 }).toBe(true)
  const pausedSnapshotRequest = heldRequest
  expect(pausedSnapshotRequest).toBeDefined()
  const pausedSnapshotSettlement = observeRequestSettlement(page, pausedSnapshotRequest!)
  await live.uncheck()
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeEnabled()
  expect(await pausedSnapshotSettlement).toBe("failed")
  newest = 100
  release!()
  hold = false
  release = undefined
  await routeHandlersIdle()
  await expect(page.getByText("Attempt 100", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Attempt 26", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeEnabled()
  await expect(page.getByRole("row")).toHaveCount(26)
  const pausedCount = requests.length
  await page.clock.fastForward(3_300)
  await flushBrowserNetworkEvents(page)
  expect(requests).toHaveLength(pausedCount)
  newest = 27
  await live.check()
  await expect(page.getByText("Attempt 27", { exact: true })).toBeVisible()
  const displayedTo = requests.at(-1)!.get("to")
  hold = true
  await page.clock.fastForward(3_000)
  await expect.poll(() => !!release, { timeout: 6000 }).toBe(true)
  const liveSnapshotRequest = heldRequest
  expect(liveSnapshotRequest).toBeDefined()
  const liveSnapshotSettlement = observeRequestSettlement(page, liveSnapshotRequest!)
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await expect(live).not.toBeChecked()
  await expect(page.getByText("Attempt history", { exact: true })).toBeVisible()
  expect(await liveSnapshotSettlement).toBe("failed")
  release!()
  hold = false
  await routeHandlersIdle()
  await expect(page.getByText("Attempt history", { exact: true })).toBeVisible()
  expect(requests.at(-1)!.get("to")).toBe(displayedTo)
  await page.getByRole("button", { name: "Newer", exact: true }).click()
  await expect(page.getByText("Attempt 27", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeEnabled()
  await expect(live).not.toBeChecked()
  newest = 28
  hold = true
  release = undefined
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => !!release).toBe(true)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Refresh", exact: true }).locator("svg")).toHaveClass(/animate-spin/)
  await expect(page.getByText("Attempt 27", { exact: true })).toBeVisible()
  await expect(page.getByRole("table")).toHaveAttribute("data-live-mounted", "yes")
  release!()
  hold = false
  await expect(page.getByText("Attempt 28", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Refresh", exact: true }).locator("svg")).not.toHaveClass(/animate-spin/)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(live).not.toBeChecked()
  await page.getByRole("combobox", { name: "Date range" }).click()
  await page.getByRole("option", { name: "Last 7 days" }).click()
  await expect.poll(() => Number(new Date(requests.at(-1)!.get("to")!)) - Number(new Date(requests.at(-1)!.get("from")!))).toBe(7 * 86_400_000)
  await expect(live).not.toBeChecked()
  await live.check()
  await expect(page.getByText("Attempt 28", { exact: true })).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  const hiddenCount = requests.length
  await page.clock.fastForward(3_300)
  await flushBrowserNetworkEvents(page)
  expect(requests).toHaveLength(hiddenCount)
  newest = 29
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(page.getByText("Attempt 29", { exact: true })).toBeVisible()
  await page.context().setOffline(true)
  const offlineCount = requests.length
  await page.clock.fastForward(3_300)
  await flushBrowserNetworkEvents(page)
  expect(requests).toHaveLength(offlineCount)
  newest = 30
  await page.context().setOffline(false)
  await expect(page.getByText("Attempt 30", { exact: true })).toBeVisible()
  hold = true
  release = undefined
  await page.clock.fastForward(3_000)
  await expect.poll(() => !!release, { timeout: 6000 }).toBe(true)
  const statusChangeRequest = heldRequest
  expect(statusChangeRequest).toBeDefined()
  const statusChangeSettlement = observeRequestSettlement(page, statusChangeRequest!)
  await page.getByRole("combobox", { name: "Status", exact: true }).click()
  // Keep the old query held while the filtered response is rendered and cancellation is observed.
  hold = false
  await page.getByRole("option", { name: "Failed", exact: true }).click()
  await expect(page.getByText("Filtered attempt 30", { exact: true })).toBeVisible()
  expect(await statusChangeSettlement).toBe("failed")
  release!()
  await routeHandlersIdle()
  await expect(page.getByText("Attempt 30", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Filtered attempt 30", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  hold = true
  release = undefined
  await page.clock.fastForward(3_000)
  await expect.poll(() => !!release, { timeout: 6000 }).toBe(true)
  const workspaceChangeRequest = heldRequest
  expect(workspaceChangeRequest).toBeDefined()
  const workspaceChangeSettlement = observeRequestSettlement(page, workspaceChangeRequest!)
  const workspaces = (await (await page.request.get("/api/admin/workspaces")).json()).workspaces as { id: string; name: string }[]
  const workspace = workspaces.find(item => item.id === emptyWorkspaceId)!
  await page.getByRole("button", { name: /RawRoute/ }).first().click()
  hold = false
  await page.getByRole("menuitemradio", { name: workspace.name, exact: true }).click()
  await expect(page.getByText("Workspace attempt 30", { exact: true })).toBeVisible()
  expect(await workspaceChangeSettlement).toBe("failed")
  release!()
  await routeHandlersIdle()
  await expect(page.getByText("Filtered attempt 30", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("alert")).toHaveCount(0)
  // The workspace change cancels the old filtered request before mock-route cleanup.
  expect(maxActive).toBeLessThanOrEqual(2)
})
