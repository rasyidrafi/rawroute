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
  let detachRequests = 0
  await page.route("**/api/admin/storage", async route => {
    const request = route.request()
    const workspaceId = request.headers()["x-rawroute-workspace-id"] || ""
    workspaceHeaders.push(workspaceId)
    expect(workspaceId).not.toBe("")
    if (request.method() === "GET") { await route.fulfill({ json: data }); return }
    const input = request.postDataJSON()
    let value: unknown
    switch (input.action) {
      case "save-connection": {
        const previous = data.connections.find(connection => connection.id === input.id)
        data.connections = [{ id: "connection", workspaceId, name: input.name, endpoint: input.endpoint, region: input.region, revision: (previous?.revision || 0) + 1, forcePathStyle: true, capabilities: {} }]
        break
      }
      case "capabilities": {
        const connection = data.connections[0]!
        for (const [action, status] of Object.entries(input.statuses as Record<StorageAction, CapabilityStatus>)) connection.capabilities[action as StorageAction] = { status, connectionRevision: 1, checkedAt: new Date().toISOString(), source: "administrator" }
        connection.options = {
          ranges: { status: input.ranges as CapabilityStatus, connectionRevision: 1, checkedAt: new Date().toISOString(), source: "administrator" },
          exactKeys: { status: input.exactKeys as CapabilityStatus, connectionRevision: 1, checkedAt: new Date().toISOString(), source: "administrator" },
        }
        break
      }
      case "attach-bucket": data.buckets = [{ id: "bucket", workspaceId, connectionId: input.connectionId, name: input.name, upstreamBucket: input.upstreamBucket, state: "active" }]; break
      case "create-key": {
        const key = { id: "client", workspaceId, name: input.name, accessKeyId: "TESTACCESSKEYONLY", policy: { bucketIds: input.bucketIds, actions: input.actions } }
        data.keys = [key]; value = { key, secretAccessKey: "TEST-created-client-secret" }; break
      }
      case "revoke-key": data.keys[0]!.revokedAt = new Date().toISOString(); break
      case "probe-bucket": {
        const statuses = { HeadBucket: "supported", GetBucketLocation: "failed", ListObjectsV2: "supported" } as const
        const connection = data.connections[0]!
        for (const [action, status] of Object.entries(statuses)) connection.capabilities[action as StorageAction] = { status, connectionRevision: 1, checkedAt: new Date().toISOString(), source: "probe" }
        value = statuses
        break
      }
      case "reveal-key": value = { accessKeyId: "TESTACCESSKEYONLY", secretAccessKey: "TEST-created-client-secret" }; break
      case "detach-bucket": detachRequests++; break
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
  const editConnection = page.locator("details").filter({ hasText: "Edit connection and replace credentials" })
  await editConnection.locator("summary").click()
  await editConnection.getByLabel("Connection name").fill("Draft connection name")
  await page.getByRole("checkbox", { name: /^GetObject —/ }).check()
  await page.getByRole("checkbox", { name: /^Single-range downloads —/ }).check()
  await page.getByRole("checkbox", { name: /^Exact object-key preservation —/ }).check()
  await page.getByRole("button", { name: "Save capability checks" }).click()
  await expect(page.getByRole("checkbox", { name: /^GetObject — supported/ })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: /^Single-range downloads — supported/ })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: /^Exact object-key preservation — supported/ })).toBeChecked()
  await expect(editConnection.getByLabel("Connection name")).toHaveValue("Draft connection name")
  await editConnection.getByLabel("Connection name").fill("Browser S3")
  await editConnection.getByLabel("Upstream access key ID").fill("TEST-replacement-id")
  await editConnection.getByLabel("Upstream secret access key").fill("TEST-replacement-secret")
  await editConnection.getByRole("button", { name: "Save connection and clear checks" }).click()
  await expect(page.getByRole("checkbox", { name: /^GetObject — unknown/ })).not.toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Single-range downloads — unknown" })).not.toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Exact object-key preservation — unknown" })).not.toBeChecked()
  await page.getByRole("link", { name: "Buckets", exact: true }).click()
  await page.getByRole("combobox").click()
  await page.getByRole("option", { name: "Browser S3" }).click()
  await page.getByLabel("Gateway bucket name").fill("browser-logical-bucket")
  await page.getByLabel("Existing upstream bucket name").fill("browser-upstream-bucket")
  await page.getByRole("button", { name: "Attach bucket", exact: true }).click()
  await expect(page.locator('[data-slot="card-title"]').filter({ hasText: "browser-logical-bucket" })).toBeVisible()
  await page.getByRole("button", { name: "Check connection" }).click()
  await expect(page.getByText("Read-only checks for browser-logical-bucket complete: HeadBucket supported · GetBucketLocation failed · ListObjectsV2 supported.")).toBeVisible()
  await page.getByRole("button", { name: "Detach browser-logical-bucket?" }).click()
  await expect(page.getByText("This removes the gateway mapping but leaves remote objects untouched.")).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(detachRequests).toBe(0)
  await page.getByRole("link", { name: "Client keys", exact: true }).click()
  await page.getByLabel("Client key name").fill("Browser client")
  await page.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(page.getByText("Select at least one bucket.")).toBeVisible()
  await page.getByRole("checkbox", { name: "browser-logical-bucket", exact: true }).check()
  await page.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(page.getByText("Select at least one allowed action.")).toBeVisible()
  await page.getByRole("checkbox", { name: "GetObject", exact: true }).check()
  await page.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(page.getByLabel("Client credentials")).toHaveValue(/TEST-created-client-secret/)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.getByRole("button", { name: "Copy credentials" }).click()
  await expect(page.getByText("Credentials copied")).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("TEST-created-client-secret")
  await page.getByRole("button", { name: "Hide credentials" }).click()
  await expect(page.getByLabel("Client credentials")).toHaveCount(0)
  await page.getByRole("button", { name: "Reveal credentials" }).click()
  await expect(page.getByLabel("Client credentials")).toHaveValue(/TEST-created-client-secret/)
  await page.getByRole("button", { name: "Hide credentials" }).click()
  await page.getByRole("button", { name: "Revoke Browser client?" }).click()
  await expect(page.getByText("Clients using this key will immediately lose access. This cannot be undone.")).toBeVisible()
  await page.getByRole("button", { name: "Revoke key", exact: true }).click()
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Reveal credentials" })).toBeDisabled()
  expect(workspaceHeaders.length).toBeGreaterThan(5)
})

