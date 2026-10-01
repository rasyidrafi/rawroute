import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let response = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
  if (!response.ok()) response = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(response.ok()).toBe(true)
  const account = await page.request.get("/api/admin/account")
  if ((await account.json()).mustChangePassword) expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
}

async function selectWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: /RawRoute/ }).first().click()
  await page.getByRole("menuitemradio", { name, exact: true }).click()
}

test("System and Global logs are isolated and shared pages preserve the selected app", async ({ page }) => {
  await authenticate(page)
  const workspaces: Array<{ id: string; name: string }> = []
  for (const name of ["Log Alpha", "Log Beta"]) {
    const response = await page.request.post("/api/admin/workspaces", { data: { name } })
    expect(response.ok()).toBe(true)
    workspaces.push((await response.json()).workspace)
  }
  const [alpha, beta] = workspaces
  try {
    for (const [workspace, event] of [[alpha, "logs.paused"], [beta, "logs.resumed"]] as const) {
      expect((await page.request.post("/api/admin/logs/events", { headers: { origin: "http://127.0.0.1:3100", "x-rawroute-workspace-id": workspace.id }, data: { event, page: "logs" } })).ok()).toBe(true)
    }
    await page.goto("/dashboard/logs")
    await selectWorkspace(page, alpha.name)
    const entries = page.getByLabel("Console log entries")
    await expect(entries).toContainText("Live log updates paused")
    await expect(entries).not.toContainText("Live log updates resumed")
    await selectWorkspace(page, beta.name)
    await expect(entries).toContainText("Live log updates resumed")
    await expect(entries).not.toContainText("Live log updates paused")
    await page.getByRole("button", { name: "Clear", exact: true }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear logs" }).click()
    await expect(page.getByRole("alertdialog")).toBeHidden()
    await expect(entries).toContainText("Log history cleared")
    await expect(entries).not.toContainText("Live log updates resumed")
    await selectWorkspace(page, alpha.name)
    await expect(entries).toContainText("Live log updates paused")
    await page.getByRole("link", { name: "System Logs", exact: true }).click()
    await expect(page.getByRole("heading", { name: "System Logs", exact: true })).toBeVisible()
    await expect(entries).toContainText("Admin signed in")
    await expect(entries).not.toContainText("Live log updates paused")
    await expect(page.getByRole("link", { name: "CLIProxyAPI", exact: true })).toBeVisible()
    await page.getByRole("button", { name: /RawRoute/ }).first().click()
    await page.getByRole("menuitemradio", { name: "Tool Gateway", exact: true }).click()
    await page.getByRole("link", { name: "System Logs", exact: true }).click()
    await expect(page.getByRole("button", { name: /RawRoute/ }).first()).toContainText("Tool Gateway")
    await page.reload()
    await expect(page.getByRole("button", { name: /RawRoute/ }).first()).toContainText("Tool Gateway")
  } finally {
    for (const workspace of workspaces) await page.request.delete(`/api/admin/workspaces/${workspace.id}`, { data: { confirmation: workspace.name } })
  }
})

test("global Settings and System Logs remain usable when workspace loading fails", async ({ page }) => {
  await authenticate(page)
  await page.route("**/api/admin/workspaces", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Workspace service unavailable" } }) }))
  await page.goto("/dashboard/settings")
  await expect(page.getByText("Admin password", { exact: true })).toBeVisible()
  await page.getByRole("link", { name: "CLIProxyAPI", exact: true }).click()
  await page.getByRole("button", { name: "Engine settings", exact: true }).click()
  await expect(page.getByLabel("Request retry count")).toBeVisible()
  await page.getByRole("link", { name: "System Logs", exact: true }).click()
  await expect(page.getByLabel("Console log entries")).toContainText("Admin signed in")
  await page.getByRole("link", { name: "Console Log", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Workspace unavailable")
})

test("a delayed workspace response cannot replace the newly selected workspace logs", async ({ page }) => {
  await authenticate(page)
  const response = await page.request.post("/api/admin/workspaces", { data: { name: "Delayed logs" } })
  const workspace = (await response.json()).workspace as { id: string; name: string }
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  await page.route("**/api/admin/logs", async route => {
    if (route.request().headers()["x-rawroute-workspace-id"] !== workspace.id) return route.continue()
    started = true
    await gate
    await route.fulfill({ json: { scope: "workspace", workspaceId: workspace.id, capacity: 2000, evicted: 0, entries: [{ id: "late", timestamp: new Date().toISOString(), level: "info", source: "gateway", event: "gateway.request.completed", message: "Delayed Alpha response", origin: "server", scope: "workspace", workspaceId: workspace.id, requestId: null, details: {} }] } })
  })
  try {
    await page.goto("/dashboard/logs")
    await selectWorkspace(page, workspace.name)
    await expect.poll(() => started).toBe(true)
    await selectWorkspace(page, "Default")
    release()
    await expect(page.getByLabel("Console log entries")).not.toContainText("Delayed Alpha response")
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(page.getByText("Loading logs...")).toBeHidden()
    await expect(page.getByLabel("Console log entries")).not.toContainText("Delayed Alpha response")
  } finally {
    release()
    await page.request.delete(`/api/admin/workspaces/${workspace.id}`, { data: { confirmation: workspace.name } })
  }
})

test("global settings save without a workspace header and survive reload", async ({ page }) => {
  await authenticate(page)
  await page.goto("/dashboard/cliproxy/settings")
  await page.getByLabel("Request retry count").fill("4")
  await page.getByLabel("Maximum retry interval (seconds)").fill("45")
  const saved = page.waitForResponse(response => response.url().endsWith("/api/admin/cliproxy/settings") && response.request().method() === "PATCH")
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  expect(response.request().headers()["x-rawroute-workspace-id"]).toBeUndefined()
  await expect(page.getByText("CLIProxyAPI settings saved", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Request retry count")).toHaveValue("4")
  await expect(page.getByLabel("Maximum retry interval (seconds)")).toHaveValue("45")
  await expect(page.getByLabel("Routing strategy", { exact: true })).toHaveText("fill-first")
})

for (const global of [false, true]) {
  test(`${global ? "system" : "workspace"} log toolbar groups filters, hides redundant sources and resets unavailable selections`, async ({ page }, testInfo) => {
    await authenticate(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    let sources = ["http", "system"]
    await page.route(global ? "**/api/admin/logs/global" : "**/api/admin/logs", route => route.fulfill({ json: {
      scope: global ? "global" : "workspace", workspaceId: global ? null : "default", capacity: 2000, evicted: 0,
      entries: sources.map((source, index) => ({ id: String(index), timestamp: "2026-10-01T12:00:00Z", level: "info", source, event: "test.event", message: `${source} activity`, origin: "server", scope: global ? "global" : "workspace", workspaceId: global ? null : "default", requestId: null, details: {} })),
    } }))
    await page.goto(global ? "/dashboard/system-logs" : "/dashboard/logs")
    const source = page.getByRole("combobox", { name: "Log source" })
    await expect(source).toBeVisible()
    await expect(page.getByText(/capacity 2000|Refreshes every|newest first/)).toHaveCount(0)
    const search = page.getByRole("textbox", { name: "Search logs" })
    const live = page.getByRole("checkbox", { name: "Live", exact: true })
    const searchBox = (await search.boundingBox())!
    const sourceBox = (await source.boundingBox())!
    const liveBox = (await live.boundingBox())!
    expect(searchBox.x).toBeGreaterThan(sourceBox.x + sourceBox.width)
    expect(liveBox.x).toBeGreaterThan(searchBox.x + searchBox.width)
    expect(Math.abs(searchBox.y - sourceBox.y)).toBeLessThan(3)
    await source.click()
    await page.getByRole("option", { name: "http", exact: true }).click()
    await expect(page.getByLabel("Console log entries")).not.toContainText("system activity")
    await search.fill("missing")
    await expect(page.getByLabel("Console log entries")).toContainText("No matching logs")
    await search.clear()
    sources = ["system"]
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(source).toHaveCount(0)
    await expect(page.getByLabel("Console log entries")).toContainText("system activity")
    await live.uncheck()
    await expect(page.getByRole("checkbox", { name: "Paused", exact: true })).not.toBeChecked()
    await page.screenshot({ path: testInfo.outputPath("toolbar-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(search).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath("toolbar-mobile.png"), fullPage: true })
  })
}
