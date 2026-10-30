import { randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

test("gateway API keys can be rotated to a custom token without changing identity", async ({ page }) => {
  await authenticate(page)
  const keyName = `Rotation test ${randomUUID()}`
  const originalToken = `sk-e2e-rotation-old-${randomUUID()}`
  const replacementToken = `sk-e2e-rotation-new-${randomUUID()}`
  const endpointKeys = async () => {
    const response = await page.request.get("/api/admin/endpoint-key", { headers: { "x-rawroute-workspace-id": "default" } })
    return response.ok() ? (await response.json() as { apiKeys: Array<{ id: string; name: string; key: string }> }).apiKeys : []
  }

  try {
    await page.goto("/dashboard/ai/endpoint")
    await page.getByRole("button", { name: "Create key", exact: true }).click()
    const createDialog = page.getByRole("dialog")
    await createDialog.getByLabel("Key Name").fill(keyName)
    await createDialog.getByLabel("Key Value").fill(originalToken)
    await createDialog.getByRole("button", { name: "Create key", exact: true }).click()
    await expect(page.getByRole("heading", { name: "API key created" })).toBeVisible()
    await expect(page.getByText(originalToken, { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Done", exact: true }).click()

    const original = (await endpointKeys()).find(apiKey => apiKey.name === keyName)
    expect(original).toBeDefined()

    await page.getByRole("button", { name: `Rotate ${keyName}` }).click()
    const rotateDialog = page.getByRole("dialog")
    await expect(rotateDialog.getByText(/immediately disables its current token for new requests/)).toBeVisible()
    await rotateDialog.getByLabel("Replacement Key Value").fill(replacementToken)
    await rotateDialog.getByRole("button", { name: "Replace key", exact: true }).click()
    await expect(page.getByRole("heading", { name: "API key replaced" })).toBeVisible()
    await expect(page.getByText(replacementToken, { exact: true })).toBeVisible()
    await expect(page.getByText(/previous token no longer works for new requests/)).toBeVisible()
    await page.getByRole("button", { name: "Done", exact: true }).click()

    const rotated = (await endpointKeys()).find(apiKey => apiKey.name === keyName)
    expect(rotated).toMatchObject({ id: original!.id, name: keyName, key: replacementToken })

    const request = (token: string) => page.request.post("/v1/chat/completions", {
      headers: { authorization: `Bearer ${token}` },
      data: { model: "missing-test-model", messages: [{ role: "user", content: "test" }] },
    })
    expect((await request(originalToken)).status()).toBe(401)
    expect((await request(replacementToken)).status()).not.toBe(401)
  } finally {
    const created = (await endpointKeys()).find(apiKey => apiKey.name === keyName)
    if (created) await page.request.delete(`/api/admin/api-keys/${created.id}`, { headers: { "x-rawroute-workspace-id": "default" } })
  }
})
