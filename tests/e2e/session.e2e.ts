import { expect, test, type Page, type Route } from "@playwright/test"
import { pagePaths } from "../../src/lib/dashboard/routes"

const sessionUrl = "**/api/auth/session"
const errorTitle = "Unable to check your session"

function browserErrors(page: Page) {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  return errors
}

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

for (const failure of ["server", "network", "invalid-json", "invalid-session"]) {
  test(`session ${failure} failure shows recovery without granting access`, async ({ page }) => {
    const errors = browserErrors(page)
    const adminRequests: string[] = []
    page.on("request", request => { if (request.url().includes("/api/admin/")) adminRequests.push(request.url()) })
    await page.route(sessionUrl, route => {
      if (failure === "network") return route.abort("failed")
      if (failure === "server") return route.fulfill({ status: 503, json: { error: "Unavailable" } })
      if (failure === "invalid-json") return route.fulfill({ contentType: "application/json", body: "invalid" })
      return route.fulfill({ json: { authenticated: "false" } })
    })
    await page.goto(pagePaths.overviewUsage)
    await expect(page.getByRole("alert", { name: errorTitle })).toBeVisible()
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled()
    expect(adminRequests).toEqual([])
    expect(errors).toEqual([])
  })
}

test("retry shows progress, handles repeated failure, and recovers to login", async ({ page }) => {
  const errors = browserErrors(page)
  let pending: Route | undefined
  let attempts = 0
  await page.route(sessionUrl, async route => {
    attempts++
    if (attempts === 1) await route.fulfill({ status: 503 })
    else pending = route
  })
  await page.goto(pagePaths.login)
  await page.getByRole("button", { name: "Try again" }).click()
  const checking = page.getByRole("complementary", { name: "Session connection" }).getByRole("button", { name: "Checking session…" })
  await expect(checking).toBeDisabled()
  await expect(checking).toHaveAttribute("aria-busy", "true")
  await expect.poll(() => pending !== undefined).toBe(true)
  expect(attempts).toBe(2)
  await pending!.fulfill({ status: 503 })
  pending = undefined
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled()
  await page.getByRole("button", { name: "Try again" }).click()
  await expect.poll(() => pending !== undefined).toBe(true)
  await pending!.fulfill({ json: { authenticated: false } })
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  await expect(page.getByRole("alert", { name: errorTitle })).toHaveCount(0)
  expect(errors).toEqual([])
})

test("a stalled session request times out and allows retry", async ({ page }) => {
  const errors = browserErrors(page)
  await page.route(sessionUrl, () => {})
  await page.goto(pagePaths.login)
  await expect(page.getByRole("button", { name: "Checking session…" })).toBeDisabled()
  await expect(page.getByLabel("Password", { exact: true })).toBeDisabled()
  await expect(page.getByRole("alert", { name: errorTitle })).toBeVisible({ timeout: 15_000 })
  await page.unroute(sessionUrl)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  expect(errors).toEqual([])
})

test("recovered sessions restore the requested dashboard and expired sessions redirect to login", async ({ page }) => {
  const errors = browserErrors(page)
  await authenticate(page)
  await page.route(sessionUrl, route => route.fulfill({ status: 503 }))
  await page.goto(pagePaths.overviewUsage)
  await expect(page.getByRole("alert", { name: errorTitle })).toBeVisible()
  await page.unroute(sessionUrl)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "Usage summary", exact: true })).toBeVisible()
  await expect(page).toHaveURL(pagePaths.overviewUsage)
  // A failed background check keeps the verified dashboard mounted beneath the banner.
  await page.route(sessionUrl, route => route.fulfill({ status: 503 }))
  await page.waitForTimeout(5_100)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByRole("alert", { name: errorTitle })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Usage summary", exact: true })).toBeVisible()
  await page.request.post("/api/auth/logout")
  await page.unroute(sessionUrl)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page).toHaveURL(pagePaths.login)
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  expect(errors).toEqual([])
})

test("offline banner preserves dashboard drafts and reconnects automatically", async ({ page, context }) => {
  const errors = browserErrors(page)
  await authenticate(page)
  await page.goto(pagePaths.settings)
  const password = page.getByLabel("Current password", { exact: true })
  await password.fill("unsaved-draft")
  await context.setOffline(true)
  await expect(page.getByRole("alert", { name: "You’re offline" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Waiting for connection" })).toBeDisabled()
  await expect(password).toHaveValue("unsaved-draft")
  await expect(password).toBeEnabled()
  // Let the session deduplication window elapse before reconnecting.
  await page.waitForTimeout(2_100)
  const rechecked = page.waitForResponse(response => response.url().endsWith("/api/auth/session") && response.ok())
  await context.setOffline(false)
  await rechecked
  await expect(page.getByRole("complementary", { name: "Session connection" })).toHaveCount(0)
  await expect(password).toHaveValue("unsaved-draft")
  expect(errors).toEqual([])
})

test("a failed background session check preserves login input through retry", async ({ page }) => {
  await page.goto(pagePaths.login)
  const password = page.getByLabel("Password", { exact: true })
  await password.fill("unsaved-login-password")
  await page.route(sessionUrl, route => route.fulfill({ status: 503 }))
  await page.waitForTimeout(5_100)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByRole("alert", { name: errorTitle })).toBeVisible()
  await expect(password).toHaveValue("unsaved-login-password")
  await expect(password).toBeDisabled()
  await page.unroute(sessionUrl)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(password).toBeEnabled()
  await expect(password).toHaveValue("unsaved-login-password")
})

test("session banner overlays the login page on mobile and desktop in both themes", async ({ page }, testInfo) => {
  await page.route(sessionUrl, route => route.fulfill({ status: 503 }))
  await page.goto(pagePaths.login)
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
      await expect(page.locator("html")).toHaveClass(dark ? /dark/ : /light/)
      await expect(page.getByRole("alert", { name: errorTitle })).toBeVisible()
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible()
      const bounds = await page.getByRole("complementary", { name: "Session connection" }).boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(bounds!.y).toBeGreaterThan(400)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`session-${width}-${dark ? "dark" : "light"}.png`), fullPage: true, animations: "disabled" })
    }
  }
  await page.getByRole("link", { name: "Back to home" }).click()
  await expect(page).toHaveURL(pagePaths.home)
  await expect(page.getByRole("heading", { name: "Usage summary", exact: true })).toBeVisible()
})
