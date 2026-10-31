import { expect, test, type Page } from "@playwright/test"
import type { StorageDashboard, StorageAction, CapabilityStatus } from "../../packages/gateway-storage/src/contracts"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
}

async function enableStorage(page: Page) {
  await page.route("**/api/admin/storage/status", route => route.fulfill({ json: { state: "available" } }))
}

test("Storage management uses resource tables and retains connection checks, bucket probes, and client-key controls", async ({ page }) => {
  await authenticate(page)
  await enableStorage(page)
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
        for (const [action, status] of Object.entries(input.statuses as Record<StorageAction, CapabilityStatus>)) connection.capabilities[action as StorageAction] = { status, connectionRevision: connection.revision, checkedAt: new Date().toISOString(), source: "administrator" }
        connection.options = {
          ranges: { status: input.ranges as CapabilityStatus, connectionRevision: connection.revision, checkedAt: new Date().toISOString(), source: "administrator" },
          exactKeys: { status: input.exactKeys as CapabilityStatus, connectionRevision: connection.revision, checkedAt: new Date().toISOString(), source: "administrator" },
        }
        break
      }
      case "attach-bucket": data.buckets = [{ id: "bucket", workspaceId, connectionId: input.connectionId, name: input.name, upstreamBucket: input.upstreamBucket, state: "active" }]; break
      case "create-key": {
        const key = { id: "client", workspaceId, name: input.name, accessKeyId: "TESTACCESSKEYONLY", policy: { bucketIds: input.bucketIds, actions: input.actions } }
        data.keys = [key]; value = { key, secretAccessKey: "TEST-created-client-secret" }; break
      }
      case "revoke-key": data.keys[0]!.revokedAt = new Date().toISOString(); break
      case "update-key-policy": data.keys[0]!.policy = { bucketIds: input.bucketIds, actions: input.actions }; break
      case "probe-bucket": {
        const statuses = { HeadBucket: "supported", GetBucketLocation: "failed", ListObjectsV2: "supported" } as const
        const connection = data.connections[0]!
        for (const [action, status] of Object.entries(statuses)) connection.capabilities[action as StorageAction] = { status, connectionRevision: connection.revision, checkedAt: new Date().toISOString(), source: "probe" }
        value = statuses
        break
      }
      case "reveal-key": value = { accessKeyId: "TESTACCESSKEYONLY", secretAccessKey: "TEST-created-client-secret" }; break
      case "detach-bucket": detachRequests++; break
    }
    await route.fulfill({ json: { ok: true, value } })
  })

  await page.goto("/dashboard/storage/connections")
  await page.getByRole("button", { name: "Add connection" }).click()
  const connectionDialog = page.getByRole("dialog")
  await connectionDialog.getByLabel("Connection name").fill("Browser S3")
  await connectionDialog.getByLabel("Upstream S3 endpoint").fill("https://objects.example")
  await connectionDialog.getByLabel("Upstream access key ID").fill("TEST-upstream-id")
  await connectionDialog.getByLabel("Upstream secret access key").fill("TEST-upstream-secret")
  await connectionDialog.getByRole("button", { name: "Add connection", exact: true }).click()
  await expect(page.getByRole("row").filter({ hasText: "Browser S3" })).toBeVisible()

  await page.getByRole("button", { name: "Edit capability checks for Browser S3" }).click()
  const checksDialog = page.getByRole("dialog")
  await checksDialog.getByRole("checkbox", { name: /^GetObject —/ }).check()
  await checksDialog.getByRole("checkbox", { name: /^Single-range downloads —/ }).check()
  await checksDialog.getByRole("checkbox", { name: /^Exact object-key preservation —/ }).check()
  await checksDialog.getByRole("button", { name: "Save capability checks" }).click()
  await expect(page.getByText("Capability checks saved.")).toBeVisible()

  await page.getByRole("button", { name: "Edit Browser S3" }).click()
  const editDialog = page.getByRole("dialog")
  await editDialog.getByLabel("Connection name").fill("Browser S3")
  await editDialog.getByLabel("Upstream access key ID").fill("TEST-replacement-id")
  await editDialog.getByLabel("Upstream secret access key").fill("TEST-replacement-secret")
  await editDialog.getByRole("button", { name: "Save connection and clear checks" }).click()
  await page.getByRole("button", { name: "Edit capability checks for Browser S3" }).click()
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: /^GetObject — unknown/ })).not.toBeChecked()
  await page.getByRole("dialog").getByRole("button", { name: "Save capability checks" }).click()

  await page.getByRole("link", { name: "Buckets", exact: true }).click()
  await page.getByRole("button", { name: "Attach bucket" }).click()
  const bucketDialog = page.getByRole("dialog")
  await bucketDialog.getByRole("combobox").click()
  await page.getByRole("option", { name: "Browser S3" }).click()
  await bucketDialog.getByLabel("Gateway bucket name").fill("browser-logical-bucket")
  await bucketDialog.getByLabel("Existing upstream bucket name").fill("browser-upstream-bucket")
  await bucketDialog.getByRole("button", { name: "Attach bucket", exact: true }).click()
  await expect(page.getByRole("row").filter({ hasText: "browser-logical-bucket" })).toBeVisible()
  await page.getByRole("button", { name: "Check connection for browser-logical-bucket" }).click()
  await expect(page.getByText("Read-only checks for browser-logical-bucket complete: HeadBucket supported · GetBucketLocation failed · ListObjectsV2 supported.")).toBeVisible()
  const bucketRow = page.getByRole("row").filter({ hasText: "browser-logical-bucket" })
  await bucketRow.getByRole("button", { name: "Detach browser-logical-bucket?" }).click()
  await expect(page.getByText("This removes the gateway mapping but leaves remote objects untouched.")).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(detachRequests).toBe(0)

  await page.getByRole("link", { name: "Client keys", exact: true }).click()
  await page.getByRole("button", { name: "Create key" }).click()
  const keyDialog = page.getByRole("dialog")
  await keyDialog.getByLabel("Client key name").fill("Browser client")
  await keyDialog.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(keyDialog.getByRole("alert")).toContainText("Select at least one bucket.")
  await expect(page.locator('[data-slot="page-content"] > [data-slot="alert"]')).toHaveCount(0)
  await keyDialog.getByRole("checkbox", { name: "browser-logical-bucket", exact: true }).check()
  await keyDialog.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(keyDialog.getByRole("alert")).toContainText("Select at least one allowed action.")
  await keyDialog.getByRole("checkbox", { name: "GetObject", exact: true }).check()
  await keyDialog.getByRole("button", { name: "Create key", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Client credentials" })).toHaveValue(/TEST-created-client-secret/)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.getByRole("button", { name: "Copy credentials" }).click()
  await expect(page.getByText("Credentials copied")).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("TEST-created-client-secret")
  await page.getByRole("button", { name: "Hide credentials" }).click()
  await expect(page.getByRole("textbox", { name: "Client credentials" })).toHaveCount(0)
  await page.getByRole("button", { name: "Reveal" }).click()
  await expect(page.getByRole("textbox", { name: "Client credentials" })).toHaveValue(/TEST-created-client-secret/)
  await page.getByRole("button", { name: "Hide credentials" }).click()
  const keyRow = page.getByRole("row").filter({ hasText: "Browser client" })
  await keyRow.getByRole("button", { name: "Revoke Browser client?" }).click()
  await expect(page.getByText("Clients using this key will immediately lose access. This cannot be undone.")).toBeVisible()
  await page.getByRole("button", { name: "Revoke", exact: true }).last().click()
  await expect(keyRow.getByText("Revoked")).toBeVisible()
  await expect(keyRow.getByRole("button", { name: "Reveal" })).toBeDisabled()
  expect(workspaceHeaders.length).toBeGreaterThan(5)
})

