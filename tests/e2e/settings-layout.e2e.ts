import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

for (const width of [390, 900, 1440]) {
  test(`Settings uses the available space at ${width}px`, async ({ page }, testInfo) => {
    await authenticate(page)
    await page.setViewportSize({ width, height: 1000 })
    await page.goto("/dashboard/settings")
    await expect(page.getByLabel("Current password", { exact: true })).toBeVisible()
    await expect(page.getByRole("switch", { name: "Debug logging", exact: true })).toHaveCount(0)
    await expect(page.locator('main [data-slot="card"]')).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`), fullPage: true })
  })
}

test("gateway switches save explicitly and password visibility preserves form values", async ({ page }) => {
  await authenticate(page)
  await page.goto("/dashboard/cliproxy")
  await page.getByRole("button", { name: "Engine settings", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/cliproxy\/settings$/)
  const toggle = page.getByRole("switch", { name: "Debug logging", exact: true })
  await expect(toggle).toBeVisible()
  const previous = await toggle.isChecked()
  let writes = 0
  page.on("request", request => { if (request.url().endsWith("/api/admin/cliproxy/settings") && request.method() === "PATCH") writes++ })
  await toggle.click()
  expect(writes).toBe(0)
  const saved = page.waitForResponse(response => response.url().endsWith("/api/admin/cliproxy/settings") && response.request().method() === "PATCH")
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  expect((await saved).ok()).toBe(true)
  expect(writes).toBe(1)
  await page.reload()
  await expect(toggle).toBeChecked({ checked: !previous })
  await expect(page.getByLabel("Routing strategy", { exact: true })).toHaveText("fill-first")
  await expect(page.locator('input[readonly]')).toHaveCount(0)

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
