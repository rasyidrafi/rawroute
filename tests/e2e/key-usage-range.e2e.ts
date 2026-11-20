import { expect, test, type Page } from "@playwright/test"
import type { DashboardPayload } from "../../packages/gateway-ai/src/contracts/domain"
import { formatCost, formatRequestCount, formatTokenCount } from "../../packages/gateway-ai/src/contracts/usage-display"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

function makePayload(requests: number, tokens: number, costMicros: number, from: string, to: string, granularity: "daily" | "hourly" | "weekly"): DashboardPayload {
  return {
    generatedAt: "2026-11-19T12:00:00.000Z",
    range: { label: "Range", from, to, granularity },
    summary: { requests, tokens, costMicros, activeKeys: 1, pricedRequests: requests, unpricedRequests: 0 },
    trend: [{ bucketStart: from, label: "start", requests, tokens, costMicros }],
    keys: [{ id: "range-e2e-key", label: "Range E2E Key", maskedKey: "hidden", requests, tokens, costMicros, models: ["m"], lastUsed: null }],
    models: [{ model: "m", requests, tokens, costMicros }],
    freshness: { source: "memory", lastEventAt: null },
    pricingConfidence: { pricedRequests: requests, unpricedRequests: 0 },
  }
}

test.use({ timezoneId: "UTC" })

const budgetPayload = makePayload(1284, 476_000_000, 28_430_000, "2026-11-16T00:00:00.000Z", "2026-11-23T00:00:00.000Z", "daily")
const todayPayload = makePayload(96, 31_000_000, 1_860_000, "2026-11-19T00:00:00.000Z", "2026-11-20T00:00:00.000Z", "hourly")
const customPayload = makePayload(2204, 812_000_000, 49_770_000, "2026-11-10T00:00:00.000Z", "2026-11-16T00:00:00.000Z", "daily")

