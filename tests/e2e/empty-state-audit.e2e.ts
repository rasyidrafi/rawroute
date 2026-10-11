import { expect, test, type Page } from "@playwright/test"
import type { Model, ProviderSummary } from "../../src/lib/types"
import type { LogSnapshot } from "../../src/lib/logging/types"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

function logSnapshot(entries: LogSnapshot["entries"] = []): LogSnapshot {
  return { scope: "workspace", workspaceId: "default", entries, capacity: 100, evicted: 0 }
}

async function readConsoleEmptyStateContrast(page: Page) {
  return page.locator('[data-slot="empty-state"][data-tone="console"]').evaluate((root) => {
    function luminance(color: string) {
      const canvas = document.createElement("canvas")
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext("2d", { willReadFrequently: true })
      if (!context) throw new Error("Canvas is unavailable for color contrast calculation")
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const channels = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]
      const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return red * 0.2126 + green * 0.7152 + blue * 0.0722
    }
    function contrast(foreground: string, background: string) {
      const light = Math.max(luminance(foreground), luminance(background))
      const dark = Math.min(luminance(foreground), luminance(background))
      return (light + 0.05) / (dark + 0.05)
    }

    const title = root.querySelector('[data-slot="empty-title"]')
    const description = root.querySelector('[data-slot="empty-description"]')
    const iconCircle = root.querySelector('[data-slot="empty-icon"]')
    const icon = iconCircle?.querySelector("svg")
    const consoleSurface = root.closest('[data-slot="scroll-area"]')
    if (!title || !description || !iconCircle || !icon || !consoleSurface) throw new Error("Console empty-state contrast targets are missing")

    const background = getComputedStyle(consoleSurface).backgroundColor
    const circleBackground = getComputedStyle(iconCircle).backgroundColor
    return {
      title: contrast(getComputedStyle(title).color, background),
      description: contrast(getComputedStyle(description).color, background),
      icon: contrast(getComputedStyle(icon).color, circleBackground),
    }
  })
}