test("Storage setup and recovery views fit mobile and show configuration errors safely", async ({ page }) => {
  await authenticate(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/dashboard/storage/overview")
  await expect(page.getByText("Storage is not enabled", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.route("**/api/admin/storage", route => route.fulfill({ status: 503, json: { error: { message: "Storage unavailable" } } }))
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Storage configuration could not be loaded. Check the deployment configuration and retry.")).toBeVisible()
})

test("Disabled Storage pages retain their own purpose", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/storage", route => route.fulfill({ json: { enabled: false, connections: [], buckets: [], keys: [], multiparts: [] } }))
  for (const [path, title] of [["connections", "Connections"], ["buckets", "Buckets"], ["keys", "Client keys"]]) {
    await page.goto(`/dashboard/storage/${path}`)
    await expect(page.locator('[data-slot="card-title"]').filter({ hasText: title }).first()).toBeVisible()
    await expect(page.getByText("Storage is not enabled", { exact: true })).toBeVisible()
  }
})

test("Multipart recovery identifies the affected object and requires a deliberate resolution", async ({ page }) => {
  await authenticate(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const data: StorageDashboard = {
    enabled: true,
    connections: [{ id: "connection-internal", workspaceId: "workspace", name: "Archive service", revision: 1, endpoint: "https://objects.example", region: "us-east-1", forcePathStyle: true, capabilities: {} }],
    buckets: [{ id: "bucket-internal", workspaceId: "workspace", connectionId: "connection-internal", name: "archive", upstreamBucket: "archive-origin", state: "active" }],
    keys: [{ id: "key-internal", workspaceId: "workspace", name: "Nightly backup", accessKeyId: "TESTACCESSKEYONLY", policy: { bucketIds: ["bucket-internal"], actions: ["PutObject"] } }],
    multiparts: [{ id: "upload-internal", workspaceId: "workspace", bucketId: "bucket-internal", connectionId: "connection-internal", keyId: "key-internal", key: "nightly/2026-10-30.tar", state: "ambiguous", createdAt: "2026-10-30T10:00:00.000Z" }],
  }
  let resolution: Record<string, unknown> | undefined
  await page.route("**/api/admin/storage", async route => {
    if (route.request().method() === "GET") { await route.fulfill({ json: data }); return }
    const input = route.request().postDataJSON()
    if (input.action === "cleanup-multipart") {
      resolution = input
      data.multiparts = []
    }
    await route.fulfill({ json: { ok: true, value: undefined } })
  })
  await page.goto("/dashboard/storage/overview")
  await expect(page.getByText("archive · Needs review", { exact: true })).toBeVisible()
  await expect(page.getByText("Archive service · client key: Nightly backup")).toBeVisible()
  await expect(page.getByText("archive-origin", { exact: true })).toBeVisible()
  await expect(page.getByText("nightly/2026-10-30.tar", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByText("upload-internal", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Resolve and clean up" }).click()
  await expect(page.getByText("Enter the provider upload ID or confirm that no orphan upload remains.")).toBeVisible()
  await page.getByRole("checkbox", { name: "I checked upstream and confirm no orphan upload remains" }).check()
  await page.getByRole("button", { name: "Resolve and clean up" }).click()
  await expect(page.getByText("No pending uploads", { exact: true })).toBeVisible()
  expect(resolution).toMatchObject({ action: "cleanup-multipart", id: "upload-internal", confirmedAbsent: true })
})