test("Storage form server errors stay inside the dialog and preserve drafts without stale page alerts", async ({ page }) => {
  await authenticate(page)
  await enableStorage(page)
  await page.route("**/api/admin/storage", route => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, connections: [], buckets: [], keys: [], multiparts: [] } })
    : route.fulfill({ status: 400, json: { error: { message: "Invalid region or credentials." } } }))

  await page.goto("/dashboard/storage/connections")
  await page.getByRole("button", { name: "Add connection" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Connection name").fill("Draft S3 connection")
  await dialog.getByLabel("Upstream S3 endpoint").fill("https://objects.example")
  await dialog.getByLabel("Upstream region").fill("bad region")
  await dialog.getByLabel("Upstream access key ID").fill("TEST-upstream-id")
  await dialog.getByLabel("Upstream secret access key").fill("TEST-upstream-secret")
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("Invalid region or credentials.")
  await expect(dialog.getByLabel("Connection name")).toHaveValue("Draft S3 connection")
  await expect(dialog.getByLabel("Upstream region")).toHaveValue("bad region")
  await expect(page.locator('[data-slot="page-content"] > [data-slot="alert"]')).toHaveCount(0)

  await dialog.getByRole("button", { name: "Close" }).click()
  await page.getByRole("button", { name: "Add connection", exact: true }).first().click()
  const reopened = page.getByRole("dialog")
  await expect(reopened.getByRole("alert")).toHaveCount(0)
  await expect(reopened.getByLabel("Connection name")).toHaveValue("")
})