test("empty states stay consistent across provider, key, request-log, and console-log surfaces", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let providers: ProviderSummary[] = []
  let firstProviderRequest = true
  let markProviderRequest!: () => void
  let releaseProviderRequest!: () => void
  const providerRequestReached = new Promise<void>(resolve => { markProviderRequest = resolve })
  const providerRequestGate = new Promise<void>(resolve => { releaseProviderRequest = resolve })
  await page.route("**/api/admin/providers", async route => {
    if (firstProviderRequest) {
      firstProviderRequest = false
      markProviderRequest()
      await providerRequestGate
    }
    await route.fulfill({ json: { providers } })
  })
  await page.route("**/api/admin/endpoint-key", route => route.fulfill({ json: { endpoint: "/v1", apiKeys: [] } }))

  await authenticate(page)
  await page.goto("/dashboard/ai/providers")
  await providerRequestReached
  await expect(page.locator('[data-slot="dashboard-content-skeleton"]')).toBeVisible()
  releaseProviderRequest()
  await expect(page.getByRole("heading", { name: "No providers yet" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Codex Providers are not configured yet" })).toBeVisible()
  await expect(page.locator('[data-slot="empty-state"][data-treatment="table"]')).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Add provider" })).toBeVisible()
  await expect(page.locator('[data-slot="empty-state"]').locator('[data-slot="card"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("providers-empty-state.png"), fullPage: true })

  providers = [{
    id: "e2e-provider",
    name: "Populated provider",
    prefix: "populated",
    baseUrl: "https://api.example.test/v1",
    protocol: "openai-chat",
    authType: "bearer",
    headers: {},
    enabled: true,
    createdAt: "2026-10-11T12:00:00.000Z",
    apiKeyCount: 0,
    enabledApiKeyCount: 0,
    modelCount: 0,
    enabledModelCount: 0,
  }]
  await page.reload()
  await expect(page.getByText("Populated provider", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="empty-state"][data-treatment="table"]')).toHaveCount(1)

  await page.goto("/dashboard/ai/endpoint")
  await expect(page.getByRole("heading", { name: "No gateway API keys" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Create key" })).toBeVisible()

  await page.goto("/dashboard/ai/overview/request-logs")
  await expect(page.getByRole("heading", { name: "Request logs are not available yet" })).toBeVisible()
  await expect(page.getByText("Request history for the selected workspace is not shown on this page.")).toBeVisible()

  let logEntries: LogSnapshot["entries"] = []
  let firstLogRequest = true
  let markLogRequest!: () => void
  let releaseLogRequest!: () => void
  const logRequestReached = new Promise<void>(resolve => { markLogRequest = resolve })
  const logRequestGate = new Promise<void>(resolve => { releaseLogRequest = resolve })
  await page.route("**/api/admin/logs", async route => {
    if (firstLogRequest) {
      firstLogRequest = false
      markLogRequest()
      await logRequestGate
    }
    await route.fulfill({ json: logSnapshot(logEntries) })
  })
  await page.goto("/dashboard/logs")
  await logRequestReached
  await expect(page.getByLabel("Loading log entries")).toBeVisible()
  releaseLogRequest()
  await expect(page.getByRole("heading", { name: "No matching logs" })).toBeVisible()
  const consoleEmptyState = page.locator('[data-slot="empty-state"][data-treatment="embedded"][data-tone="console"]')
  await expect(consoleEmptyState).toBeVisible()
  const contrastReadings: Array<{ theme: "light" | "dark"; title: number; description: number; icon: number }> = []
  for (const dark of [false, true]) {
    await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark)
    const contrast = await readConsoleEmptyStateContrast(page)
    contrastReadings.push({ theme: dark ? "dark" : "light", ...contrast })
    expect(contrast.description, `${dark ? "dark" : "light"} console description contrast`).toBeGreaterThanOrEqual(4.5)
    expect(contrast.title, `${dark ? "dark" : "light"} console title contrast`).toBeGreaterThanOrEqual(4.5)
    expect(contrast.icon, `${dark ? "dark" : "light"} console icon contrast`).toBeGreaterThanOrEqual(3)
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await testInfo.attach("console-empty-state-contrast.json", { body: Buffer.from(JSON.stringify(contrastReadings, null, 2)), contentType: "application/json" })

  logEntries = [{
    id: "empty-state-e2e-log",
    timestamp: "2026-10-11T12:00:00.000Z",
    level: "info",
    source: "e2e",
    event: "test.entry",
    message: "A populated log entry",
    origin: "server",
    scope: "workspace",
    workspaceId: "default",
    requestId: null,
    details: {},
  }]
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByText("A populated log entry")).toBeVisible()
  await expect(page.getByRole("heading", { name: "No matching logs" })).toHaveCount(0)
  await page.getByLabel("Search logs").fill("not in these logs")
  await expect(page.getByRole("heading", { name: "No matching logs" })).toBeVisible()
  await page.getByLabel("Search logs").fill("")
  await expect(page.getByText("A populated log entry")).toBeVisible()

  expect(errors).toEqual([])
})

test("public analytics use the shared state when no workspace is public", async ({ page }) => {
  await page.route("**/api/public/workspaces", route => route.fulfill({ json: { workspaces: [] } }))
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "No public workspaces are available" })).toBeVisible()
  await expect(page.locator('[data-slot="empty-state"][data-treatment="card"]')).toBeVisible()
})

test("routing, budgets, pricing, tools, and agent pages expose specific empty states in Chrome", async ({ page }) => {
  const noTargets = { aliases: [], combos: [], models: [], providers: [], sharedModels: [] }
  await page.route("**/api/admin/aliases", route => route.fulfill({ json: noTargets }))
  await page.route("**/api/admin/budgets", route => route.fulfill({ json: {
    budgets: [],
    bypassSessions: [],
    window: { start: "2026-10-05T00:00:00.000Z", end: "2026-10-12T00:00:00.000Z", anchor: "custom", bypassLimits: false, bypassAutoDeactivateAtWindowEnd: false },
    beyondLimits: { enabled: false, modelIds: [], updatedAt: "2026-10-11T12:00:00.000Z" },
    unlimited: { excludedModelIds: [], updatedAt: "2026-10-11T12:00:00.000Z" },
    modelOptions: [],
    apiKeys: [],
    codexAccounts: [],
  } }))
  await page.route("**/api/admin/model-pricing**", route => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: url.searchParams.has("catalog") ? { models: [] } : { groups: [], models: [], ungroupedModels: [], jobs: [] } })
  })
  await page.route("**/api/admin/tool-gateway/status", route => route.fulfill({ json: { state: "available" } }))

  await authenticate(page)
  await page.goto("/dashboard/ai/routing")
  await expect(page.getByRole("heading", { name: "No aliases yet." })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No combos yet." })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No models have been shared with this workspace." })).toBeVisible()
  await expect(page.locator('[data-slot="empty-state"][data-treatment="table"]')).toHaveCount(3)

  await page.getByRole("button", { name: "Add alias" }).click()
  await expect(page.getByRole("heading", { name: "No model targets available" })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Add combo" }).click()
  await expect(page.getByRole("heading", { name: "No eligible models or aliases" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No models in fallback order" })).toBeVisible()
  await page.keyboard.press("Escape")

  await page.goto("/dashboard/ai/budgets")
  await expect(page.getByRole("heading", { name: "No budgets configured" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No gateway keys available" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No enabled models available" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No Unlimited Mode sessions yet" })).toBeVisible()
  await page.getByRole("tab", { name: "Beyond Limits" }).click()
  await expect(page.getByRole("heading", { name: "No enabled models available" })).toHaveCount(1)

  await page.goto("/dashboard/ai/pricing")
  await expect(page.getByRole("heading", { name: "No model groups found" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No repricing history yet" })).toBeVisible()
  await page.getByRole("button", { name: "New custom group" }).click()
  await expect(page.getByRole("heading", { name: "No available models" })).toBeVisible()
  await page.getByRole("button", { name: /Select canonical model/ }).click()
  await expect(page.getByRole("heading", { name: "No canonical models available" })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Cancel" }).click()

  await page.goto("/dashboard/tools/catalog")
  await expect(page.getByRole("heading", { name: "No workspace-scoped data" })).toBeVisible()
  await page.goto("/dashboard/ai/coding-agents/opencode")
  await expect(page.getByRole("heading", { name: "Under construction" })).toBeVisible()
})

test("provider credential, model, and sharing empties preserve their meanings and actions", async ({ page }) => {
  const provider: ProviderSummary = {
    id: "e2e-empty-provider",
    name: "Credential-free provider",
    prefix: "e2e-empty-provider",
    baseUrl: "https://api.example.test/v1",
    protocol: "openai-chat",
    authType: "none",
    headers: {},
    enabled: true,
    createdAt: "2026-10-11T12:00:00.000Z",
    apiKeyCount: 0,
    enabledApiKeyCount: 0,
    modelCount: 0,
    enabledModelCount: 0,
  }
  let models: Model[] = []
  await page.route("**/api/admin/providers/e2e-empty-provider", route => route.fulfill({ json: { provider, apiKeys: [], models, discovery: undefined } }))
  await page.route("**/api/admin/model-shares**", route => route.fulfill({ json: { targets: [], shares: [] } }))
  await authenticate(page)
  await page.goto("/dashboard/ai/providers/e2e-empty-provider")
  await expect(page.getByRole("heading", { name: "No API keys required" })).toBeVisible()
  await expect(page.getByText("This provider does not require API keys.")).toBeVisible()
  await expect(page.getByRole("heading", { name: "No models yet" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add model" })).toBeVisible()

  models = [{ id: "e2e-empty-model", providerId: provider.id, gatewayModelId: "e2e/model", name: "Shareable model", upstreamModel: "upstream/model", enabled: true, createdAt: "2026-10-11T12:00:00.000Z" }]
  provider.modelCount = 1
  provider.enabledModelCount = 1
  await page.reload()
  await page.getByRole("button", { name: "Share", exact: true }).click()
  await expect(page.getByRole("heading", { name: "No other active workspaces" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save sharing" })).toBeVisible()
})
