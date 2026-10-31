import { expect, test } from "@playwright/test"

test("health and dashboard expose no separate engine lifecycle or configuration", async ({ page, request }) => {
  const health = await request.get("/api/health")
  expect(health.ok()).toBe(true)
  const result = await health.json()
  expect(result.status).toBe("ok")
  expect(Object.keys(result.dependencies).sort()).toEqual(["database", "storage"])
  expect(result.dependencies.database).toBe(true)

  for (const path of ["/dashboard/cliproxy", "/api/admin/cliproxy/status", "/api/admin/cliproxy/versions"]) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status(), path).toBe(404)
    expect(response.headers().location).toBeUndefined()
  }
  const lifecycle = await request.post("/api/admin/cliproxy/service/start", { maxRedirects: 0 })
  expect(lifecycle.status()).toBe(404)

  let login = await page.request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  const account = await page.request.get("/api/admin/account")
  if ((await account.json()).mustChangePassword) {
    expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  }
  await page.goto("/dashboard/ai/providers")
  await expect(page.getByRole("link", { name: "Providers", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: /CLIProxy/i })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /install|restart|stop engine/i })).toHaveCount(0)
})
