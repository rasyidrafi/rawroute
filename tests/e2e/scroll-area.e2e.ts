import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "change-me-now" },
  })
  if (!login.ok()) {
    login = await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "private-password" },
    })
  }
  expect(login.ok()).toBe(true)

  const account = await page.request.get("/api/admin/account")
  expect(account.ok()).toBe(true)
  if ((await account.json()).mustChangePassword) {
    const password = await page.request.post("/api/admin/account/password", {
      data: { password: "private-password" },
    })
    expect(password.ok()).toBe(true)
  }
}

let firstProviderId = ""

async function saveProvider(page: Page, index: number) {
  const prefix = `provider-${index}`
  const providers = await page.request.get("/api/admin/providers")
  expect(providers.ok()).toBe(true)
  const existing = ((await providers.json()).providers as Array<{ id: string; prefix: string }>).find((provider) => provider.prefix === prefix)
  const response = await page.request.post("/api/admin/providers", {
    data: {
      provider: {
        ...(existing ? { originalId: existing.id } : {}),
        name: `Provider ${index}`,
        prefix,
        baseUrl: "https://example.com/v1",
        protocol: "openai-chat",
        authType: "none",
        headers: {},
      },
    },
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).providerId as string
}

async function expectWheelScrolls(viewport: ReturnType<Page["locator"]>) {
  const dimensions = await viewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)

  await viewport.hover()
  await viewport.page().mouse.wheel(0, 600)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
}

test.beforeEach(async ({ page }) => {
  await authenticate(page)
  firstProviderId = await saveProvider(page, 0)
  for (let index = 1; index < 24; index += 1) await saveProvider(page, index)
})

test("console stays fixed-height and scrolls its log content", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/dashboard/logs")

  const main = page.locator('main[class*="100svh"]')
  const consoleArea = page.locator('[data-slot="card"]', { hasText: "Console Log" }).locator('[data-slot="scroll-area"]')
  const viewport = consoleArea.locator('[data-slot="scroll-area-viewport"]')

  await expect(consoleArea).toBeVisible()
  await expect(page.getByText("Loading logs...")).toBeHidden()
  await expect.poll(() => main.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(720)
  await expectWheelScrolls(viewport)

  await page.setViewportSize({ width: 390, height: 667 })
  await expect.poll(() => main.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(667)
  await viewport.evaluate((element) => { element.scrollTop = 0 })
  await expectWheelScrolls(viewport)
})

test("model dialog and long protocol select remain scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto(`/dashboard/providers/${firstProviderId}`)
  await page.getByRole("button", { name: "Add model" }).click()

  const dialog = page.getByRole("dialog")
  const dialogViewport = dialog.locator('[data-slot="scroll-area-viewport"]').first()
  await expect(dialog).toBeVisible()
  await expectWheelScrolls(dialogViewport)

  await dialogViewport.evaluate((element) => { element.scrollTop = 0 })
  await dialog.locator('[data-slot="select-trigger"]').first().click()
  const select = page.locator('[data-slot="select-content"]')
  const selectViewport = select.locator('[data-slot="scroll-area-viewport"]')
  await expect(select).toBeVisible()
  const finalProtocol = page.getByRole("option", { name: "Anthropic Messages" })
  const selectDimensions = await selectViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  if (selectDimensions.scrollHeight > selectDimensions.clientHeight) {
    await selectViewport.hover()
    await selectViewport.page().mouse.wheel(0, 600)
    await expect.poll(() => selectViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  }
  await expect(finalProtocol).toBeVisible()
  await finalProtocol.click()
  await expect(dialog.locator('[data-slot="select-trigger"]').first()).toContainText("Anthropic")
})

test("dropdown menu interaction survives ScrollArea composition", async ({ page }) => {
  await page.goto(`/dashboard/providers/${firstProviderId}`)
  await expect(page.getByText("Provider details")).toBeVisible()
  await page.getByRole("button", { name: "Change color theme" }).click()
  await page.getByRole("menuitemradio", { name: "Dark" }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)
})

test("wide model tables use horizontal ScrollArea scrolling", async ({ page }) => {
  const response = await page.request.post(`/api/admin/providers/${firstProviderId}/models`, {
    data: {
      model: {
        gatewayModelId: "model-with-an-intentionally-long-suffix-name",
        name: "Wide model",
        upstreamModel: `upstream-${"x".repeat(140)}`,
      },
    },
  })
  expect(response.ok()).toBe(true)

  await page.setViewportSize({ width: 600, height: 700 })
  await page.goto(`/dashboard/providers/${firstProviderId}`)
  const modelCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: /^Models$/ }) })
  const viewport = modelCard.locator('[data-slot="table-container"] [data-slot="scroll-area-viewport"]')
  const dimensions = await viewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth)
  await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
})
