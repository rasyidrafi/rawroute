import { expect, test } from "@playwright/test"

test("OAuth Providers menu connects and manages a Codex account", async ({ page }) => {
  await page.request.post("http://127.0.0.1:3211/reset")
  const login = await page.request.post("/api/auth/login", { data: { username: "admin", password: "change-me-now" } })
  expect(login.ok()).toBe(true)
  const password = await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })
  expect(password.ok()).toBe(true)
  await page.goto("/dashboard/oauth-providers")

  await expect(page.getByRole("link", { name: "OAuth Providers" })).toBeVisible()
  await expect(page.getByText("No Codex accounts connected yet.")).toBeVisible()
  await page.getByRole("button", { name: "Add Codex account" }).click()
  await expect(page.getByTestId("codex-user-code")).toHaveText("ABCD-EFGH")
  await page.getByLabel("Account label").fill("Work Codex")
  await expect(page.getByText("Work Codex")).toBeVisible({ timeout: 7_000 })
  const debug = await page.request.get("http://127.0.0.1:3211/debug")
  expect((await debug.json()).pollCount).toBeGreaterThanOrEqual(2)

  await page.getByRole("button", { name: "Disable" }).click()
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Remove Work Codex?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("No Codex accounts connected yet.")).toBeVisible()
})
