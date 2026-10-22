import { expect, test } from "@playwright/test"

test("any model can configure tier pricing without capability settings or a catalog and persist multiplier and custom rates", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  const headers = { "x-rawroute-workspace-id": "default" }
  const providerResponse = await page.request.post("/api/admin/providers", { headers, data: { provider: { prefix: "tier-e2e", name: "Tier E2E", baseUrl: "http://127.0.0.1:3211", protocol: "openai-responses", authType: "none" } } })
  expect(providerResponse.ok()).toBe(true)
  const { providerId } = await providerResponse.json()
  try {
    expect((await page.request.post(`/api/admin/providers/${providerId}/models`, { headers, data: { model: { gatewayModelId: "tier-e2e/tier-test", name: "Tier model E2E", upstreamModel: "tier-test" } } })).ok()).toBe(true)
    await page.goto("/dashboard/ai/pricing")
    const row = page.getByRole("row").filter({ hasText: "Tier model E2E" })
    await row.getByRole("button", { name: "Pricing", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Pricing for Tier model E2E", exact: true })
    await expect(dialog.getByText("Service tier pricing", { exact: true })).toBeVisible()
    await dialog.getByRole("spinbutton", { name: /^Input/ }).fill("2")
    await dialog.getByRole("spinbutton", { name: /^Output/ }).fill("10")
    const fast = dialog.getByRole("region", { name: "Fast (OpenAI) pricing", exact: true })
    await expect(fast.getByText(/Not configured/)).toBeVisible()
    await fast.getByRole("button", { name: "Configure rates", exact: true }).click()
    await fast.getByRole("spinbutton", { name: "Fast (OpenAI) multiplier", exact: true }).fill("2")
    const ultra = dialog.getByRole("region", { name: "Ultrafast pricing", exact: true })
    await ultra.getByRole("button", { name: "Configure rates", exact: true }).click()
    await ultra.getByRole("combobox").click()
    await page.getByRole("option", { name: "Custom rates per token component", exact: true }).click()
    await ultra.getByRole("spinbutton", { name: "Ultrafast Input", exact: true }).fill("12")
    await ultra.getByRole("spinbutton", { name: "Ultrafast Output", exact: true }).fill("60")
    await dialog.getByRole("button", { name: "Save as new version", exact: true }).click()
    await expect(dialog).toBeHidden()
    const data = await (await page.request.get("/api/admin/model-pricing", { headers })).json()
    const group = data.groups.find((entry: { name: string }) => entry.name === "Tier model E2E")
    expect(group.canonicalModelId).toBeUndefined()
    expect(group.currentVersion.serviceTiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ serviceTier: "priority", multiplier: 2, source: "custom", inputMicrosPerMillion: 4_000_000, outputMicrosPerMillion: 20_000_000 }),
      expect.objectContaining({ serviceTier: "ultrafast", source: "custom", inputMicrosPerMillion: 12_000_000, outputMicrosPerMillion: 60_000_000 }),
    ]))
    await page.reload()
    await row.getByRole("button", { name: "Pricing", exact: true }).click()
    await expect(fast.getByRole("spinbutton", { name: "Fast (OpenAI) multiplier", exact: true })).toHaveValue("2")
    await expect(ultra.getByRole("spinbutton", { name: "Ultrafast Output", exact: true })).toHaveValue("60")
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(fast.getByRole("spinbutton")).toBeVisible()
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  } finally {
    expect((await page.request.delete(`/api/admin/providers/${providerId}`, { headers })).ok()).toBe(true)
  }
})
