import { expect, test, type Page } from "@playwright/test"

const workspaceHeaders = { "x-rawroute-workspace-id": "default" }

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

test("provider API keys toggle from the row with confirmation, fade when disabled, and no enabled checkbox in the form", async ({ page }) => {
  await authenticate(page)
  const created = await page.request.post("/api/admin/providers", { headers: workspaceHeaders, data: { provider: { name: "Key Toggle E2E", prefix: `kt${Date.now()}`, baseUrl: "https://example.com/v1", protocol: "openai-chat", authType: "bearer" } } })
  expect(created.ok(), await created.text()).toBe(true)
  const { providerId } = await created.json()
  const keyResponse = await page.request.post(`/api/admin/providers/${providerId}/api-keys`, { headers: workspaceHeaders, data: { providerApiKey: { name: "Toggle E2E", key: "toggle-e2e-secret", rpmLimit: 60, maxConcurrency: 4 } } })
  expect(keyResponse.ok(), await keyResponse.text()).toBe(true)
  const savedKey = async () => {
    const detail = await (await page.request.get(`/api/admin/providers/${providerId}`, { headers: workspaceHeaders })).json()
    return detail.apiKeys.find((key: { name: string }) => key.name === "Toggle E2E")
  }
  await page.goto(`/dashboard/ai/providers/${providerId}`)
  const row = page.getByRole("row").filter({ hasText: "Toggle E2E" })
  await expect(row.getByText("Enabled", { exact: true })).toBeVisible()
  const edit = page.getByRole("button", { name: "Edit Toggle E2E", exact: true })
  const toggle = page.getByRole("button", { name: "Disable Toggle E2E", exact: true })
  const remove = page.getByRole("button", { name: "Delete Toggle E2E?", exact: true })
  expect((await edit.boundingBox())!.x).toBeLessThan((await toggle.boundingBox())!.x)
  expect((await toggle.boundingBox())!.x).toBeLessThan((await remove.boundingBox())!.x)
  await toggle.click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm.getByText("Disable API key?", { exact: true })).toBeVisible()
  await confirm.getByRole("button", { name: "Disable key", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(row.getByText("Disabled", { exact: true })).toBeVisible()
  await expect.poll(() => row.evaluate((element) => getComputedStyle(element).opacity)).toBe("0.6")
  expect((await savedKey()).enabled).toBe(false)
  await edit.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Enabled for routing", { exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await page.getByRole("button", { name: "Enable Toggle E2E", exact: true }).click()
  await expect(confirm.getByText("Enable API key?", { exact: true })).toBeVisible()
  await confirm.getByRole("button", { name: "Enable key", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(row.getByText("Enabled", { exact: true })).toBeVisible()
  await expect.poll(() => row.evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
  const final = await savedKey()
  expect(final.enabled).toBe(true)
  expect(final.rpmLimit).toBe(60)
  expect(final.maxConcurrency).toBe(4)
  expect((await page.request.delete(`/api/admin/providers/${providerId}`, { headers: workspaceHeaders })).ok()).toBe(true)
})