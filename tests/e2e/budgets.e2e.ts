import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { username: "admin", password: "change-me-now" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { username: "admin", password: "private-password" } })
  expect(login.ok()).toBe(true)
  const account = await page.request.get("/api/admin/account")
  if ((await account.json()).mustChangePassword) {
    const password = await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })
    expect(password.ok()).toBe(true)
  }
}

async function restoreDefaultPassword(page: Page) {
  const response = await page.request.post("/api/admin/account/password", { data: { password: "change-me-now" } })
  expect(response.ok()).toBe(true)
}

async function seedModel(page: Page) {
  const response = await page.request.post("/api/admin/providers", {
    data: { provider: { name: "Budget test provider", prefix: "budget-test", baseUrl: "https://example.com/v1", protocol: "openai-chat", authType: "none", headers: {} } },
  })
  expect(response.ok()).toBe(true)
  const providerId = (await response.json()).providerId as string
  const model = await page.request.post(`/api/admin/providers/${providerId}/models`, {
    data: { model: { gatewayModelId: "over-limit", name: "Over-limit model", upstreamModel: "over-limit" } },
  })
  expect(model.ok()).toBe(true)
}

test("Beyond Limits saves selected model exceptions from the budgets page", async ({ page }) => {
  await authenticate(page)
  await seedModel(page)
  await page.goto("/dashboard/budgets")

  await page.getByRole("tab", { name: "Beyond Limits" }).click()
  await expect(page.getByText("Let selected models continue after a gateway key reaches its budget.")).toBeVisible()
  await page.getByRole("checkbox", { name: "Enabled" }).click()
  await page.getByText("Over-limit model").click()
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByText("Beyond Limits settings saved")).toBeVisible()

  const budgets = await page.request.get("/api/admin/budgets")
  expect(budgets.ok()).toBe(true)
  expect((await budgets.json()).beyondLimits).toMatchObject({ enabled: true, modelIds: ["budget-test/over-limit"] })
  await restoreDefaultPassword(page)
})
