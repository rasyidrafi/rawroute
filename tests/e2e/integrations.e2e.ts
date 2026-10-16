import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

for (const width of [390, 1440]) {
  test(`integration catalog and guides fit at ${width}px`, async ({ page }, testInfo) => {
    await authenticate(page)
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" })
    await page.goto("/dashboard/ai/integrations")
    await expect(page.getByRole("heading", { name: "Choose your tool" })).toBeVisible()
    await expect(page.getByText("Connect your coding agents to RawRoute.", { exact: true })).toBeVisible()
    await expect(page.getByRole("note")).toHaveCount(0)
    await expect(page.locator('[data-slot="card-footer"]')).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Guide coming soon" })).toHaveCount(4)
    for (const name of ["OpenCode", "Codex", "Claude Code", "Cursor", "Continue", "OpenAI-compatible apps"]) {
      const card = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name, exact: true }) })
      const logo = card.locator('[data-slot="card-header"] svg')
      await expect(logo).toHaveCount(1)
      await expect(logo).toHaveAttribute("fill", "currentColor")
      await expect(logo).toHaveAttribute("aria-hidden", "true")
      await expect(logo.locator("path")).toHaveCount(1)
      expect(await logo.evaluate(element => element.getBoundingClientRect().width)).toBe(20)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`integrations-${width}.png`), fullPage: true })

    await page.setViewportSize({ width, height: 700 })
    for (const name of ["OpenCode", "Codex"]) {
      await expect(page.getByRole("heading", { name: "Choose your tool" })).toBeVisible()
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
      await page.getByRole("link", { name: `View ${name} setup guide` }).click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      const guideHeader = page.locator('[data-slot="card-header"]').filter({ has: page.getByRole("heading", { name, exact: true }) })
      await expect(guideHeader.locator('[data-slot="badge"]')).toHaveCount(0)
      const logoBounds = (await guideHeader.locator("svg").boundingBox())!
      const titleBounds = (await guideHeader.getByRole("heading", { name, exact: true }).boundingBox())!
      const descriptionBounds = (await guideHeader.locator('[data-slot="card-description"]').boundingBox())!
      expect(titleBounds.x).toBeGreaterThan(logoBounds.x + logoBounds.width)
      expect(descriptionBounds.x).toBe(titleBounds.x)
      expect(descriptionBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height)
      await expect(page.getByRole("heading", { name: `Set up ${name}`, exact: true })).toBeVisible()
      await expect(page.getByRole("note")).toContainText("placeholders")
      await page.reload()
      await expect(page.getByRole("heading", { name: "Provider configuration", exact: true })).toBeVisible()
      const connectionCards = page.locator('main [data-slot="card-content"] > .grid > [data-slot="card"]')
      await expect(connectionCards).toHaveCount(3)
      // Card rings extend one pixel outside their box and must fit inside the scroll container.
      expect(await connectionCards.evaluateAll(cards => cards.every(card => {
        const bounds = card.getBoundingClientRect()
        const content = card.parentElement!.parentElement!.getBoundingClientRect()
        return bounds.top - content.top >= 1 && content.bottom - bounds.bottom >= 1
      }))).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${name.toLowerCase()}-${width}.png`), fullPage: true })
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await page.goBack()
      await expect(page).toHaveURL(/\/dashboard\/ai\/integrations$/)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      await page.goForward()
      await expect(page.getByRole("heading", { name: `Set up ${name}`, exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      await page.getByRole("link", { name: "Back to integrations" }).click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    }
  })
}

test("integration copy actions use the current origin and placeholder configuration", async ({ page, context }) => {
  await authenticate(page)
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/dashboard/ai/integrations")
  await page.getByRole("button", { name: "Copy base URL", exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("http://127.0.0.1:3100/v1")
  for (const [name, path] of [["Chat Completions", "/chat/completions"], ["Responses", "/responses"], ["Messages", "/messages"]]) {
    const copy = page.getByRole("button", { name: `Copy ${name} endpoint`, exact: true })
    await expect(copy.locator("..").locator("code")).toHaveText(path!)
    await copy.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:3100/v1${path}`)
  }
  await page.getByRole("link", { name: "View OpenCode setup guide" }).click()
  await page.getByRole("button", { name: "Copy opencode.json", exact: true }).click()
  await expect.poll(async () => JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({
    providers: { rawroute: { settings: { baseURL: "http://127.0.0.1:3100/v1" }, models: { "workspace-model": { modelID: "YOUR_MODEL_ID" } } } },
  })
  await page.getByRole("button", { name: "Copy Terminal", exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('export RAWROUTE_API_KEY="YOUR_WORKSPACE_API_KEY"')
  await page.getByRole("link", { name: "Back to integrations" }).click()
  await page.getByRole("link", { name: "View Codex setup guide" }).click()
  await page.getByRole("button", { name: "Copy config.toml", exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('experimental_bearer_token="PUT_TOKEN_HERE"')
  await expect(page.getByLabel("config.toml example")).toContainText('model = "gpt-6-luna"')
  await page.getByRole("link", { name: "Open Endpoint & Key" }).click()
  await expect(page).toHaveURL(/\/dashboard\/ai\/endpoint$/)
})