test("key detail range toolbar scopes trend and summary while budget and recent requests stay fixed", async ({ page }) => {
  await authenticate(page)
  const recentParams: Array<{ from: string; to: string }> = []
  const dashRequests: Array<{ preset: string | null; from: string | null; to: string | null; granularity: string | null }> = []
  let budgetCalls = 0
  let gateActive = false
  let releaseBudget: (() => void) | null = null
  let gateBudgetActive = false
  let releaseBudgetQuery: (() => void) | null = null
  await page.route("**/api/admin/usage?*", async route => {
    const params = new URL(route.request().url()).searchParams
    expect(params.get("key")).toBe("range-e2e-key")
    const preset = params.get("preset")
    dashRequests.push({ preset, from: params.get("from"), to: params.get("to"), granularity: params.get("granularity") })
    if (preset === "budget" && gateActive) await new Promise<void>(resolve => { releaseBudget = resolve })
    return route.fulfill({ json: preset === "today" ? todayPayload : preset === "custom" ? customPayload : budgetPayload })
  })
  await page.route("**/api/admin/usage/keys/range-e2e-key", async route => {
    budgetCalls++
    if (gateBudgetActive) await new Promise<void>(resolve => { releaseBudgetQuery = resolve })
    return route.fulfill({ json: budgetPayload })
  })
  await page.route("**/api/admin/request-logs?*", route => {
    const params = new URL(route.request().url()).searchParams
    recentParams.push({ from: params.get("from")!, to: params.get("to")! })
    return route.fulfill({ json: { events: [], models: [], keys: [{ id: "range-e2e-key", name: "Range E2E Key" }], nextCursor: null, from: params.get("from"), to: params.get("to") } })
  })
  await page.clock.setSystemTime(new Date("2026-11-19T12:00:00.000Z"))
  await page.goto("/dashboard/ai/overview/usage/keys/range-e2e-key")
  await expect(page.getByRole("heading", { name: "Range E2E Key", exact: true })).toBeVisible()
  const rangeSelect = page.getByRole("combobox").first()
  await expect(rangeSelect).toContainText("Budget window")
  await expect(page.getByRole("combobox")).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Nov 16, 2026 - Nov 23, 2026", exact: true })).toBeVisible()
  const stat = (label: string) => page.getByText(label, { exact: true }).locator("..").locator("p").first()
  const card = (title: string) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${title}$`) }) })
  await expect(stat("Requests")).toHaveText(formatRequestCount(1284))
  await expect(stat("Tokens")).toHaveText(formatTokenCount(476_000_000))
  await expect(stat("Cost")).toHaveText(formatCost(28_430_000))
  expect(budgetCalls).toBe(0)
  const budgetText = await card("Budget balance").innerText()
  expect(recentParams.length).toBeGreaterThan(0)
  const recentCountBeforeSwitch = recentParams.length

  gateBudgetActive = true
  await rangeSelect.click()
  await page.getByRole("option", { name: "Today", exact: true }).click()
  await expect.poll(() => Boolean(releaseBudgetQuery)).toBe(true)
  await expect(stat("Requests")).toHaveText(formatRequestCount(96))
  await expect(rangeSelect).toBeVisible()
  expect(await card("Budget balance").innerText()).toBe(budgetText)
  releaseBudgetQuery!()
  gateBudgetActive = false
  await expect(stat("Tokens")).toHaveText(formatTokenCount(31_000_000))
  await expect(stat("Cost")).toHaveText(formatCost(1_860_000))
  await expect(card("Spending by model").getByText(formatCost(1_860_000), { exact: true })).toBeVisible()
  await expect(card("Usage profile").getByText("Recorded requests", { exact: true }).locator("..").locator("p").first()).toHaveText(formatRequestCount(96))
  expect(budgetCalls).toBeGreaterThan(0)
  expect(await card("Budget balance").innerText()).toBe(budgetText)
  expect(recentParams.length).toBe(recentCountBeforeSwitch)
  await expect(page.getByRole("combobox").nth(1)).toContainText("Auto (hourly)")
  await expect(page.getByRole("button", { name: "Nov 19, 2026 - Nov 20, 2026", exact: true })).toBeVisible()

  gateActive = true
  await rangeSelect.click()
  await page.getByRole("option", { name: "Budget window", exact: true }).click()
  await expect.poll(() => Boolean(releaseBudget)).toBe(true)
  await expect(stat("Requests")).toHaveText(formatRequestCount(96))
  expect(await card("Budget balance").innerText()).toBe(budgetText)
  // Range refetches keep the previous payload under the shared overlay; the
  // range-independent budget balance and recent requests stay untouched.
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(3)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled()
  await expect(card("Budget balance").getByText("Refreshing data...", { exact: true })).toHaveCount(0)
  await expect(card("Recent requests").getByText("Refreshing data...", { exact: true })).toHaveCount(0)
  releaseBudget!()
  gateActive = false
  await expect(stat("Requests")).toHaveText(formatRequestCount(1284))
  expect(await card("Budget balance").innerText()).toBe(budgetText)
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(0)

  await rangeSelect.click()
  await page.getByRole("option", { name: "Custom", exact: true }).click()
  await expect(rangeSelect).toContainText("Custom")
  const dashBeforeIncompleteRefresh = dashRequests.length
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => recentParams.length).toBeGreaterThan(recentCountBeforeSwitch)
  expect(dashRequests.length).toBe(dashBeforeIncompleteRefresh)
  await expect(stat("Requests")).toHaveText(formatRequestCount(1284))
  const recentBaseline = recentParams.length
  await page.getByRole("button", { name: "Pick a date range", exact: true }).click()
  await page.getByRole("button", { name: /November 10th, 2026/ }).click()
  await page.getByRole("button", { name: /November 15th, 2026/ }).click()
  await expect.poll(() => dashRequests.at(-1)?.preset).toBe("custom")
  expect(dashRequests.at(-1)).toMatchObject({ from: "2026-11-10", to: "2026-11-15" })
  await expect(stat("Requests")).toHaveText(formatRequestCount(2204))
  await expect(stat("Cost")).toHaveText(formatCost(49_770_000))
  await page.keyboard.press("Escape")
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: "Weekly", exact: true }).click()
  await expect.poll(() => dashRequests.at(-1)?.granularity).toBe("weekly")
  expect(recentParams.length).toBe(recentBaseline)
  await rangeSelect.click()
  await page.getByRole("option", { name: "Today", exact: true }).click()
  await expect(page.getByRole("combobox").nth(1)).toContainText("Auto (hourly)")
  await expect.poll(() => dashRequests.at(-1)?.preset).toBe("today")
  expect(dashRequests.at(-1)?.granularity).toBeNull()
  expect(recentParams.length).toBe(recentBaseline)
  await rangeSelect.click()
  await page.getByRole("option", { name: "Budget window", exact: true }).click()
  await expect(page.getByRole("combobox").nth(1)).toContainText("Auto (daily)")
  await expect.poll(() => dashRequests.at(-1)?.preset).toBe("budget")
  expect(dashRequests.at(-1)?.granularity).toBeNull()

  const lastRecentTo = recentParams.at(-1)!.to
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => recentParams.length).toBeGreaterThan(recentBaseline)
  const advanced = recentParams.at(-1)!
  expect(Date.parse(advanced.to) - Date.parse(advanced.from)).toBe(7 * 86_400_000)
  expect(Date.parse(advanced.to)).toBeGreaterThan(Date.parse(lastRecentTo))
})

test("key detail background polling stays silent while manual refresh shows the overlay", async ({ page }) => {
  await authenticate(page)
  let dashCalls = 0
  let holdPoll = false
  let holdManual = false
  let holdRecent = false
  let releasePoll!: () => void
  let releaseManual!: () => void
  let releaseRecent!: () => void
  const pollGate = new Promise<void>(resolve => { releasePoll = resolve })
  const manualGate = new Promise<void>(resolve => { releaseManual = resolve })
  const recentGate = new Promise<void>(resolve => { releaseRecent = resolve })
  await page.route("**/api/admin/usage?*", async route => {
    dashCalls++
    if (holdPoll) await pollGate
    if (holdManual) await manualGate
    return route.fulfill({ json: budgetPayload })
  })
  await page.route("**/api/admin/usage/keys/range-e2e-key", route => route.fulfill({ json: budgetPayload }))
  await page.route("**/api/admin/request-logs?*", async route => {
    if (holdRecent) await recentGate
    const params = new URL(route.request().url()).searchParams
    return route.fulfill({ json: { events: [], models: [], keys: [{ id: "range-e2e-key", name: "Range E2E Key" }], nextCursor: null, from: params.get("from"), to: params.get("to") } })
  })
  await page.clock.install({ time: new Date("2026-11-19T12:00:00.000Z") })
  await page.goto("/dashboard/ai/overview/usage/keys/range-e2e-key")
  await expect(page.getByRole("heading", { name: "Range E2E Key", exact: true })).toBeVisible()
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(0)
  const baseline = dashCalls
  holdPoll = true
  await page.clock.runFor(16_000)
  await expect.poll(() => dashCalls).toBeGreaterThan(baseline)
  // The poll is still pending: background refreshes never surface loading UI.
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
  releasePoll()
  holdPoll = false
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(0)
  holdManual = true
  holdRecent = true
  const beforeManual = dashCalls
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => dashCalls).toBeGreaterThan(beforeManual)
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(3)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled()
  releaseManual()
  holdManual = false
  // The range payload landed but the manually refreshed recent requests are still
  // pending: panels clear, yet the button stays busy until every query settles.
  await expect(page.getByText("Refreshing data...", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled()
  releaseRecent()
  holdRecent = false
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
})