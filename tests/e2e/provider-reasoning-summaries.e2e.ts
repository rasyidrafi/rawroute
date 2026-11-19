import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

test("provider reasoning summaries setting appears for Responses protocol and persists", async ({ page }) => {
  await authenticate(page)
  const created = await page.request.post("/api/admin/providers", { headers: { "x-rawroute-workspace-id": "default" }, data: { provider: { name: "Reasoning E2E", prefix: "re2e", baseUrl: "https://example.com/v1", protocol: "openai-chat", authType: "bearer" } } })
  expect(created.ok(), await created.text()).toBe(true)
  const { providerId } = await created.json()
  const saved = async () => {
    const list = await (await page.request.get("/api/admin/providers", { headers: { "x-rawroute-workspace-id": "default" } })).json()
    return list.providers.find((entry: { id: string }) => entry.id === providerId)
  }
  await page.goto("/dashboard/ai/providers")
  await page.getByRole("link", { name: "Reasoning E2E", exact: true }).click()
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Enable reasoning summaries", { exact: true })).toHaveCount(0)
  await dialog.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "OpenAI Responses", exact: true }).click()
  const label = dialog.locator("label").filter({ hasText: "Enable reasoning summaries" })
  await expect(label).toBeVisible()
  await label.getByRole("checkbox").click()
  await dialog.getByRole("button", { name: "Update provider", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await saved()).reasoningSummaries).toBe(true)
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await dialog.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "OpenAI Chat Completions", exact: true }).click()
  await expect(dialog.getByText("Enable reasoning summaries", { exact: true })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Update provider", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await saved()).reasoningSummaries).toBe(false)
  expect((await page.request.delete(`/api/admin/providers/${providerId}`, { headers: { "x-rawroute-workspace-id": "default" } })).ok()).toBe(true)
})
