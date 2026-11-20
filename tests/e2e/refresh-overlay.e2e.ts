import { randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

const scrim = (page: Page) => page.getByText("Refreshing data...", { exact: true })

test("budgets refresh retains rows under the overlay on both cards", async ({ page }) => {
  await authenticate(page)
  let hold: Promise<void> | null = null
  let release!: () => void
  await page.route("**/api/admin/budgets", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const data = await response.json()
    const held = hold
    if (held) { hold = null; await held }
    await route.fulfill({ response, json: { ...data, budgets: [{ apiKeyId: "retained-key", name: "Retained budget key", weeklyLimitMicros: 50000000, spentMicros: 10000000, enabled: true }], apiKeys: [{ id: "retained-key", name: "Retained budget key" }] } })
  })
  await page.goto("/dashboard/ai/budgets")
  await expect(page.getByText("Retained budget key", { exact: true }).first()).toBeVisible()
  await expect(scrim(page)).toHaveCount(0)
  hold = new Promise<void>(resolve => { release = resolve })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  // Both the budget window and budgets cards mark their retained data as stale.
  await expect(scrim(page)).toHaveCount(2)
  await expect(page.getByText("Retained budget key", { exact: true }).first()).toBeVisible()
  release()
  await expect(scrim(page)).toHaveCount(0)
})

test("storage refresh retains the connection table under the overlay", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/storage/status", route => route.fulfill({ json: { state: "available" } }))
  const data = { enabled: true, connections: [{ id: "c1", workspaceId: "default", name: "Retained connection", endpoint: "https://s3.example.com", region: "us-east-1", revision: 1, forcePathStyle: true, capabilities: {} }], buckets: [], keys: [], multiparts: [] }
  let hold: Promise<void> | null = null
  let release!: () => void
  await page.route("**/api/admin/storage", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const held = hold
    if (held) { hold = null; await held }
    await route.fulfill({ json: data })
  })
  await page.goto("/dashboard/storage/connections")
  await expect(page.getByText("Retained connection", { exact: true })).toBeVisible()
  await expect(scrim(page)).toHaveCount(0)
  hold = new Promise<void>(resolve => { release = resolve })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(scrim(page)).toHaveCount(1)
  await expect(page.getByText("Retained connection", { exact: true })).toBeVisible()
  release()
  await expect(scrim(page)).toHaveCount(0)
})

test("system logs refresh under the overlay while live polling stays silent", async ({ page }) => {
  await authenticate(page)
  // Pausing live reports a browser event; drop it so this test does not leave a
  // global "logs.paused" entry that the log-isolation spec asserts against.
  await page.route("**/api/admin/logs/events", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
  let hold: Promise<void> | null = null
  let release!: () => void
  let requests = 0
  await page.route("**/api/admin/logs/global", async route => {
    requests++
    const held = hold
    if (held) { hold = null; await held }
    await route.continue()
  })
  await page.goto("/dashboard/system-logs")
  const entries = page.getByLabel("Console log entries")
  await expect(entries).toContainText("Admin signed in")
  // A live poll refreshes retained entries without surfacing the overlay.
  await expect.poll(() => requests).toBeGreaterThanOrEqual(2)
  await expect(scrim(page)).toHaveCount(0)
  // Pause live so the manual refresh is the only in-flight fetch.
  await page.getByRole("checkbox").click()
  const refresh = page.getByRole("button", { name: "Refresh", exact: true })
  await expect(refresh).toBeEnabled()
  hold = new Promise<void>(resolve => { release = resolve })
  await refresh.click()
  await expect(scrim(page)).toHaveCount(1)
  await expect(entries).toContainText("Admin signed in")
  release()
  await expect(scrim(page)).toHaveCount(0)
})

test("logs retry after a failed initial load keeps the skeleton without the overlay", async ({ page }) => {
  await authenticate(page)
  // Pausing live reports a browser event; drop it so this test does not leave a
  // global "logs.paused" entry that the log-isolation spec asserts against.
  await page.route("**/api/admin/logs/events", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
  let failInitial = true
  let hold: Promise<void> | null = null
  let release!: () => void
  await page.route("**/api/admin/logs/global", async route => {
    if (failInitial) { failInitial = false; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Unavailable" } }) }) }
    const held = hold
    if (held) { hold = null; await held }
    await route.continue()
  })
  await page.goto("/dashboard/system-logs")
  await expect(page.getByRole("alert")).toContainText("Unable to load logs")
  await expect(scrim(page)).toHaveCount(0)
  // Pause live so the retry is the only in-flight fetch.
  await page.getByRole("checkbox").click()
  const refresh = page.getByRole("button", { name: "Refresh", exact: true })
  await expect(refresh).toBeEnabled()
  hold = new Promise<void>(resolve => { release = resolve })
  await refresh.click()
  // No retained data: the retry shows the loading skeleton, never the overlay.
  await expect(page.getByLabel("Console log entries")).toHaveAttribute("aria-busy", "true")
  await expect(scrim(page)).toHaveCount(0)
  release()
  await expect(page.getByLabel("Console log entries")).toContainText("Admin signed in")
  await expect(scrim(page)).toHaveCount(0)
})

test("provider edit refetches under the overlay with retained rows", async ({ page }) => {
  await authenticate(page)
  const name = `Overlay Provider ${randomUUID()}`
  const created = await page.request.post("/api/admin/providers", { headers: { "x-rawroute-workspace-id": "default" }, data: { provider: { name, prefix: "overlay-test", baseUrl: "https://example.com/v1", protocol: "openai-chat", authType: "none", headers: {} } } })
  expect(created.ok()).toBe(true)
  const providerId = (await created.json()).providerId as string
  let gate: Promise<void> | null = null
  let release!: () => void
  await page.route("**/api/admin/providers", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const current = gate
    if (current) await current
    await route.continue()
  })
  try {
    await page.goto("/dashboard/ai/providers")
    const prefixBadge = page.getByText("overlay-test/", { exact: true })
    await expect(prefixBadge).toBeVisible()
    await expect(scrim(page)).toHaveCount(0)
    gate = new Promise<void>(resolve => { release = resolve })
    await page.getByRole("button", { name: `Edit ${name}` }).click()
    const dialog = page.getByRole("dialog")
    await dialog.locator('input[name="name"]').fill(`${name} edited`)
    await dialog.getByRole("button", { name: "Update provider", exact: true }).click()
    // Both provider cards overlay their retained rows while the list refetches.
    await expect(scrim(page)).toHaveCount(2)
    await expect(prefixBadge).toBeVisible()
    release()
    gate = null
    await expect(scrim(page)).toHaveCount(0)
    await expect(page.getByRole("link", { name: `${name} edited`, exact: true })).toBeVisible()
  } finally {
    await page.request.delete(`/api/admin/providers/${providerId}`, { headers: { "x-rawroute-workspace-id": "default" } })
  }
})