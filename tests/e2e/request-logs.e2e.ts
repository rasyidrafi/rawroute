import { expect, test } from "@playwright/test"

test("request log filters, pagination, refresh and feedback states", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  const headers = { "x-rawroute-workspace-id": "default" }
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
      id: `${older ? "older" : "newest"}-${i}`, gatewayKeyId: "old-key", keyName: older ? null : "Demo key", gatewayModelId: "old-model", modelName: older ? null : "Demo model", protocol: "openai-chat", startedAt: to, completedAt: to, status: 200, durationMs: 250, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 0, totalTokens: 17, costMicros: 10, pricingConfidence: older ? "unpriced" : "assumed", usageAvailable: true,
    }))
    await route.fulfill({ json: { events, models: [{ id: "old-model", name: older ? "old-model" : "Demo model" }], from: params.get("from"), to: params.get("to"), nextCursor: older || empty ? null : "test-cursor" } })
  })
  await page.goto("/dashboard/ai/overview/request-logs")
  const loading = page.getByRole("status", { name: "Loading request logs" })
  await expect(loading).toBeVisible()
  await expect(loading).toHaveAttribute("aria-busy", "true")
  await expect(loading.getByRole("columnheader")).toHaveText(["Request / model", "Status", "Tokens", "Cost", "Duration", /^Time \(.+\)$/])
  const placeholderRows = loading.locator('[data-slot="request-log-skeleton-row"]')
  await expect(placeholderRows).toHaveCount(9)
  await expect(placeholderRows.first().getByRole("cell")).toHaveCount(6)
  await expect(placeholderRows.first().locator('[data-slot="skeleton"]')).toHaveCount(8)
  const loadingRowHeight = (await placeholderRows.first().boundingBox())!.height
  const loadingColumns = await loading.getByRole("columnheader").evaluateAll(headers => headers.map(header => header.getBoundingClientRect().width))
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled()
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 640, height: viewport.height })
  expect(await loading.getByRole("table").evaluate(table => table.getBoundingClientRect().width > table.closest('[data-slot="table-container"]')!.getBoundingClientRect().width)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize(viewport)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(placeholderRows.first().locator('[data-slot="skeleton"]').first()).toHaveCSS("animation-name", "none")
  release!()
  await expect(page.getByRole("row")).toHaveCount(26)
  await expect(page.getByText("Newest first · 25 per page", { exact: true })).toBeVisible()
  await expect(loading).toHaveCount(0)
  await expect(page.locator('[data-slot="request-log-skeleton-row"]')).toHaveCount(0)
  const loadedRowHeight = (await page.getByRole("row").nth(1).boundingBox())!.height
  expect(Math.abs(loadedRowHeight - loadingRowHeight)).toBeLessThanOrEqual(2)
  const loadedColumns = await page.getByRole("columnheader").evaluateAll(headers => headers.map(header => header.getBoundingClientRect().width))
  for (const [index, width] of loadingColumns.entries()) expect(Math.abs(loadedColumns[index]! - width)).toBeLessThanOrEqual(1)
  await expect(page.getByText("Estimated", { exact: true })).toHaveCount(25)
  await expect(page.getByRole("cell", { name: "$0.00001 Estimated", exact: true })).toHaveCount(25)
  const frozenTo = requests.at(-1)!.get("to")
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await expect(page.getByText("Unknown key (old-key)", { exact: false })).toBeVisible()
  await expect(page.getByText("Unpriced", { exact: true })).toBeVisible()
  expect(requests.at(-1)!.get("to")).toBe(frozenTo)
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Newer", exact: true }).click()
  await expect(page.getByRole("row")).toHaveCount(26)
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await expect(page.getByText("Unpriced", { exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  await page.getByRole("option", { name: "old-model", exact: true }).click()
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
  await expect(page.getByText("Unable to load request logs. Try refreshing.")).toBeVisible()
  expect(requests.at(-1)!.get("to")).not.toBe(previousTo)
  await expect(page.getByRole("row")).toHaveCount(0)
})
