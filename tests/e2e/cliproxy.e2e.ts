import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
}

test("global CLIProxy controls work without a workspace and preserve the transport key", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/workspaces", route => route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } }))
  await page.goto("/dashboard/cliproxy")
  await expect(page.getByText("External instance", { exact: true })).toBeVisible()
  await expect(page.getByText("RawRoute transport", { exact: true })).toBeVisible()
  await page.getByLabel("New CLIProxy key").fill("browser-created-private-key")
  const saved = page.waitForResponse(response => response.url().endsWith("/api/admin/cliproxy/api-keys") && response.request().method() === "PUT")
  await page.getByRole("button", { name: "Add key", exact: true }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  expect(response.request().headers()["x-rawroute-workspace-id"]).toBeUndefined()
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(1)
  await page.getByRole("button", { name: "Revoke", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click()
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0)
  await expect(page.getByLabel("CLIProxy log entries")).not.toContainText("fixture-secret")
  await expect(page.getByLabel("CLIProxy log entries")).toContainText("REDACTED")
})

test("global Codex OAuth can complete and workspace-owned auth files are protected", async ({ page }) => {
  await authenticate(page)
  const headers = { origin: "http://127.0.0.1:3100" }
  const workspace = await page.request.post("/api/admin/oauth-providers/codex/device/start", { headers: { "x-rawroute-workspace-id": "default" } })
  expect(workspace.ok()).toBe(true)
  const { loginId, authorizationUrl } = await workspace.json()
  const callback = `http://localhost:1455/auth/callback?state=${new URL(authorizationUrl).searchParams.get("state")}&code=workspace-test-code`
  expect((await page.request.post("/api/admin/oauth-providers/codex/device/callback", { headers: { "x-rawroute-workspace-id": "default" }, data: { loginId, redirectUrl: callback } })).ok()).toBe(true)
  expect((await page.request.post("/api/admin/oauth-providers/codex/device/poll", { headers: { "x-rawroute-workspace-id": "default" }, data: { loginId } })).ok()).toBe(true)
  await page.goto("/dashboard/cliproxy")
  const workspaceRow = page.getByRole("row").filter({ has: page.getByText("Workspace", { exact: true }) }).first()
  await expect(workspaceRow.getByRole("switch")).toBeDisabled()
  await expect(workspaceRow.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Connect codex", exact: true }).click()
  const link = page.getByRole("link", { name: "Open authorization page" })
  await expect(link).toBeVisible()
  const state = new URL((await link.getAttribute("href"))!).searchParams.get("state")!
  await page.getByLabel("Callback URL", { exact: true }).fill(`http://localhost:1455/auth/callback?state=${state}&code=global-code`)
  await page.getByRole("button", { name: "Submit callback", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.getByText("Global account connected", { exact: true })).toBeVisible()
  const files = await (await page.request.get("/api/admin/cliproxy/auth-files")).json()
  const owned = files.files.find((file: { managed: boolean }) => file.managed)
  expect((await page.request.delete(`/api/admin/cliproxy/auth-files?name=${encodeURIComponent(owned.name)}`, { headers })).status()).toBe(409)
})

test("managed lifecycle UI confirms version changes and remains usable when release discovery fails", async ({ page }) => {
  await authenticate(page)
  let version = "7.3.4"
  await page.route("**/api/admin/cliproxy/status", route => route.fulfill({ json: { mode: "managed", installed: true, version, pinnedVersion: version, healthy: true, processRunning: true, desiredRunning: true, conflict: false, operation: null, restartAttempts: 0, activeRequests: 0 } }))
  await page.route("**/api/admin/cliproxy/versions", route => route.fulfill({ json: { latest: "7.3.5", versions: [{ version: "7.3.5", publishedAt: null }, { version: "7.3.4", publishedAt: null }] } }))
  await page.route("**/api/admin/cliproxy/service/install", async route => { expect(route.request().postDataJSON()).toEqual({ version: "latest" }); version = "7.3.5"; await route.fulfill({ json: { ok: true, version } }) })
  await page.goto("/dashboard/cliproxy")
  await page.getByRole("button", { name: "Install latest (7.3.5)", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("every workspace")
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toBeHidden()
  await expect(page.getByText("7.3.5", { exact: true }).first()).toBeVisible()
  await page.route("**/api/admin/cliproxy/versions", route => route.fulfill({ status: 502, json: { error: { message: "GitHub unavailable" } } }))
  await page.getByRole("button", { name: "Refresh releases", exact: true }).click()
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("button", { name: "Refresh engine logs", exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const action of ["Check status", "Cancel login", "Close dialog"] as const) {
  test(`expired global OAuth can recover through ${action.toLowerCase()} without a page reload`, async ({ page }) => {
    await authenticate(page)
    let starts = 0
    await page.route("**/api/admin/cliproxy/oauth/codex/start", route => route.fulfill({
      json: { state: `expired-${++starts}`, url: "https://example.com/authorize" },
    }))
    await page.route("**/api/admin/cliproxy/oauth/status?*", route => route.fulfill({ status: 410, json: { error: { message: "OAuth session expired" } } }))
    await page.route("**/api/admin/cliproxy/oauth/cancel?*", route => route.fulfill({ status: 410, json: { error: { message: "OAuth session expired" } } }))
    await page.goto("/dashboard/cliproxy")
    const connect = page.getByRole("button", { name: "Connect codex", exact: true })
    await connect.click()
    await expect(page.getByRole("dialog")).toBeVisible()
    if (action === "Close dialog") await page.keyboard.press("Escape")
    else await page.getByRole("button", { name: action, exact: true }).click()
    await expect(page.getByRole("dialog")).toBeHidden()
    await expect(connect).toBeEnabled()
    await connect.click()
    await expect(page.getByRole("dialog")).toBeVisible()
    expect(starts).toBe(2)
    await page.getByRole("button", { name: "Cancel login", exact: true }).click()
    await expect(page.getByRole("dialog")).toBeHidden()
  })
}

test("a temporary OAuth cancellation error retains the session for retry", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/cliproxy/oauth/codex/start", route => route.fulfill({ json: { state: "active-session", url: "https://example.com/authorize" } }))
  let attempts = 0
  await page.route("**/api/admin/cliproxy/oauth/cancel?*", route => route.fulfill(++attempts === 1
    ? { status: 502, json: { error: { message: "Temporary cancellation failure" } } }
    : { json: { ok: true } }))
  await page.goto("/dashboard/cliproxy")
  await page.getByRole("button", { name: "Connect codex", exact: true }).click()
  const cancel = page.getByRole("button", { name: "Cancel login", exact: true })
  await cancel.click()
  await expect(page.getByText("Temporary cancellation failure", { exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toBeVisible()
  await cancel.click()
  await expect(page.getByRole("dialog")).toBeHidden()
})

for (const width of [390, 1440]) {
  test(`copied CLIProxy layout groups releases with the service at ${width}px`, async ({ page }, testInfo) => {
    await authenticate(page)
    await page.setViewportSize({ width, height: 1000 })
    await page.route("**/api/admin/cliproxy/status", route => route.fulfill({ json: { mode: "managed", installed: true, version: "7.3.4", pinnedVersion: null, healthy: true, processRunning: true, desiredRunning: true, conflict: false, operation: null, restartAttempts: 0, activeRequests: 2 } }))
    await page.route("**/api/admin/cliproxy/versions", route => route.fulfill({ json: { latest: "7.3.5", versions: [{ version: "7.3.5", publishedAt: null }] } }))
    await page.goto("/dashboard/cliproxy")
    await expect(page.getByRole("heading", { name: "CLIProxyAPI", exact: true, level: 2 })).toBeVisible()
    const service = page.locator('[data-slot="card"]').filter({ hasText: "Managed process" })
    await expect(service.getByText("Release management", { exact: true })).toBeVisible()
    await expect(service.getByRole("button", { name: "Restart", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Copy Client base URL", exact: true })).toBeVisible()
    await expect(page.getByText("RawRoute transport", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`cliproxy-${width}.png`), fullPage: true })
  })
}
