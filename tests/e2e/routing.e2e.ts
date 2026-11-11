import { expect, test, type Page } from "@playwright/test"

async function authenticate(page: Page) {
  let login = await page.request.post("/api/auth/login", {
    data: { password: "123456" },
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

test("Model routing creates, deduplicates and deletes a single-model combo", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/ai/routing")
  await expect(page.getByRole("link", { name: "Model routing" })).toBeVisible()
  await expect(page.getByText("No combos yet.", { exact: false })).toBeVisible()

  await page.getByRole("button", { name: "Add combo" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("auto", { exact: true }).fill("my-cool-model")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("My Cool Model")
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("button", { name: "Add combo" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("my-cool-model")).toBeVisible()
  await expect(page.getByRole("cell", { name: "alias-target/target-model" })).toBeVisible()

  await page.getByRole("main").getByRole("button", { name: "Add combo" }).click()
  await dialog.getByPlaceholder("auto", { exact: true }).fill("my-cool-model")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("Duplicate")
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("button", { name: "Add combo" }).click()
  await expect(page.getByText("Combo gateway ID is already in use.")).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("table").filter({ hasText: "Models / fallback order" }).getByRole("row")).toHaveCount(2)

  await page.getByRole("button", { name: "Edit My Cool Model" }).click()
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("My Cool Model Edited")
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("My Cool Model Edited")).toBeVisible()
  await expect(page.getByText("my-cool-model")).toBeVisible()

  await page.getByRole("button", { name: "Delete My Cool Model Edited?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("No combos yet.", { exact: false })).toBeVisible()

})

test("Model routing menu creates, reorders and deletes a fallback combo", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/ai/routing")
  await expect(page.getByText("No combos yet.", { exact: false })).toBeVisible()

  await page.getByRole("main").getByRole("button", { name: "Add combo" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("auto", { exact: true }).fill("coding-fallback")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("Coding fallback")
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
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
  await expect(page.getByText("No combos yet.", { exact: false })).toBeVisible()

})

test("Model routing keeps open and closed fallback cards stable when reordered in either direction", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/ai/routing")
  await page.getByRole("main").getByRole("button", { name: "Add combo" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("auto", { exact: true }).fill("open-closed-reorder")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("Open closed reorder")
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /alias-target\/target-model-2/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("button", { name: "Add combo" }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole("button", { name: "Edit Open closed reorder" }).click()
  const cards = dialog.locator(".sortable-member")
  await dialog.getByRole("button", { name: "Configure alias-target/target-model", exact: true }).click()

  async function drag(sourceId: string, targetId: string) {
    const sourceHandle = dialog.getByRole("button", { name: `Drag ${sourceId} to reorder`, exact: true })
    const currentOrder = await cards.evaluateAll(elements => elements.map(element => element.querySelector<HTMLButtonElement>('button[aria-label^="Drag "]')?.getAttribute("aria-label")?.replace(/^Drag | to reorder$/g, "")))
    const targetIndex = currentOrder.indexOf(targetId)
    const [sourceHandleBox, sourceCardBox, targetBox] = await Promise.all([
      sourceHandle.boundingBox(),
      sourceHandle.evaluate(element => element.closest<HTMLElement>(".sortable-member")!.getBoundingClientRect().toJSON()),
      cards.nth(targetIndex).boundingBox(),
    ])
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    expect(sourceHandleBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    await page.mouse.move(sourceHandleBox!.x + sourceHandleBox!.width / 2, sourceHandleBox!.y + sourceHandleBox!.height / 2)
    await page.mouse.down()
    const activeCenterOffset = sourceCardBox.height / 2 - (sourceHandleBox!.y + sourceHandleBox!.height / 2 - sourceCardBox.top)
    const targetPointerY = targetBox!.y + targetBox!.height / 2 - activeCenterOffset
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetPointerY, { steps: 16 })
    await page.mouse.up()
    const expectedOrder = [...currentOrder]
    const sourceIndex = expectedOrder.indexOf(sourceId)
    expectedOrder.splice(sourceIndex, 1)
    expectedOrder.splice(targetIndex, 0, sourceId)
    await expect.poll(async () => cards.evaluateAll(elements => elements.map(element => element.querySelector<HTMLButtonElement>('button[aria-label^="Drag "]')?.getAttribute("aria-label")))).toEqual(expectedOrder.map(id => `Drag ${id} to reorder`))
    const boxes = await cards.evaluateAll(elements => elements.map(element => {
      const { top, bottom, height } = element.getBoundingClientRect()
      return { top, bottom, height }
    }))
    expect(boxes).toHaveLength(2)
    await expect.poll(async () => cards.evaluateAll(elements => {
      const boxes = elements.map(element => element.getBoundingClientRect())
      return boxes.length === 2 && boxes[1]!.top >= boxes[0]!.bottom - 1 && boxes.every(box => box.height > 40)
    })).toBe(true)
  }

  await expect(cards.nth(0).getByRole("button", { name: "Collapse alias-target/target-model" })).toBeVisible()
  await expect(cards.nth(1).getByRole("button", { name: "Configure alias-target/target-model-2" })).toBeVisible()
  await drag("alias-target/target-model-2", "alias-target/target-model")
  await expect(cards.nth(0)).toContainText("alias-target/target-model-2")
  await expect(cards.nth(1)).toContainText("alias-target/target-model")
  await expect(cards.nth(1).getByRole("button", { name: "Collapse alias-target/target-model" })).toBeVisible()
  await expect.poll(async () => (await cards.nth(0).boundingBox())?.height).toBeLessThan(80)
  await expect.poll(async () => (await cards.nth(1).boundingBox())?.height).toBeGreaterThan(100)
  await drag("alias-target/target-model", "alias-target/target-model-2")
  await expect(cards.nth(0)).toContainText("alias-target/target-model")
  await expect(cards.nth(1)).toContainText("alias-target/target-model-2")
  await expect(cards.nth(0).getByRole("button", { name: "Collapse alias-target/target-model" })).toBeVisible()
  await expect.poll(async () => (await cards.nth(0).boundingBox())?.height).toBeGreaterThan(100)
  await expect.poll(async () => (await cards.nth(1).boundingBox())?.height).toBeLessThan(80)

  await dialog.getByRole("button", { name: "Close" }).click()
  await page.getByRole("button", { name: "Delete Open closed reorder?" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
})

test("Model routing applies OpenAI Fast to a combo member", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  page.on("dialog", dialog => dialog.accept())
  await page.goto("/dashboard/ai/routing")
  await page.getByRole("main").getByRole("button", { name: "Add combo" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("auto", { exact: true }).fill("fast-member-combo")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("Fast member combo")
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await dialog.getByRole("combobox", { name: "Service tier" }).click()
  await page.getByRole("option", { name: "Fast (OpenAI)" }).click()
  await expect(dialog.getByText("OpenAI Fast")).toBeVisible()
  await dialog.getByRole("button", { name: "Add combo" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("row").filter({ hasText: "Fast member combo" }).getByText("OpenAI Fast")).toBeVisible()
})

test("Model routing effort autocomplete accepts custom values and suggests presets", async ({ page }) => {
  await authenticate(page)
  await seedProviderAndModel(page)
  await page.goto("/dashboard/ai/routing")
  await page.getByRole("main").getByRole("button", { name: "Add combo" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("auto", { exact: true }).fill("effort-autocomplete")
  await dialog.getByPlaceholder("Automatic fallback", { exact: true }).fill("Effort autocomplete")
  await dialog.getByRole("combobox").filter({ hasText: "Select a local or shared model" }).click()
  await page.getByRole("option", { name: /^alias-target\/target-model\s/ }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()

  await dialog.getByRole("combobox", { name: "Reasoning" }).click()
  await page.getByRole("option", { name: "Override client" }).click()
  const effort = dialog.getByRole("combobox", { name: "Effort" })
  await effort.fill("custom-reasoning-level")
  await expect(effort).toHaveValue("custom-reasoning-level")
  await effort.fill("")
  await effort.click()
  await page.getByRole("option", { name: "xhigh", exact: true }).click()
  await expect(effort).toHaveValue("xhigh")
  await effort.fill("custom-reasoning-level")
  await expect(effort).toHaveValue("custom-reasoning-level")
})
