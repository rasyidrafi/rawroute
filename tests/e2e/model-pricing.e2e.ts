import { expect, test } from "@playwright/test"

test("pricing dialogs preserve existing context rates and save edited drafts", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)

  await page.goto("/dashboard/model-pricing")
  await page.getByRole("button", { name: "New custom group" }).click()
  await page.getByLabel("Group name").fill("Pricing editor test")
  await page.getByRole("button", { name: "Save group", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()

  const initial = await (await page.request.get("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" } })).json()
  const group = initial.groups.find((entry: { name: string }) => entry.name === "Pricing editor test")
  expect(group).toBeDefined()
  const rates = { inputMicrosPerMillion: 2_500_000, outputMicrosPerMillion: 8_000_000, cacheReadMicrosPerMillion: 250_000, cacheCreationMicrosPerMillion: 3_000_000 }
  const tier = { id: "long-context", thresholdTokens: 32000, ...rates, inputMicrosPerMillion: 5_000_000 }
  expect((await page.request.post("/api/admin/model-pricing", { headers: { "x-rawroute-workspace-id": "default" },
    data: { action: "save-version", groupId: group.id, mode: "new", ...rates, contextTiers: [tier] },
  })).ok()).toBe(true)
  await page.reload()

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
})
