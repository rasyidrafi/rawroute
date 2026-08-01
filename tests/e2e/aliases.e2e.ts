import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "change-me-now" },
  })
  if (!login.ok()) {
    login = await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "private-password" },
    })
  }
  expect(login.ok()).toBe(true)

  const account = await page.request.get("/api/admin/account")
  expect(account.ok()).toBe(true)
  if ((await account.json()).mustChangePassword) {
    const password = await page.request.post("/api/admin/account/password", {
      data: { password: "private-password" },
    })
    expect(password.ok()).toBe(true)
  }
}

async function restoreDefaultPassword(page: Page) {
  const response = await page.request.post("/api/admin/account/password", {
    data: { password: "change-me-now" },
  })
  expect(response.ok()).toBe(true)
}

async function seedProviderAndModel(page: Page) {
  const providers = await page.request.get("/api/admin/providers")
  expect(providers.ok()).toBe(true)
  const existing = ((await providers.json()).providers as Array<{ id: string; prefix: string }>).find((provider) => provider.prefix === "alias-target")
  const providerResponse = await page.request.post("/api/admin/providers", {
    data: {
      provider: {
        ...(existing ? { originalId: existing.id } : {}),
        name: "Alias Target",
        prefix: "alias-target",
        baseUrl: "https://example.com/v1",
        protocol: "openai-chat",
        authType: "none",
        headers: {},
      },
    },
  })
  expect(providerResponse.ok()).toBe(true)
  const providerId = (await providerResponse.json()).providerId as string

  const modelResponse = await page.request.post(`/api/admin/providers/${providerId}/models`, {
    data: {
      model: {
        gatewayModelId: "target-model",
        name: "Target Model",
        upstreamModel: "upstream/target-model",
      },
    },
  })
  expect(modelResponse.ok()).toBe(true)
}

test("Alias menu creates, deduplicates and deletes a model alias", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/aliases")
  await expect(page.getByRole("link", { name: "Alias" })).toBeVisible()
  await expect(page.getByText("No aliases yet.")).toBeVisible()

  await page.getByRole("button", { name: "Add alias" }).click()
  await page.getByPlaceholder("my-cool-model").fill("my-cool-model")
  await page.getByPlaceholder("My Cool Model").fill("My Cool Model")
  await page.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "Alias Target" }).click()
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: /alias-target\/target-model/ }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Add alias" }).click()
  await expect(page.getByText("my-cool-model")).toBeVisible()
  await expect(page.getByRole("cell", { name: "alias-target/target-model" })).toBeVisible()

  await page.getByRole("main").getByRole("button", { name: "Add alias" }).click()
  await page.getByPlaceholder("my-cool-model").fill("my-cool-model")
  await page.getByPlaceholder("My Cool Model").fill("Duplicate")
  await page.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "Alias Target" }).click()
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: /alias-target\/target-model/ }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Add alias" }).click()
  await expect(page.getByText("Alias is already in use.")).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("row")).toHaveCount(2)

  await page.getByRole("button", { name: "Edit My Cool Model" }).click()
  await page.getByPlaceholder("My Cool Model").fill("My Cool Model Edited")
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("My Cool Model Edited")).toBeVisible()
  await expect(page.getByText("my-cool-model")).toBeVisible()

  await page.getByRole("button", { name: "Delete My Cool Model Edited?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("No aliases yet.")).toBeVisible()

  await restoreDefaultPassword(page)
})
