import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
}

test("global CLIProxy controls work without a workspace and expose no engine key management", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/workspaces", route => route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } }))
  await page.goto("/dashboard/cliproxy")
  await expect(page.getByText("External instance", { exact: true })).toHaveCount(1)
  await expect(page.getByText("CLIProxy API keys", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel("New CLIProxy key")).toHaveCount(0)
  await expect(page.getByText("Global OAuth", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Authentication files", { exact: true })).toHaveCount(0)
  await expect(page.getByText("CLIProxy logs", { exact: true })).toHaveCount(0)
  for (const method of ["GET", "DELETE"]) {
    expect((await page.request.fetch("/api/admin/cliproxy/logs", { method })).status()).toBe(404)
  }
  for (const method of ["GET", "PATCH", "DELETE"]) {
    expect((await page.request.fetch("/api/admin/cliproxy/auth-files", { method })).status()).toBe(404)
  }
  await expect(page.getByRole("button", { name: /^Connect / })).toHaveCount(0)
  for (const provider of ["codex", "anthropic", "antigravity", "kimi", "xai"]) {
    for (const action of ["start", "callback"]) {
      expect((await page.request.post(`/api/admin/cliproxy/oauth/${provider}/${action}`)).status()).toBe(404)
    }
  }
  expect((await page.request.get("/api/admin/cliproxy/oauth/status?state=removed")).status()).toBe(404)
  expect((await page.request.post("/api/admin/cliproxy/oauth/cancel?state=removed")).status()).toBe(404)
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await page.request.fetch("/api/admin/cliproxy/api-keys", { method })
    expect(response.status()).toBe(404)
  }
  expect((await page.request.delete("/api/admin/cliproxy/api-keys/removed-key")).status()).toBe(404)
})

test("workspace Codex OAuth can complete", async ({ page }) => {
  await authenticate(page)
  const headers = { origin: "http://127.0.0.1:3100" }
  const workspace = await page.request.post("/api/admin/oauth-providers/codex/device/start", { headers: { ...headers, "x-rawroute-workspace-id": "default" } })
  expect(workspace.ok(), await workspace.text()).toBe(true)
  const { loginId, authorizationUrl } = await workspace.json()
  const callback = `http://localhost:1455/auth/callback?state=${new URL(authorizationUrl).searchParams.get("state")}&code=workspace-test-code`
  expect((await page.request.post("/api/admin/oauth-providers/codex/device/callback", { headers: { ...headers, "x-rawroute-workspace-id": "default" }, data: { loginId, redirectUrl: callback } })).ok()).toBe(true)
  const completed = await page.request.post("/api/admin/oauth-providers/codex/device/poll", { headers: { ...headers, "x-rawroute-workspace-id": "default" }, data: { loginId } })
  expect(completed.ok()).toBe(true)
  expect(await completed.json()).toMatchObject({ status: "authorized", account: { id: expect.any(String) } })

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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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
    await expect(page.getByText("RawRoute transport", { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`cliproxy-${width}.png`), fullPage: true })
  })
}
