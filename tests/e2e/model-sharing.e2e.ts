import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

test("sharing can follow the owner's Unlimited Mode without removing recipient configuration", async ({ page }) => {
  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
  const names = [`Sharing owner ${randomUUID()}`, `Sharing recipient ${randomUUID()}`]
  const workspaces: Array<{ id: string; name: string }> = []
  try {
    for (const name of names) {
      const response = await page.request.post("/api/admin/workspaces", { data: { name } })
      expect(response.ok()).toBe(true)
      workspaces.push((await response.json()).workspace)
    }
    const [owner, recipient] = workspaces
    const headers = { "x-rawroute-workspace-id": owner.id }
    const created = await page.request.post("/api/admin/providers", { headers, data: { provider: { name: "Share test", prefix: "share-test", baseUrl: "https://example.test/v1", protocol: "openai-responses", authType: "none", enabled: true } } })
    expect(created.ok()).toBe(true)
    const { providerId } = await created.json()
    expect((await page.request.post(`/api/admin/providers/${providerId}/models`, { headers, data: { model: { name: "Shared test model", gatewayModelId: "share-test/model", upstreamModel: "model", enabled: true } } })).ok()).toBe(true)
    await page.goto("/dashboard/ai/providers")
    await page.evaluate(id => localStorage.setItem("rawroute_workspace", id), owner.id)
    await page.goto(`/dashboard/ai/providers/${providerId}`)
    const modelRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Shared test model", exact: true }) })
    await modelRow.getByRole("button", { name: "Share", exact: true }).click()
    const dialog = page.getByRole("dialog")
    const recipientCheckbox = dialog.getByRole("checkbox", { name: recipient.name, exact: true })
    await expect(recipientCheckbox).not.toBeChecked()
    await recipientCheckbox.click()
    const conditional = dialog.getByRole("switch", { name: `Only during Unlimited Mode for ${recipient.name}`, exact: true })
    await expect(conditional).not.toBeChecked()
    await conditional.click()
    await dialog.getByRole("button", { name: "Save sharing", exact: true }).click()
    await expect(dialog).toBeHidden()
    await modelRow.getByRole("button", { name: "Manage Share", exact: true }).click()
    await expect(conditional).toBeChecked()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()

    await page.evaluate(id => localStorage.setItem("rawroute_workspace", id), recipient.id)
    await page.goto("/dashboard/ai/routing")
    const sharedRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: owner.name, exact: true }) })
    await expect(sharedRow).toContainText("Waiting for Unlimited Mode")
    await sharedRow.getByRole("button", { name: "Create combo", exact: true }).click()
    await page.getByRole("dialog").locator('input[name="combo"]').fill("shared-test")
    await page.getByRole("dialog").getByRole("button", { name: "Add combo", exact: true }).click()
    await expect(page.getByRole("dialog")).toBeHidden()
    expect((await page.request.patch("/api/admin/budgets/bypass", { headers: { "x-rawroute-workspace-id": recipient.id }, data: { enabled: true } })).ok()).toBe(true)
    await page.reload()
    await expect(sharedRow).toContainText("Waiting for Unlimited Mode")
    expect((await page.request.patch("/api/admin/budgets/bypass", { headers, data: { enabled: true } })).ok()).toBe(true)
    await page.reload()
    await expect(sharedRow).toContainText("Available")
    expect((await page.request.patch("/api/admin/budgets/bypass", { headers, data: { enabled: false } })).ok()).toBe(true)
    await page.reload()
    await expect(sharedRow).toContainText("Waiting for Unlimited Mode")
    await expect(page.getByRole("button", { name: "Edit Shared test model", exact: true })).toBeVisible()

    await page.evaluate(id => localStorage.setItem("rawroute_workspace", id), owner.id)
    await page.goto(`/dashboard/ai/providers/${providerId}`)
    await modelRow.getByRole("button", { name: "Manage Share", exact: true }).click()
    await expect(recipientCheckbox).toBeChecked()
    await expect(conditional).toBeChecked()
    await conditional.click()
    await dialog.getByRole("button", { name: "Save sharing", exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.evaluate(id => localStorage.setItem("rawroute_workspace", id), recipient.id)
    await page.goto("/dashboard/ai/routing")
    await expect(sharedRow).toContainText("Available")
  } finally {
    for (const workspace of [...workspaces].reverse()) {
      expect((await page.request.delete(`/api/admin/workspaces/${workspace.id}`, { data: { confirmation: workspace.name } })).ok()).toBe(true)
    }
  }
})
