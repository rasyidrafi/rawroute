import { expect, test, type Page } from "@playwright/test"

async function expectNoCardOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const overflowingCards = await page.locator('[data-slot="card-content"]').evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).length)
  expect(overflowingCards).toBe(0)
}

test("budget controls and loading layout fit mobile, medium, and desktop widths", async ({ page }) => {
  await authenticate(page)
  const accountName = "Codex account with a deliberately long name for responsive layout verification"
  for (const width of [320, 375, 640, 768, 1024, 1248, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    let release = () => {}
    const loadingGate = new Promise<void>(resolve => { release = resolve })
    await page.route("**/api/admin/budgets", async route => {
      const response = await route.fetch()
      const data = await response.json()
      await loadingGate
      await route.fulfill({ response, json: {
        ...data,
        codexAccounts: [{ id: "responsive-account", name: accountName }],
        apiKeys: [{ id: "available-key", name: "Gateway key with a deliberately long name for responsive layout verification" }],
        budgets: [
          { apiKeyId: "higher-limit", name: "Higher limit key", weeklyLimitMicros: 100000000, spentMicros: 1000000, enabled: true },
          { apiKeyId: "configured-key", name: "Configured gateway key", weeklyLimitMicros: 50000000, spentMicros: 10000000, enabled: true },
        ],
        window: { ...data.window, anchor: "custom" },
      } })
    })
    await page.goto("/dashboard/ai/budgets")
    await expect(page.locator('[data-variant="budgets"]')).toBeVisible()
    await expectNoCardOverflow(page)
    release()
    await expect(page.getByRole("button", { name: "Save window", exact: true })).toBeEnabled()
    const order = page.getByRole("combobox", { name: "Order rows by", exact: true })
    await expect(order).toContainText("Highest usage first")
    const labelBox = (await page.getByText("Order rows by", { exact: true }).boundingBox())!
    const orderBox = (await order.boundingBox())!
    expect(orderBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width)
    expect(Math.abs(labelBox.y + labelBox.height / 2 - orderBox.y - orderBox.height / 2)).toBeLessThan(1)
    await expect(page.locator("tbody tr").first()).toContainText("Configured gateway key")
    await expectNoCardOverflow(page)
    const windowCard = page.locator('[data-slot="card"]').filter({ has: page.getByText("Budget window", { exact: true }) })
    for (const control of await windowCard.locator("button").all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    await windowCard.getByRole("button", { name: /\d{2}:\d{2}/ }).click()
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible()
    await expectNoCardOverflow(page)
    await page.getByRole("button", { name: "Apply", exact: true }).click()
    await page.getByRole("combobox", { name: "Window anchor" }).click()
    await page.getByRole("option", { name: "Sync Codex account", exact: true }).click()
    await page.getByRole("combobox", { name: "Codex account" }).click()
    await page.getByRole("option", { name: accountName, exact: true }).click()
    await expect(page.getByRole("combobox", { name: "Codex account" })).toContainText(accountName)
    await expectNoCardOverflow(page)
    await page.getByRole("combobox", { name: "Gateway key" }).click()
    await page.getByRole("option", { name: /Gateway key with a deliberately long name/ }).click()
    await expect(page.getByRole("button", { name: "Create budget", exact: true })).toBeEnabled()
    await expectNoCardOverflow(page)
    await page.unroute("**/api/admin/budgets")
  }
})

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  const account = await page.request.get("/api/admin/account")
  if ((await account.json()).mustChangePassword) {
    const password = await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })
    expect(password.ok()).toBe(true)
  }
}

async function seedModel(page: Page) {
  const response = await page.request.post("/api/admin/providers", { headers: { "x-rawroute-workspace-id": "default" },
    data: { provider: { name: "Budget test provider", prefix: "budget-test", baseUrl: "https://example.com/v1", protocol: "openai-chat", authType: "none", headers: {} } },
  })
  expect(response.ok()).toBe(true)
  const providerId = (await response.json()).providerId as string
  const model = await page.request.post(`/api/admin/providers/${providerId}/models`, { headers: { "x-rawroute-workspace-id": "default" },
    data: { model: { gatewayModelId: "over-limit", name: "Over-limit model", upstreamModel: "over-limit" } },
  })
  expect(model.ok()).toBe(true)
}

test("Beyond Limits saves selected model exceptions from the budgets page", async ({ page }) => {
  await authenticate(page)
  await seedModel(page)
  await page.goto("/dashboard/ai/budgets")

  await page.getByRole("tab", { name: "Beyond Limits" }).click()
  await expect(page.getByText("Let selected models continue after a gateway key reaches its budget.")).toBeVisible()
  await page.getByRole("checkbox", { name: "Enabled" }).click()
  await page.getByText("Over-limit model").click()
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByText("Beyond Limits settings saved")).toBeVisible()

  const budgets = await page.request.get("/api/admin/budgets", { headers: { "x-rawroute-workspace-id": "default" } })
  expect(budgets.ok()).toBe(true)
  expect((await budgets.json()).beyondLimits).toMatchObject({ enabled: true, modelIds: ["budget-test/over-limit"] })

  expect((await page.request.patch("/api/admin/budgets/beyond-limits", { headers: { "x-rawroute-workspace-id": "default" },  data: { enabled: false, modelIds: [] } })).ok()).toBe(true)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Enabled", exact: true })).not.toBeChecked()
  await expect(page.getByRole("tabpanel").getByText("0 selected", { exact: true })).toBeVisible()

  await page.getByRole("tab", { name: "Unlimited Mode" }).click()
  await page.getByText("Over-limit model").click()
  await page.getByRole("button", { name: "Save exclusions" }).click()
  await expect(page.getByText("Unlimited Mode exclusions saved")).toBeVisible()
  await page.getByRole("button", { name: "Activate" }).click()
  await page.getByRole("checkbox", { name: "Auto-deactivate at budget window end" }).click()
  await page.getByRole("button", { name: "Activate Unlimited Mode" }).click()
  await expect(page.getByText("Scheduled for", { exact: false })).toBeVisible()

  const unlimited = await page.request.get("/api/admin/budgets", { headers: { "x-rawroute-workspace-id": "default" } })
  expect(unlimited.ok()).toBe(true)
  expect((await unlimited.json())).toMatchObject({
    unlimited: { excludedModelIds: ["budget-test/over-limit"] },
    window: { bypassLimits: true, bypassAutoDeactivateAtWindowEnd: true },
  })
  await page.getByRole("tabpanel").getByRole("button", { name: "Deactivate", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Deactivate", exact: true }).click()

  // Once a draft is saved, refreshed server settings must become the source of truth.
  expect((await page.request.patch("/api/admin/budgets/unlimited", { headers: { "x-rawroute-workspace-id": "default" },  data: { excludedModelIds: [] } })).ok()).toBe(true)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("tabpanel").getByText("0 selected", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save exclusions" })).toBeDisabled()

})
