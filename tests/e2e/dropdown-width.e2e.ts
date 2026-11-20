import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

const logsPath = "/dashboard/ai/overview/request-logs"

test("select popups size to their longest option and stay inside the viewport", async ({ page }) => {
  await authenticate(page)
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(logsPath)
    const trigger = page.getByRole("combobox", { name: "Status" })
    await expect(trigger).toBeVisible()
    await trigger.click()
    const popup = page.locator('[data-slot="select-content"]')
    await expect(popup).toBeVisible()
    const triggerBox = (await trigger.boundingBox())!
    const popupBox = (await popup.boundingBox())!
    // The popup grows past the compact trigger to fit "Recovered by fallback".
    expect(popupBox.width).toBeGreaterThan(triggerBox.width)
    expect(popupBox.x).toBeGreaterThanOrEqual(0)
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width)
    const longOption = popup.getByRole("option", { name: "Recovered by fallback" })
    await expect(longOption).toBeVisible()
    const clipped = await longOption.getByText("Recovered by fallback").evaluate(element => element.scrollWidth > element.clientWidth + 1)
    expect(clipped).toBe(false)
    await page.keyboard.press("Escape")
    await expect(popup).toBeHidden()
  }
})

test("model picker groups duplicate names, searches, and selects by keyboard within a narrow viewport", async ({ page }) => {
  await authenticate(page)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.route(`**/api/admin/request-logs?*`, route => route.fulfill({ json: {
    events: [], nextCursor: null, from: "2026-11-19T00:00:00.000Z", to: "2026-11-20T00:00:00.000Z",
    models: [
      { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", provider: "OpenAI" },
      { id: "team-b/gpt-6.2-sol", name: "GPT-6.2 Sol", provider: "Team B" },
      { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "OpenAI" },
      { id: "removed/model", name: "removed/model", provider: null },
      { id: "edge/long-provider-model", name: "Long Provider Model", provider: "Deliberately long provider name for trigger truncation" },
    ],
    keys: [],
  } }))
  await page.goto(logsPath)
  const trigger = page.getByRole("button", { name: "Model", exact: true })
  await expect(trigger).toContainText("All models")
  await trigger.click()
  const popup = page.locator('[data-slot="popover-content"]')
  await expect(popup).toBeVisible()
  const popupBox = (await popup.boundingBox())!
  expect(popupBox.width).toBeLessThanOrEqual(288)
  expect(popupBox.x).toBeGreaterThanOrEqual(0)
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(320)
  // Duplicate display names stay distinguishable by provider group and gateway ID.
  await expect(popup.getByText("OpenAI (2)", { exact: true })).toBeVisible()
  await expect(popup.getByText("Team B (1)", { exact: true })).toBeVisible()
  await expect(popup.getByText("Other models (1)", { exact: true })).toBeVisible()
  await expect(popup.getByText("team-b/gpt-6.2-sol", { exact: true })).toBeVisible()
  await expect(popup.getByRole("option", { name: /GPT-6\.2 Sol/ })).toHaveCount(2)

  const search = popup.getByPlaceholder("Search name, ID, or provider...")
  await search.fill("sol")
  await expect(popup.getByRole("option", { name: /GPT-6\.2 Sol/ })).toHaveCount(2)
  await expect(popup.getByRole("option", { name: /GPT-6 Astra/ })).toHaveCount(0)
  await search.fill("zzz")
  await expect(popup.getByText("No models match your search.", { exact: true })).toBeVisible()
  await expect(popup.getByRole("option", { name: "All models" })).toBeVisible()

  await search.fill("astra")
  const refetch = page.waitForRequest(request => request.url().includes("model=gpt-6-astra"))
  await page.keyboard.press("Enter")
  await refetch
  await expect(popup).toHaveCount(0)
  await expect(trigger).toContainText("GPT-6 Astra")
  await expect(trigger).toContainText("OpenAI")

  await trigger.click()
  await popup.getByRole("option", { name: /team-b\/gpt-6\.2-sol/ }).click()
  await expect(popup).toHaveCount(0)
  await expect(trigger).toContainText("GPT-6.2 Sol")
  await expect(trigger).toContainText("Team B")

  // A long provider name must truncate inside the badge, never squeeze the model name or overflow the trigger.
  await trigger.click()
  await search.fill("long provider")
  await popup.getByRole("option", { name: /Long Provider Model/ }).click()
  await expect(popup).toHaveCount(0)
  await expect(trigger).toContainText("Long Provider Model")
  expect(await trigger.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false)
  expect((await trigger.locator("span").first().boundingBox())!.width).toBeGreaterThan(20)
  const badgeText = trigger.getByText("Deliberately long provider name", { exact: false })
  expect(await badgeText.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(true)
})