import { expect, test, type Page } from "@playwright/test"
import type { StorageDashboard, StorageAction, CapabilityStatus } from "../../packages/gateway-storage/src/contracts"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
}

test("Storage management creates connections, capability evidence, bucket policies and revokes keys", async ({ page }) => {
  await authenticate(page)
  const data: StorageDashboard = { enabled: true, connections: [], buckets: [], keys: [], multiparts: [] }
  const workspaceHeaders: string[] = []
  await page.route("**/api/admin/storage", async route => {
    const request = route.request()
    const workspaceId = request.headers()["x-rawroute-workspace-id"] || ""
    workspaceHeaders.push(workspaceId)
    expect(workspaceId).not.toBe("")
    if (request.method() === "GET") { await route.fulfill({ json: data }); return }
    const input = request.postDataJSON()
    let value: unknown
    switch (input.action) {
      case "save-connection": data.connections = [{ id: "connection", workspaceId, name: input.name, endpoint: input.endpoint, region: input.region, revision: 1, forcePathStyle: true, capabilities: {} }]; break
      case "capabilities": {
        const connection = data.connections[0]!
        for (const [action, status] of Object.entries(input.statuses as Record<StorageAction, CapabilityStatus>)) connection.capabilities[action as StorageAction] = { status, connectionRevision: 1, checkedAt: new Date().toISOString(), source: "administrator" }
        break
      }
      case "attach-bucket": data.buckets = [{ id: "bucket", workspaceId, connectionId: input.connectionId, name: input.name, upstreamBucket: input.upstreamBucket, state: "active" }]; break
      case "create-key": {
        const key = { id: "client", workspaceId, name: input.name, accessKeyId: "TESTACCESSKEYONLY", policy: { bucketIds: input.bucketIds, actions: input.actions } }
        data.keys = [key]; value = { key, secretAccessKey: "TEST-created-client-secret" }; break
      }
      case "revoke-key": data.keys[0]!.revokedAt = new Date().toISOString(); break
    }
    await route.fulfill({ json: { ok: true, value } })
  })
  await page.goto("/dashboard/storage/connections")
  await page.getByLabel("Connection name").fill("Browser S3")
  await page.getByLabel("Upstream S3 endpoint").fill("https://objects.example")
  await page.getByLabel("Upstream access key ID").fill("TEST-upstream-id")
  await page.getByLabel("Upstream secret access key").fill("TEST-upstream-secret")
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await expect(page.getByText("Browser S3", { exact: true }).first()).toBeVisible()
  await page.getByRole("checkbox", { name: /^GetObject —/ }).check()
  await page.getByRole("button", { name: "Save administrator capability declarations" }).click()
  await expect(page.getByRole("checkbox", { name: /^GetObject — supported/ })).toBeChecked()
  await page.getByRole("link", { name: "Buckets", exact: true }).click()
  await page.getByRole("combobox").click()
  await page.getByRole("option", { name: "Browser S3" }).click()
  await page.getByLabel("Globally unique logical bucket name").fill("browser-logical-bucket")
  await page.getByLabel("Existing upstream bucket name").fill("browser-upstream-bucket")
  await page.getByRole("button", { name: "Attach bucket", exact: true }).click()
  await expect(page.locator('[data-slot="card-title"]').filter({ hasText: "browser-logical-bucket" })).toBeVisible()
  await page.getByRole("link", { name: "Client keys", exact: true }).click()
  await page.getByLabel("Client key name").fill("Browser client")
  await page.getByRole("checkbox", { name: "browser-logical-bucket", exact: true }).check()
  await page.getByRole("checkbox", { name: "GetObject", exact: true }).check()
  await page.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(page.getByLabel("Client credentials")).toHaveValue(/TEST-created-client-secret/)
  await page.getByRole("button", { name: "Hide credentials" }).click()
  await expect(page.getByLabel("Client credentials")).toHaveCount(0)
  await page.getByRole("button", { name: "Revoke key", exact: true }).click()
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Reveal credentials" })).toBeDisabled()
  expect(workspaceHeaders.length).toBeGreaterThan(5)
})

test("Storage setup and recovery views fit mobile and show configuration errors safely", async ({ page }) => {
  await authenticate(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/dashboard/storage/overview")
  await expect(page.getByText("Storage is optional", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.route("**/api/admin/storage", route => route.fulfill({ status: 503, json: { error: { message: "Storage unavailable" } } }))
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Storage configuration could not be loaded. Check the deployment configuration and retry.")).toBeVisible()
})
