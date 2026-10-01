import { expect, test } from "@playwright/test"

test("Codex Providers menu connects and manages a Codex account", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  const existing = await page.request.get("/api/admin/oauth-providers", { headers: { "x-rawroute-workspace-id": "default" } })
  for (const account of (await existing.json()).accounts) {
    expect((await page.request.delete(`/api/admin/oauth-providers/${account.id}`, { headers: { "x-rawroute-workspace-id": "default" } })).ok()).toBe(true)
  }
  await page.request.post("http://127.0.0.1:3211/reset")
  const password = await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })
  expect(password.ok()).toBe(true)
  await page.goto("/dashboard/providers/codex")

  await expect(page.getByRole("link", { name: "Codex Providers" })).toBeVisible()
  await expect(page.getByText("No accounts yet.")).toBeVisible()
  await page.getByRole("button", { name: "Add Codex Account", exact: true }).click()
  await page.getByLabel("Account label").fill("Work Codex")
  const authorizationUrl = await page.getByRole("button", { name: "Open Codex sign-in" }).getAttribute("href")
  const state = new URL(authorizationUrl!).searchParams.get("state")
  await page.getByLabel("Redirect URL").fill(`http://localhost:1455/auth/callback?code=e2e-code&state=${state}`)
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(page.getByText("Work Codex")).toBeVisible({ timeout: 7_000 })
  const debug = await page.request.get("http://127.0.0.1:3211/debug")
  expect((await debug.json()).pollCount).toBeGreaterThanOrEqual(1)

  await page.getByRole("button", { name: "Disable Work Codex", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Disable account", exact: true }).click()
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Remove Work Codex?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("No accounts yet.")).toBeVisible()
})
