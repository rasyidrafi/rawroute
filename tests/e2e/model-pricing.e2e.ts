import { expect, test, type Page } from "@playwright/test"

async function blockPricingRefresh(page: Page) {
  let release = () => {}
  let reached = () => {}
  let finish = () => {}
  let blocked = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { reached = resolve })
  const finished = new Promise<void>(resolve => { finish = resolve })
  await page.route("**/api/admin/model-pricing", async route => {
    if (route.request().method() !== "GET" || blocked) { await route.continue(); return }
    blocked = true
    reached()
    await gate
    await route.continue()
    finish()
  })
  return { requested, release, finished }
}

test("pricing dialogs preserve existing context rates and save edited drafts", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)

  const isGroupSync = (response: import("@playwright/test").Response) => response.url().endsWith("/api/admin/model-pricing") && response.request().method() === "POST" && response.request().postDataJSON()?.action === "sync"
  const firstSync = page.waitForResponse(isGroupSync)
  await page.goto("/dashboard/ai/pricing")
  expect((await firstSync).ok()).toBe(true)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "New custom group" }).click()
  await page.getByLabel("Group name").fill("Pricing editor test")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()

  const initial = await (await page.request.get("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" } })).json()
  const group = initial.groups.find((entry: { name: string }) => entry.name === "Pricing editor test")
  expect(group).toBeDefined()
  const rates = { inputMicrosPerMillion: 2_500_000, outputMicrosPerMillion: 8_000_000, cacheReadMicrosPerMillion: 250_000, cacheCreationMicrosPerMillion: 3_000_000 }
  const tier = { id: "long-context", thresholdTokens: 32000, ...rates, inputMicrosPerMillion: 5_000_000 }
  expect((await page.request.post("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" },
    data: { action: "save-version", groupId: group.id, mode: "new", ...rates, contextTiers: [tier] },
  })).ok()).toBe(true)
  const reopenSync = page.waitForResponse(isGroupSync)
  await page.reload()
  expect((await reopenSync).ok()).toBe(true)

  const row = page.getByRole("row").filter({ hasText: "Pricing editor test" })
  await row.getByRole("button", { name: "Pricing", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Pricing for Pricing editor test" })
  const inputRates = dialog.getByRole("spinbutton", { name: /^Input/ })
  const outputRates = dialog.getByRole("spinbutton", { name: /^Output/ })
  await expect(inputRates.nth(0)).toHaveValue("2.5")
  await expect(inputRates.nth(1)).toHaveValue("5")
  await expect(outputRates.nth(1)).toHaveValue("8")

  await inputRates.nth(0).fill("99")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
  await row.getByRole("button", { name: "Pricing", exact: true }).click()
  await expect(inputRates.nth(0)).toHaveValue("2.5")

  await inputRates.nth(0).fill("2.75")
  await outputRates.nth(1).fill("9")
  await dialog.getByRole("button", { name: "Save as new version" }).click()
  await expect(dialog).toBeHidden()
  const saved = await (await page.request.get("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" } })).json()
  expect(saved.groups.find((entry: { id: string }) => entry.id === group.id).currentVersion).toMatchObject({
    ...rates,
    inputMicrosPerMillion: 2_750_000,
    contextTiers: [{ ...tier, outputMicrosPerMillion: 9_000_000 }],
  })

  await row.getByRole("button", { name: "Pricing", exact: true }).click()
  await dialog.getByRole("button", { name: "Replace current version", exact: true }).click()
  const replacement = page.getByRole("dialog", { name: "Reprice historical usage?" })
  const pricingRefresh = await blockPricingRefresh(page)
  try {
    await replacement.getByRole("button", { name: "Replace and reprice", exact: true }).click()
    await pricingRefresh.requested
    await expect(replacement).toBeHidden()
    await expect(dialog).toBeHidden()
  } finally { pricingRefresh.release() }
  await pricingRefresh.finished
  await page.unroute("**/api/admin/model-pricing")

  const canonical = { id: "test/canonical", name: "Canonical tier test", provider: "test", family: null, source: "models.dev", contextLimit: 1000000, pricing: rates, contextTiers: [tier] }
  await page.route("**/api/admin/model-pricing?*", async route => {
    if (new URL(route.request().url()).searchParams.has("catalog")) await route.fulfill({ json: { models: [canonical] } })
    else await route.continue()
  })
  await row.getByRole("button", { name: "Models", exact: true }).click()
  await page.getByRole("button", { name: /Select canonical model/ }).click()
  await page.getByRole("option", { name: /Canonical tier test/ }).click()
  await expect(page.getByText("From 32,000 input tokens")).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Edit Pricing editor test", exact: true })).toBeHidden()
  const imported = await (await page.request.get("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" } })).json()
  expect(imported.groups.find((entry: { id: string }) => entry.id === group.id).currentVersion).toMatchObject({ ...rates, contextTiers: [tier] })
  expect(imported.jobs).toHaveLength(1)

  const canonicalRow = page.getByRole("row").filter({ hasText: "Canonical tier test" })
  await canonicalRow.getByRole("button", { name: "Models", exact: true }).click()
  // Catalog lookup on reload may be unavailable for this test-only canonical ID;
  // reselect it to exercise the same canonical import path.
  await page.getByRole("button", { name: /test\/canonical/ }).click()
  await page.getByRole("option", { name: /Canonical tier test/ }).click()
  await page.getByRole("button", { name: "Save and reprice", exact: true }).click()
  const confirmation = page.getByRole("dialog", { name: "Reprice historical usage?" })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(confirmation).toBeHidden()
  await expect(page.getByRole("dialog", { name: /Edit Canonical tier test/ })).toBeVisible()
  await page.getByRole("dialog", { name: "Edit Canonical tier test", exact: true }).getByRole("button", { name: "Save and reprice", exact: true }).click()
  const groupRefresh = await blockPricingRefresh(page)
  try {
    await confirmation.getByRole("button", { name: "Save and reprice", exact: true }).click()
    await groupRefresh.requested
    await expect(confirmation).toBeHidden()
    await expect(page.getByRole("dialog", { name: "Edit Canonical tier test", exact: true })).toBeHidden()
  } finally { groupRefresh.release() }
  await groupRefresh.finished
  await page.unroute("**/api/admin/model-pricing")
  const repriced = await (await page.request.get("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" } })).json()
  expect(repriced.jobs.some((job: { groupId: string }) => job.groupId === group.id)).toBe(true)
})
