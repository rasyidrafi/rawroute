import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", { data: { username: "admin", password: "change-me-now" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { username: "admin", password: "private-password" } })
  expect(login.ok()).toBe(true)
  const account = await page.request.get("/api/admin/account")
  if ((await account.json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
}

async function workspaceMenu(page: Page) {
  const trigger = page.getByRole("button", { name: /RawRoute/ }).first()
  await trigger.click()
  return trigger
}

test("creates, switches, isolates, renames, publishes, and deletes a workspace", async ({ page }) => {
  await authenticate(page)
  const existingResponse = await page.request.get("/api/admin/workspaces")
  const existing = ((await existingResponse.json()).workspaces as Array<{ id: string; name: string; isDefault: boolean }>).find((workspace) => workspace.name === "E2E Workspace")
  if (existing && !existing.isDefault) {
    await page.request.delete(`/api/admin/workspaces/${existing.id}`, { data: { confirmation: existing.name }, headers: { "x-rawroute-workspace-id": "default" } })
  }

  await page.goto("/dashboard")
  await workspaceMenu(page)
  await page.getByRole("menuitem", { name: "Add New Workspace" }).click()
  await page.getByRole("dialog").getByLabel("Workspace name").fill("E2E Workspace")
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click()
  await expect(page.getByText("E2E Workspace").first()).toBeVisible()
  await expect(page.getByText("No gateway API keys")).toBeVisible()

  const workspaceResponse = await page.request.get("/api/admin/workspaces")
  const workspace = ((await workspaceResponse.json()).workspaces as Array<{ id: string; name: string }>).find((entry) => entry.name === "E2E Workspace")
  expect(workspace).toBeTruthy()
  const workspaceId = workspace!.id

  const provider = {
    name: "Shared prefix provider",
    prefix: "workspace-shared",
    baseUrl: "https://example.com/v1",
    protocol: "openai-chat",
    authType: "none",
    headers: {},
  }
  expect((await page.request.post("/api/admin/providers", { data: { provider }, headers: { "x-rawroute-workspace-id": "default" } })).ok()).toBe(true)
  expect((await page.request.post("/api/admin/providers", { data: { provider }, headers: { "x-rawroute-workspace-id": workspaceId } })).ok()).toBe(true)
  expect((await page.request.post("/api/admin/api-keys", { data: { name: "E2E key", key: "sk-e2e-workspace" }, headers: { "x-rawroute-workspace-id": workspaceId } })).ok()).toBe(true)
  expect((await page.request.post("/api/admin/api-keys", { data: { name: "Conflict", key: "sk-e2e-workspace" }, headers: { "x-rawroute-workspace-id": "default" } })).status()).toBe(409)

  await page.reload()
  await expect(page.getByText("E2E Workspace").first()).toBeVisible()
  await expect(page.getByText("E2E key")).toBeVisible()

  await page.goto(`/?workspace=${encodeURIComponent(workspaceId)}`)
  await expect(page.getByText("Public gateway analytics")).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Workspace" })).toContainText("E2E Workspace")

  await page.goto("/dashboard")
  await workspaceMenu(page)
  await page.getByRole("menuitem", { name: "Rename Workspace" }).click()
  const renameDialog = page.getByRole("dialog")
  await renameDialog.getByLabel("Workspace name").fill("E2E Workspace Renamed")
  await renameDialog.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("E2E Workspace Renamed").first()).toBeVisible()

  await workspaceMenu(page)
  await page.getByRole("menuitem", { name: "Delete Workspace" }).click()
  const deleteDialog = page.getByRole("dialog")
  await deleteDialog.getByLabel("Type E2E Workspace Renamed").fill("E2E Workspace Renamed")
  await deleteDialog.getByRole("button", { name: "Delete permanently" }).click()
  await expect(page.getByText("Default").first()).toBeVisible()
  await expect.poll(async () => ((await (await page.request.get("/api/admin/workspaces")).json()).workspaces as Array<{ id: string }>).some((entry) => entry.id === workspaceId)).toBe(false)
  expect((await page.request.get("/api/admin/workspaces", { headers: { "x-rawroute-workspace-id": workspaceId } })).ok()).toBe(true)
})
