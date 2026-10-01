import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", {
    data: { password: "e2e-initial-password" },
  })
  if (!login.ok()) {
    login = await page.request.post("/api/auth/login", {
      data: { password: "private-password" },
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

async function seedProviderAndModel(page: Page) {
  const providers = await page.request.get("/api/admin/providers", { headers: { "x-rawroute-workspace-id": "default" } })
  expect(providers.ok()).toBe(true)
  const existing = ((await providers.json()).providers as Array<{ id: string; prefix: string }>).find((provider) => provider.prefix === "alias-target")
  const providerResponse = await page.request.post("/api/admin/providers", { headers: { "x-rawroute-workspace-id": "default" },
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

  const detail = await page.request.get(`/api/admin/providers/${providerId}`, { headers: { "x-rawroute-workspace-id": "default" } })
  expect(detail.ok()).toBe(true)
  const existingModels = new Set(((await detail.json()).models as Array<{ gatewayModelId: string }>).map((model) => model.gatewayModelId))
  for (const model of [
    { gatewayModelId: "target-model", name: "Target Model", upstreamModel: "upstream/target-model" },
    { gatewayModelId: "target-model-2", name: "Target Model Two", upstreamModel: "upstream/target-model-2" },
  ]) {
    if (existingModels.has(`alias-target/${model.gatewayModelId}`)) continue
    const modelResponse = await page.request.post(`/api/admin/providers/${providerId}/models`, { headers: { "x-rawroute-workspace-id": "default" },  data: { model } })
    expect(modelResponse.ok()).toBe(true)
  }
}

test("Alias menu creates, deduplicates and deletes a model alias", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/ai/routing")
  await expect(page.getByRole("link", { name: "Model routing" })).toBeVisible()
  await expect(page.getByText("No aliases yet.")).toBeVisible()

  await page.getByRole("button", { name: "Add alias" }).click()
  await page.getByPlaceholder("my-cool-model").fill("my-cool-model")
  await page.getByPlaceholder("My Cool Model").fill("My Cool Model")
  await page.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "Alias Target" }).click()
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Add alias" }).click()
  await expect(page.getByText("my-cool-model")).toBeVisible()
  await expect(page.getByRole("cell", { name: "alias-target/target-model" })).toBeVisible()

  await page.getByRole("main").getByRole("button", { name: "Add alias" }).click()
  await page.getByPlaceholder("my-cool-model").fill("my-cool-model")
  await page.getByPlaceholder("My Cool Model").fill("Duplicate")
  await page.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "Alias Target" }).click()
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Add alias" }).click()
  await expect(page.getByText("Alias is already in use.")).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("table").filter({ hasText: "Target model" }).getByRole("row")).toHaveCount(2)

  await page.getByRole("button", { name: "Edit My Cool Model" }).click()
  await page.getByPlaceholder("My Cool Model").fill("My Cool Model Edited")
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("My Cool Model Edited")).toBeVisible()
  await expect(page.getByText("my-cool-model")).toBeVisible()

  await page.getByRole("button", { name: "Delete My Cool Model Edited?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("No aliases yet.")).toBeVisible()

})

test("Model routing menu creates, reorders and deletes a fallback combo", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/ai/routing")
  await expect(page.getByText("No combos yet.")).toBeVisible()

  await page.getByRole("main").getByRole("button", { name: "Add combo" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("auto", { exact: true }).fill("coding-fallback")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("Coding fallback")
  await dialog.getByRole("combobox").filter({ hasText: "Select a model or alias" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("combobox").filter({ hasText: "Select a model or alias" }).click()
  await page.getByRole("option", { name: /alias-target\/target-model-2/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("button", { name: "Add combo" }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByText("coding-fallback")).toBeVisible()
  await expect(page.getByText("alias-target/target-model-2")).toBeVisible()

  await page.getByRole("button", { name: "Edit Coding fallback" }).click()
  const dragHandle = dialog.getByRole("button", { name: "Drag alias-target/target-model-2 to reorder" })
  const targetHandle = dialog.getByRole("button", { name: "Drag alias-target/target-model to reorder", exact: true })
  const target = await targetHandle.boundingBox()
  expect(target).not.toBeNull()
  await dragHandle.hover()
  await page.mouse.down()
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 })
  await page.mouse.up()
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("row").filter({ hasText: "Coding fallback" }).locator("ol li")).toHaveText(["alias-target/target-model-2", "alias-target/target-model"])

  await page.getByRole("button", { name: "Delete Coding fallback?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("No combos yet.")).toBeVisible()

})
