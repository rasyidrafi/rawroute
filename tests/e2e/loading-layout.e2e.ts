import { expect, test, type Page, type Route } from "@playwright/test"
import { readFileSync, readdirSync } from "node:fs"

function barrier() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function hold(page: Page, pattern: string) {
  const gate = barrier()
  const reached = barrier()
  await page.route(pattern, async (route: Route) => {
    reached.release()
    await gate.wait
    await route.continue()
  })
  return { release: gate.release, reached: reached.wait }
}

async function geometry(page: Page, selector: string) {
  await page.evaluate(() => document.fonts.ready)
  return page.locator(selector).evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { x, y, width, height, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight }
  }))
}

function sameGeometry(before: Awaited<ReturnType<typeof geometry>>, after: Awaited<ReturnType<typeof geometry>>) {
  expect(after).toHaveLength(before.length)
  for (let i = 0; i < before.length; i++) {
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(after[i]![key] - before[i]![key]), `element ${i}: ${key}`).toBeLessThanOrEqual(1)
    expect(after[i]!.paddingLeft).toBe(before[i]!.paddingLeft)
    expect(after[i]!.paddingRight).toBe(before[i]!.paddingRight)
  }
}

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

for (const width of [390, 1280, 1600]) {
  test(`public loading matches the loaded header and summary at ${width}px across all loading boundaries`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    const publicChunk = readdirSync("dist").find(file => file.startsWith("chunk-") && file.endsWith(".js") && readFileSync(`dist/${file}`, "utf8").includes("Public workspaces are unavailable."))
    expect(publicChunk).toBeTruthy()
    const script = await hold(page, `**/${publicChunk}`)
    const workspaces = await hold(page, "**/api/public/workspaces")
    const dashboard = await hold(page, "**/api/public/dashboard?*")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await script.reached
    await expect(page.getByRole("heading", { name: "Usage dashboard" })).toBeVisible()
    await expect(page.getByText("API Endpoint", { exact: true })).toHaveCount(0)
    const selector = '[data-slot="public-header"], [data-slot="usage-summary"], [data-slot="usage-summary"] [data-slot="card"], [data-slot="usage-summary"] [data-slot="card-header"], [data-slot="usage-summary"] [data-slot="card-footer"]'
    const initial = await geometry(page, selector)
    await page.screenshot({ path: testInfo.outputPath("public-loading.png"), fullPage: true })
    script.release()
    await workspaces.reached
    sameGeometry(initial, await geometry(page, selector))
    workspaces.release()
    await dashboard.reached
    await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toBeVisible()
    sameGeometry(initial, await geometry(page, selector))
    dashboard.release()
    await expect(page.locator('[data-slot="usage-summary"]')).toHaveAttribute("aria-busy", "false")
    sameGeometry(initial, await geometry(page, selector))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath("public-loaded.png"), fullPage: true })
    const refreshing = await hold(page, "**/api/public/dashboard?*")
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await refreshing.reached
    await expect(page.getByRole("button", { name: "Refreshing", exact: true })).toBeDisabled()
    await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toHaveCount(0)
    sameGeometry(initial, await geometry(page, selector))
    refreshing.release()
    await expect(page.locator('[data-slot="usage-summary"]')).toHaveAttribute("aria-busy", "false")
  })
}

for (const width of [390, 1280]) {
    test(`administrator settings loading preserves bounds at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await authenticate(page)
      const session = await hold(page, "**/api/auth/session")
      const account = await hold(page, "**/api/admin/account")
      await page.goto("/dashboard/settings")
      await session.reached
      await expect(page.getByText("Admin password", { exact: true })).toBeVisible()
      const selector = 'main [data-slot="card"], main [data-slot="card-header"], main [data-slot="card-content"]'
      const initial = await geometry(page, selector)
      session.release()
      await account.reached
      sameGeometry(initial, await geometry(page, selector))
      account.release()
      await expect(page.getByLabel("Current password", { exact: true })).toBeEnabled()
      sameGeometry(initial, await geometry(page, selector))
    })
}

test("system logs retain console geometry through account and log loading", async ({ page }) => {
  await authenticate(page)
  const account = await hold(page, "**/api/admin/account")
  const logs = await hold(page, "**/api/admin/logs/global")
  await page.goto("/dashboard/system-logs")
  await account.reached
  await expect(page.getByLabel("Console log entries")).toBeVisible()
  const selector = 'main [data-slot="card"], main [data-slot="card-header"], main [data-slot="card-content"], [aria-label="Search logs"]'
  const initial = await geometry(page, selector)
  account.release()
  await logs.reached
  sameGeometry(initial, await geometry(page, selector))
  logs.release()
  await expect(page.getByLabel("Console log entries")).toHaveAttribute("aria-busy", "false")
  sameGeometry(initial, await geometry(page, selector))
})

for (const route of ["providers", "aliases", "budgets", "model-pricing", "providers/codex", "cliproxy"]) {
  test(`${route} loading preserves page and card padding on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 })
    await authenticate(page)
    const endpoint = route === "cliproxy" ? "cliproxy/status" : route
    const data = await hold(page, `**/api/admin/${endpoint}`)
    await page.goto(({ providers: "/dashboard/ai/providers", aliases: "/dashboard/ai/routing", budgets: "/dashboard/ai/budgets", "model-pricing": "/dashboard/ai/pricing", "providers/codex": "/dashboard/ai/codex-providers", cliproxy: "/dashboard/cliproxy" } as Record<string, string>)[route]!)
    await data.reached
    const selector = 'main [data-slot="card-header"]'
    await expect(page.locator(selector).first()).toBeVisible()
    const initial = (await geometry(page, selector))[0]!
    data.release()
    await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toHaveCount(0)
    const loaded = (await geometry(page, selector))[0]!
    // Data determines row counts and heights; page gutters and card insets must stay fixed.
    expect(Math.abs(loaded.height - initial.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(loaded.y - initial.y)).toBeLessThanOrEqual(1)
    expect(loaded.x).toBe(initial.x)
    expect(loaded.width).toBe(initial.width)
    expect(loaded.paddingLeft).toBe(initial.paddingLeft)
    expect(loaded.paddingRight).toBe(initial.paddingRight)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