test("disabled Storage routes are not found or selectable and never load workspace data", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/storage/status", route => route.fulfill({ json: { state: "disabled" } }))
  let workspaceReads = 0
  await page.route("**/api/admin/storage", route => { workspaceReads++; return route.fulfill({ json: { enabled: false, connections: [], buckets: [], keys: [], multiparts: [] } }) })
  for (const path of ["overview", "connections", "buckets", "keys"]) {
    await page.goto(`/dashboard/storage/${path}`)
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible()
    await expect(page.getByText("Storage is not enabled", { exact: true })).toHaveCount(0)
  }
  expect(workspaceReads).toBe(0)

  await page.goto("/dashboard/ai/overview")
  await page.getByRole("button", { name: /RawRoute/ }).click()
  const storageApp = page.getByRole("menuitemradio", { name: /Storage Gateway/ })
  await expect(storageApp).toBeDisabled()
  await expect(storageApp).toContainText("Not configured")
})

test("Storage availability loading and errors gate direct routes with a retry", async ({ page }) => {
  await authenticate(page)
  let allowStorage = false
  let statusRequests = 0
  await page.route("**/api/admin/storage/status", async route => {
    statusRequests++
    if (!allowStorage) { await route.fulfill({ status: 503, json: { error: { message: "private deployment detail" } } }); return }
    await route.fulfill({ json: { state: "available" } })
  })
  let workspaceReads = 0
  await page.route("**/api/admin/storage", route => { workspaceReads++; return route.fulfill({ json: { enabled: true, connections: [], buckets: [], keys: [], multiparts: [] } }) })
  await page.goto("/dashboard/storage/connections")
  await expect(page.getByText("Storage availability could not be checked. Retry to try again.")).toBeVisible()
  await expect(page.getByText("private deployment detail")).toHaveCount(0)
  expect(workspaceReads).toBe(0)
  allowStorage = true
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Storage Gateway/Connections" })).toBeVisible()
  expect(statusRequests).toBeGreaterThanOrEqual(2)
  await expect.poll(() => workspaceReads).toBeGreaterThan(0)
})

test("Storage shows only loading UI while availability is checking and handles a disable race as not found", async ({ page }) => {
  await authenticate(page)
  const releaseStatuses: (() => void)[] = []
  let statusRequests = 0
  await page.route("**/api/admin/storage/status", async route => {
    statusRequests++
    await new Promise<void>(resolve => { releaseStatuses.push(resolve) })
    await route.fulfill({ json: { state: "available" } })
  })
  let workspaceReads = 0
  await page.route("**/api/admin/storage", route => { workspaceReads++; return route.fulfill({ json: { enabled: false, connections: [], buckets: [], keys: [], multiparts: [] } }) })
  await page.goto("/dashboard/storage/overview")
  await expect(page.locator('[data-variant="storage-overview"]')).toBeVisible()
  await expect(page.getByText("Storage is not enabled", { exact: true })).toHaveCount(0)
  expect(workspaceReads).toBe(0)
  await expect.poll(() => statusRequests).toBeGreaterThanOrEqual(2)
  for (const releaseStatus of releaseStatuses.splice(0)) releaseStatus()
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible()
  expect(workspaceReads).toBeGreaterThan(0)
})

test("Multipart recovery identifies the object and requires a deliberate resolution", async ({ page }) => {
  await authenticate(page)
  await enableStorage(page)
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
    if (input.action === "cleanup-multipart") { resolution = input; data.multiparts = [] }
    await route.fulfill({ json: { ok: true, value: undefined } })
  })
  await page.goto("/dashboard/storage/overview")
  await expect(page.getByRole("row").filter({ hasText: "Needs review" })).toBeVisible()
  await expect(page.getByText("nightly/2026-10-30.tar", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByText("upload-internal", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Review" }).click()
  const recoveryDialog = page.getByRole("dialog")
  await recoveryDialog.getByRole("button", { name: "Resolve and clean up" }).click()
  await expect(recoveryDialog.getByRole("alert")).toContainText("Enter the provider upload ID or confirm that no orphan upload remains.")
  await expect(page.locator('[data-slot="page-content"] > [data-slot="alert"]')).toHaveCount(0)
  await recoveryDialog.getByRole("checkbox", { name: "I checked upstream and confirm no orphan upload remains" }).check()
  await recoveryDialog.getByRole("button", { name: "Resolve and clean up" }).click()
  await expect(page.getByText("No pending uploads", { exact: true })).toBeVisible()
  expect(resolution).toMatchObject({ action: "cleanup-multipart", id: "upload-internal", confirmedAbsent: true })
})
