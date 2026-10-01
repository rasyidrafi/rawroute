import { expect, test } from "@playwright/test"
import { pagePaths } from "../../src/lib/page-routes"

test("production serves every dashboard deep link and keeps unknown APIs out of the HTML app", async ({ request }) => {
  for (const path of Object.values(pagePaths)) {
    const response = await request.get(path.replace(":providerId", "example"))
    expect(response.status(), path).toBe(200)
    expect(response.headers()["content-type"], path).toContain("text/html")
    const html = await response.text()
    expect(html).toContain("<title>RawRoute</title>")
    expect(html).not.toContain("/_next/")
  }
  for (const path of ["/api/missing", "/dashboard/missing", "/v0/management/config", "/executor/auth", "/index.ts"]) {
    const response = await request.get(path)
    expect(response.status(), path).toBe(404)
    expect(response.headers()["content-type"]).toContain("application/json")
  }
  const config = await (await request.get("/api/config")).json()
  expect(Object.keys(config).sort()).toEqual(["timeZone", "version"])
  const head = await request.head("/login")
  expect(head.status()).toBe(200)
  expect(await head.body()).toHaveLength(0)
  expect((await request.post("/login")).status()).toBe(405)
})

test("browser session guard, login, deep links, theme, and logout work without rendering errors", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/?workspace=missing-workspace")
  await expect(page.getByText("Usage summary", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="chart"] .recharts-surface').first()).toBeVisible()
  await expect(page.getByRole("link", { name: "Admin login", exact: true })).toBeVisible()
  await page.goto("/dashboard/providers/codex")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()

  let password = "e2e-initial-password"
  let login = await page.request.post("/api/auth/login", { data: { password } })
  if (!login.ok()) {
    password = "private-password"
    login = await page.request.post("/api/auth/login", { data: { password } })
  }
  expect(login.ok()).toBe(true)
  expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
  await page.request.post("/api/auth/logout")

  await expect(page.getByLabel("Username")).toHaveCount(0)
  await page.getByLabel("Password", { exact: true }).fill("invalid-password")
  const loginRequest = page.waitForRequest((request) => request.url().endsWith("/api/auth/login") && request.method() === "POST")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  expect((await loginRequest).postDataJSON()).toEqual({ password: "invalid-password" })
  await expect(page.getByText("Invalid password.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel("Password", { exact: true }).fill("private-password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible()
  await page.goto("/login")
  await expect(page).toHaveURL(/\/dashboard$/)

  await page.getByRole("button", { name: "Change color theme" }).click()
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.goto("/dashboard/usage")
  await expect(page.getByText("Usage summary", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="chart"] .recharts-surface').first()).toBeVisible()
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Plus Jakarta Sans")

  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await (await page.request.get("/api/auth/session")).json()).toEqual({ authenticated: false })
  expect(errors).toEqual([])
})
