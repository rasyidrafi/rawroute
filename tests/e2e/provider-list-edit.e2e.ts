import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

test("providers list rows edit in place left of delete without losing provider settings", async ({ page }) => {
  await authenticate(page)
  const headers = { "x-rawroute-workspace-id": "default" }
  const created = await page.request.post("/api/admin/providers", { headers, data: { provider: { name: "List Edit E2E", prefix: "le2e", baseUrl: "https://example.com/v1", protocol: "openai-responses", authType: "bearer", reasoningSummaries: true } } })
  expect(created.ok(), await created.text()).toBe(true)
  const { providerId } = await created.json()
  await page.goto("/dashboard/ai/providers")
  const edit = page.getByRole("button", { name: "Edit List Edit E2E", exact: true })
  const remove = page.getByRole("button", { name: "Delete List Edit E2E?", exact: true })
  await expect(edit).toBeVisible()
  expect((await edit.boundingBox())!.x).toBeLessThan((await remove.boundingBox())!.x)
  await edit.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator('input[name="name"]')).toHaveValue("List Edit E2E")
  await dialog.locator('input[name="name"]').fill("List Edited E2E")
  await dialog.getByRole("button", { name: "Update provider", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("link", { name: "List Edited E2E", exact: true })).toBeVisible()
  const list = await (await page.request.get("/api/admin/providers", { headers })).json()
  const saved = list.providers.find((entry: { id: string }) => entry.id === providerId)
  expect(saved.name).toBe("List Edited E2E")
  expect(saved.reasoningSummaries).toBe(true)
  expect((await page.request.delete(`/api/admin/providers/${providerId}`, { headers })).ok()).toBe(true)
})