import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

for (const width of [320, 390, 900, 1440]) {
  test(`Settings uses the available space at ${width}px`, async ({ page }, testInfo) => {
    await authenticate(page)
    await page.setViewportSize({ width, height: 1000 })
    await page.goto("/dashboard/settings")
    await expect(page.getByLabel("Current password", { exact: true })).toBeVisible()
    await expect(page.getByRole("switch", { name: "Debug logging", exact: true })).toHaveCount(0)
    await expect(page.locator('main [data-slot="card"]')).toHaveCount(2)
    await expect(page.getByRole("button", { name: "Light Mode", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Dark Mode", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "System", exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`), fullPage: true, animations: "disabled" })
  })
}

test("appearance persists and follows system changes from Settings", async ({ page }) => {
  await authenticate(page)
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/dashboard/settings")
  const current = page.getByLabel("Current password", { exact: true })
  await current.fill("unsaved-password")
  const light = page.getByRole("button", { name: "Light Mode", exact: true })
  const dark = page.getByRole("button", { name: "Dark Mode", exact: true })
  const system = page.getByRole("button", { name: "System", exact: true })
  await expect(system).toHaveAttribute("aria-pressed", "true")
  await dark.click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(dark).toHaveAttribute("aria-pressed", "true")
  await expect(current).toHaveValue("unsaved-password")
  await dark.click()
  await expect(dark).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(dark).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("html")).toHaveClass(/dark/)
  await light.click()
  await expect(page.locator("html")).toHaveClass(/light/)
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/light/)
  await system.click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveClass(/light/)
  await page.reload()
  await expect(system).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("button", { name: "Change color theme" })).toHaveCount(0)
})

for (const width of [390, 1440]) {
  test(`header stays visible while scrolling and keeps the workspace on the right at ${width}px`, async ({ page }, testInfo) => {
    await authenticate(page)
    await page.setViewportSize({ width, height: 700 })
    const workspaceName = "Workspace with a long name for header layout verification"
    await page.route("**/api/admin/workspaces", async route => {
      const response = await route.fetch()
      const data = await response.json()
      await route.fulfill({ json: { ...data, workspaces: data.workspaces.map((workspace: { name: string }) => ({ ...workspace, name: workspaceName })) } })
    })
    await page.goto("/dashboard/ai/overview/usage")
    const header = page.locator('[data-slot="sidebar-inset"] > header')
    const badge = header.getByTitle(`Workspace: ${workspaceName}`, { exact: true })
    await expect(badge).toBeVisible()
    const titleBounds = await header.getByRole("heading", { name: "Usage", exact: true }).boundingBox()
    const badgeBounds = await badge.boundingBox()
    expect(badgeBounds!.x).toBeGreaterThan(titleBounds!.x + titleBounds!.width)
    expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(width)
    await page.evaluate(() => window.scrollTo(0, 650))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    await expect.poll(async () => (await header.boundingBox())!.y).toBe(0)
    await expect(header.getByRole("button", { name: "Toggle Sidebar" })).toBeInViewport()
    await expect(badge).toBeInViewport()
    await expect(header.getByRole("button", { name: "Change color theme" })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`sticky-header-${width}.png`), animations: "disabled" })
  })
}

test("password visibility preserves form values", async ({ page }) => {
  await authenticate(page)
  await page.goto("/dashboard/settings")
  const current = page.getByLabel("Current password", { exact: true })
  await current.fill("private-password")
  await expect(current).toHaveAttribute("type", "password")
  await page.getByRole("button", { name: "Show current password", exact: true }).click()
  await expect(current).toHaveAttribute("type", "text")
  await expect(current).toHaveValue("private-password")
  await page.getByRole("button", { name: "Hide current password", exact: true }).click()
  await expect(current).toHaveAttribute("type", "password")
  await page.getByLabel("New password", { exact: true }).fill("new-private-password")
  await page.getByLabel("Confirm new password", { exact: true }).fill("new-private-password")
  await page.route("**/api/admin/account/password", async route => {
    expect(route.request().postDataJSON()).toEqual({ currentPassword: "private-password", newPassword: "new-private-password", confirmPassword: "new-private-password" })
    await route.fulfill({ json: { ok: true } })
  })
  await page.getByRole("button", { name: "Update password", exact: true }).click()
  await expect(page.getByText("Password updated", { exact: true })).toBeVisible()
  await expect(current).toHaveValue("")
})
