import { expect, test } from "@playwright/test"

test.use({ timezoneId: "Asia/Jakarta", hasTouch: true })

test("Codex Providers menu connects and manages a Codex account", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  const existing = await page.request.get("/api/admin/oauth-providers", { headers: { "x-rawroute-workspace-id": "default" } })
  for (const account of (await existing.json()).accounts) {
    expect((await page.request.delete(`/api/admin/oauth-providers/${account.id}`, { headers: { "x-rawroute-workspace-id": "default" } })).ok()).toBe(true)
  }
  await page.request.post("http://127.0.0.1:3211/reset")
  await page.goto("/dashboard/ai/codex-providers")

  await expect(page.getByRole("link", { name: "Codex Providers" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No accounts yet", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Add Codex Account", exact: true }).click()
  await page.getByLabel("Account label").fill("Work Codex")
  const authorizationUrl = await page.getByRole("button", { name: "Open Codex sign-in" }).getAttribute("href")
  const state = new URL(authorizationUrl!).searchParams.get("state")
  await page.getByLabel("Redirect URL").fill(`http://localhost:1455/auth/callback?code=e2e-code&state=${state}`)
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(page.getByText("Work Codex")).toBeVisible({ timeout: 7_000 })
  const debug = await page.request.get("http://127.0.0.1:3211/debug")
  expect((await debug.json()).pollCount).toBeGreaterThanOrEqual(1)

  const connected = await (await page.request.get("/api/admin/oauth-providers", { headers: { "x-rawroute-workspace-id": "default" } })).json() as { accounts: Array<{ id: string }> }
  let expiryUnavailable = false
  await page.route("**/api/admin/oauth-providers/usage", route => route.fulfill({ json: { accounts: Object.fromEntries(connected.accounts.map(account => [account.id, { planType: "free", fiveHour: null, weekly: null, fetchedAt: new Date().toISOString(), stale: expiryUnavailable, unusedResetCredits: 2,
    ...(expiryUnavailable ? { resetCreditsError: "Expiry unavailable" } : { resetCredits: [
      { id: "later", status: "available", expiresAt: "2099-11-06T22:59:00Z" },
      { id: "earlier", status: "available", expiresAt: "2099-10-22T20:28:00Z" },
      { id: "used", status: "consumed", expiresAt: "2099-01-01T00:00:00Z" },
    ] }), }])) } }))
  await page.reload()
  const accountRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Work Codex", exact: true }) })
  await expect(accountRow.getByRole("cell", { name: "Free", exact: true })).toBeVisible()
  await expect(accountRow.getByRole("cell", { name: "Plus", exact: true })).toHaveCount(0)

  const info = accountRow.getByRole("button", { name: "View reset expiry", exact: true })
  await info.hover()
  const details = page.getByRole("dialog", { name: "Unused reset expiry" })
  await expect(details).toBeVisible()
  await expect(details).toContainText("Asia/Jakarta")
  await expect(details.locator("time")).toHaveText(["23 Oct 2099, 03:28", "7 Nov 2099, 05:59"])
  await expect(details.getByText(/remaining/)).toHaveCount(2)
  await page.keyboard.press("Escape")
  await expect(details).toBeHidden()
  await page.mouse.move(0, 0)
  await page.getByRole("link", { name: "Codex Providers", exact: true }).focus()
  await info.focus()
  await expect(details).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(details).toBeHidden()
  await page.setViewportSize({ width: 390, height: 844 })
  await info.tap()
  await expect(details).toBeVisible()
  const bounds = (await details.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  await page.keyboard.press("Escape")
  expiryUnavailable = true
  await page.reload()
  await info.tap()
  await expect(details.getByText("Expiry unavailable", { exact: true })).toBeVisible()
  await expect(details.getByText("Usage is from an earlier check.", { exact: true })).toBeVisible()
  await expect(accountRow.getByText("2", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.getByRole("button", { name: "Disable Work Codex", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Disable account", exact: true }).click()
  await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Work Codex", exact: true }) }).getByRole("cell", { name: "Disabled", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Remove Work Codex?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("heading", { name: "No accounts yet", exact: true })).toBeVisible()
})
