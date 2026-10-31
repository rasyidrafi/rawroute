import { expect, test, type Page } from "@playwright/test"

const workspaceHeaders = { "x-rawroute-workspace-id": "default" }

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  const account = await page.request.get("/api/admin/account")
  expect(account.ok()).toBe(true)
  if ((await account.json()).mustChangePassword) {
    const changed = await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })
    expect(changed.ok()).toBe(true)
  }
}

async function providerApiKeys(page: Page, providerId: string) {
  const response = await page.request.get(`/api/admin/providers/${providerId}`, { headers: workspaceHeaders })
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()).apiKeys as Array<{ id: string; name: string; key: string; rpmLimit?: number; maxConcurrency?: number }>
}

test("provider API key limits are optional local settings and can be preserved or cleared", async ({ page }) => {
  await authenticate(page)
  const prefix = `limit-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const providerResponse = await page.request.post("/api/admin/providers", {
    headers: workspaceHeaders,
    data: { provider: { name: "Local limit E2E", prefix, baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "bearer", headers: {} } },
  })
  expect(providerResponse.ok(), await providerResponse.text()).toBe(true)
  const { providerId } = await providerResponse.json() as { providerId: string }

  try {
    const legacyResponse = await page.request.post(`/api/admin/providers/${providerId}/api-keys`, {
      headers: workspaceHeaders,
      data: { providerApiKey: { name: "Legacy limits", key: "legacy-limit-e2e-secret", rpmLimit: 60, maxConcurrency: 4 } },
    })
    expect(legacyResponse.ok(), await legacyResponse.text()).toBe(true)

    await page.goto(`/dashboard/ai/providers/${providerId}`)
    await expect(page.getByRole("columnheader", { name: "Local limits" })).toBeVisible()
    await expect(page.getByText("Sessions reuse an available key; other requests favor current load. Key order breaks ties.")).toBeVisible()

    await page.getByRole("button", { name: "Add API key", exact: true }).click()
    let dialog = page.getByRole("dialog")
    const rpmInput = dialog.locator('input[name="rpmLimit"]')
    const concurrencyInput = dialog.locator('input[name="maxConcurrency"]')
    await expect(rpmInput).toHaveValue("")
    await expect(concurrencyInput).toHaveValue("")
    await expect(dialog.getByText("Limits and session affinity are local to this RawRoute process; RPM counts and session routing reset on restart.")).toBeVisible()
    await dialog.locator('input[name="name"]').fill("No local limits")
    await dialog.locator('input[name="key"]').fill("no-limit-e2e-secret")
    await dialog.getByRole("button", { name: "Add API key", exact: true }).click()
    await expect(dialog).toBeHidden()

    let keys = await providerApiKeys(page, providerId)
    const noLimits = keys.find((key) => key.name === "No local limits")!
    expect(noLimits).not.toHaveProperty("rpmLimit")
    expect(noLimits).not.toHaveProperty("maxConcurrency")
    expect(noLimits.key).toBe("__unchanged__")

    await page.getByRole("button", { name: "Edit Legacy limits" }).click()
    dialog = page.getByRole("dialog")
    await expect(dialog.locator('input[name="rpmLimit"]')).toHaveValue("60")
    await expect(dialog.locator('input[name="maxConcurrency"]')).toHaveValue("4")
    await dialog.locator('input[name="name"]').fill("Preserved limits")
    await dialog.getByRole("button", { name: "Update API key", exact: true }).click()
    await expect(dialog).toBeHidden()

    keys = await providerApiKeys(page, providerId)
    const preserved = keys.find((key) => key.name === "Preserved limits")!
    expect(preserved).toMatchObject({ rpmLimit: 60, maxConcurrency: 4, key: "__unchanged__" })

    await page.getByRole("button", { name: "Edit Preserved limits" }).click()
    dialog = page.getByRole("dialog")
    await dialog.locator('input[name="rpmLimit"]').fill("")
    await dialog.locator('input[name="maxConcurrency"]').fill("")
    await dialog.getByRole("button", { name: "Update API key", exact: true }).click()
    await expect(dialog).toBeHidden()

    keys = await providerApiKeys(page, providerId)
    const cleared = keys.find((key) => key.name === "Preserved limits")!
    expect(cleared).not.toHaveProperty("rpmLimit")
    expect(cleared).not.toHaveProperty("maxConcurrency")
    expect(cleared.key).toBe("__unchanged__")
  } finally {
    const removed = await page.request.delete(`/api/admin/providers/${providerId}`, { headers: workspaceHeaders })
    expect(removed.ok(), await removed.text()).toBe(true)
  }
})
