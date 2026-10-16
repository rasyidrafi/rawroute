import { expect, test, type Page, type Route } from "@playwright/test"
import { readFileSync, readdirSync } from "node:fs"
import { dashboardPages } from "../../src/lib/dashboard/routes"

function barrier() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function hold(page: Page, pattern: string | RegExp) {
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

/** Check rendered spacing, including stacks below the fold and inside scroll areas. */
async function expectSeparatedSkeletons(page: Page) {
  const stacks = await page.locator('[data-slot="skeleton"]').evaluateAll(skeletons => {
    const parents = new Set(skeletons.map(skeleton => skeleton.parentElement!))
    return [...parents].flatMap(parent => {
      const bars = [...parent.children].filter(child => child.matches('[data-slot="skeleton"]'))
      return bars.slice(1).flatMap((bar, index) => {
        const first = bars[index]!.getBoundingClientRect()
        const second = bar.getBoundingClientRect()
        if (!first.width || !first.height || !second.width || !second.height) return []
        // Horizontal icon/text and chart controls are not vertical text stacks.
        if (Math.min(first.right, second.right) <= Math.max(first.left, second.left)) return []
        return [{ gap: second.top - first.bottom, parent: parent.outerHTML.slice(0, 300) }]
      })
    })
  })
  for (const stack of stacks) expect(stack.gap, stack.parent).toBeGreaterThanOrEqual(4)
  return stacks.length
}

for (const width of [390, 1280]) {
  test(`usage header matches Overview typography and refresh sizing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await authenticate(page)
    await page.goto("/dashboard/ai/overview")
    const overviewHeading = page.getByRole("heading", { name: "Your gateway at a glance" })
    await expect(overviewHeading).toBeVisible()
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
    const typography = (element: Element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight }
    }
    const headingStyle = await overviewHeading.evaluate(typography)
    const subtitleStyle = await page.getByText("Recorded traffic, reliability, and spend for this workspace.", { exact: true }).evaluate(typography)
    const refreshHeight = await page.getByRole("button", { name: /Refresh/ }).evaluate(element => element.getBoundingClientRect().height)
    for (const path of ["/dashboard/ai/overview/usage", "/"]) {
      await page.goto(path)
      const heading = page.getByRole("heading", { name: "Usage dashboard", level: 1 })
      await expect(heading).toBeVisible()
      await expect(page.locator('[data-slot="usage-summary"]')).toHaveAttribute("aria-busy", "false")
      expect(await heading.evaluate(typography)).toEqual(headingStyle)
      const subtitle = heading.locator("..").locator("..").locator(":scope > div").last()
      expect(await subtitle.evaluate(typography)).toEqual(subtitleStyle)
      await expect(subtitle.locator(":scope > span")).toHaveCount(2)
      await expect(subtitle.locator(":scope > span").first()).not.toBeEmpty()
      await expect(subtitle.locator(":scope > span").last()).not.toBeEmpty()
      await expect(subtitle.getByText(/^(daily|hourly|monthly|auto)$/i)).toHaveCount(0)
      await expect(page.getByText("Group", { exact: true }).locator("..").getByRole("combobox")).toBeEnabled()
      const refresh = page.getByRole("button", { name: "Refresh", exact: true })
      expect(await refresh.evaluate(element => element.getBoundingClientRect().height)).toBe(refreshHeight)
    }
  })

  test(`all route skeleton stacks have separated bars at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await authenticate(page)
    const variants = new Set<string>()
    let checkedStacks = 0
    for (const route of Object.values(dashboardPages)) {
      if (variants.has(route.skeleton)) continue
      variants.add(route.skeleton)
      await test.step(route.skeleton, async () => {
        const session = await hold(page, "**/api/auth/session")
        await page.goto(route.path.replace(":providerId", "example"), { waitUntil: "domcontentloaded" })
        await session.reached
        await expect(page.locator('main').last()).toBeVisible()
        await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible()
        checkedStacks += await expectSeparatedSkeletons(page)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        if (route.skeleton === "overview" || route.skeleton === "usage") {
          await page.screenshot({ path: testInfo.outputPath(`${route.skeleton}-loading-${width}.png`), fullPage: true })
        }
        const response = page.waitForResponse("**/api/auth/session")
        session.release()
        await (await response).finished()
        await page.unroute("**/api/auth/session")
      })
    }
    expect(checkedStacks).toBeGreaterThan(20)
  })
}

for (const width of [390, 1280, 1600]) {
  test(`public loading matches the loaded header and summary at ${width}px across all loading boundaries`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    const publicChunks = readdirSync("dist").filter(file => file.startsWith("chunk-") && file.endsWith(".js") && readFileSync(`dist/${file}`, "utf8").includes("Public workspaces are unavailable."))
    expect(publicChunks.length).toBeGreaterThan(0)
    const script = await hold(page, new RegExp(`(?:${publicChunks.join("|")})$`))
    const workspaces = await hold(page, "**/api/public/workspaces")
    const dashboard = await hold(page, "**/api/public/dashboard?*")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await script.reached
    await expect(page.getByRole("heading", { name: "Usage dashboard" })).toBeVisible()
    await expectSeparatedSkeletons(page)
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
    await expect(page.getByRole("button", { name: "Refreshing…", exact: true })).toBeDisabled()
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

for (const route of ["endpoint", "providers", "aliases", "budgets", "model-pricing", "providers/codex", "cliproxy"]) {
  test(`${route} loading preserves page and card padding on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 })
    await authenticate(page)
    const endpoint = route === "cliproxy" ? "cliproxy/status" : route === "aliases" ? "combos" : route === "endpoint" ? "endpoint-key" : route
    const data = await hold(page, `**/api/admin/${endpoint}`)
    await page.goto(({ endpoint: "/dashboard/ai/endpoint", providers: "/dashboard/ai/providers", aliases: "/dashboard/ai/routing", budgets: "/dashboard/ai/budgets", "model-pricing": "/dashboard/ai/pricing", "providers/codex": "/dashboard/ai/codex-providers", cliproxy: "/dashboard/cliproxy" } as Record<string, string>)[route]!)
    await data.reached
    const selector = 'main [data-slot="card-header"]'
    await expect(page.locator(selector).first()).toBeVisible()
    await expectSeparatedSkeletons(page)
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
