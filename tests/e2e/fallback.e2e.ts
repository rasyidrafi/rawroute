import { expect, test, type APIRequestContext } from "@playwright/test"

async function authenticate(request: APIRequestContext) {
  let login = await request.post("/api/auth/login", { data: { password: "123456" } })
  if (!login.ok()) login = await request.post("/api/auth/login", { data: { password: "private-password" } })
  expect(login.ok()).toBe(true)
  const account = await request.get("/api/admin/account")
  expect(account.ok()).toBe(true)
  if ((await account.json()).mustChangePassword) {
    const changed = await request.post("/api/admin/account/password", { data: { password: "private-password" } })
    expect(changed.ok()).toBe(true)
  }
}

async function gatewayHeaders(request: APIRequestContext) {
  const response = await request.get("/api/admin/endpoint-key", { headers: { "x-rawroute-workspace-id": "default" } })
  expect(response.ok()).toBe(true)
  const { apiKeys } = await response.json()
  expect(apiKeys[0].key).toMatch(/^sk-/)
  return { authorization: `Bearer ${apiKeys[0].key}` }
}

async function providerModels(request: APIRequestContext, count = 1) {
  await authenticate(request)
  await request.post("http://127.0.0.1:3211/reset")
  const headers = { "x-rawroute-workspace-id": "default" }
  const prefix = `e2e${Date.now()}${Math.random().toString(36).slice(2, 7)}`
  const created = await request.post("/api/admin/providers", { headers, data: { provider: {
    prefix, name: "E2E local provider", baseUrl: "http://127.0.0.1:3211", protocol: "openai-responses", authType: "none",
  } } })
  expect(created.ok(), await created.text()).toBe(true)
  const { providerId } = await created.json() as { providerId: string }
  const models = Array.from({ length: count }, (_, index) => `${prefix}/model-${index + 1}`)
  for (const [index, gatewayModelId] of models.entries()) {
    const saved = await request.post(`/api/admin/providers/${providerId}/models`, { headers, data: { model: {
      gatewayModelId, name: `E2E model ${index + 1}`, upstreamModel: `model-${index + 1}`,
    } } })
    expect(saved.ok(), await saved.text()).toBe(true)
  }
  return { headers: await gatewayHeaders(request), models, providerId, workspaceHeaders: headers }
}

async function deleteProvider(request: APIRequestContext, providerId: string, headers: Record<string, string>) {
  const response = await request.delete(`/api/admin/providers/${providerId}`, { headers })
  expect(response.ok(), await response.text()).toBe(true)
}

test("provider quota cooldown never exposes a long retry delay", async ({ request }) => {
  const setup = await providerModels(request)
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "always-cooldown" } })
  try {
    const response = await request.post("/v1/responses", {
      headers: setup.headers,
      data: { model: setup.models[0], input: "hello", stream: true },
    })
    expect(response.status()).toBe(503)
    expect(response.headers()["retry-after"]).toBeUndefined()
    await expect(response.json()).resolves.toMatchObject({ error: { code: "upstream_unavailable" } })
  } finally { await deleteProvider(request, setup.providerId, setup.workspaceHeaders) }
})

test("ambiguous upstream 429 cannot impose a retry deadline", async ({ request }) => {
  const setup = await providerModels(request)
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "ambiguous-429" } })
  try {
    const response = await request.post("/v1/responses", {
      headers: setup.headers,
      data: { model: setup.models[0], input: "hello", stream: true },
    })
    expect(response.status()).toBe(503)
    expect(response.headers()["retry-after"]).toBeUndefined()
  } finally { await deleteProvider(request, setup.providerId, setup.workspaceHeaders) }
})

test("combo immediately falls back to its next directly connected provider model", async ({ request }) => {
  const setup = await providerModels(request, 2)
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "cooldown-once" } })
  const comboId = `e2e-fallback-${Date.now()}`
  const saved = await request.post("/api/admin/combos", { headers: setup.workspaceHeaders,
    data: { combo: { combo: comboId, name: "E2E immediate fallback", members: setup.models.map(modelId => ({ modelId })) } },
  })
  expect(saved.ok(), await saved.text()).toBe(true)
  const { combo } = await saved.json() as { combo: { id: string } }
  try {
    const response = await request.post("/v1/responses", {
      headers: setup.headers,
      data: { model: comboId, input: "hello", stream: true },
    })
    expect(response.ok()).toBe(true)
    expect(response.headers()["retry-after"]).toBeUndefined()
    expect(await response.text()).toContain("response.completed")
    const debug = await request.get("http://127.0.0.1:3211/debug")
    expect((await debug.json()).routingAttempts).toBe(2)
    await expect.poll(async () => {
      const params = new URLSearchParams({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString(), model: comboId, status: "recovered" })
      const logs = await request.get(`/api/admin/request-logs?${params}`, { headers: setup.workspaceHeaders })
      const { events } = await logs.json() as { events: Array<{ requestId: string; requestedModel: string; attemptIndex: number; requestFinal: boolean }> }
      return events.length === 2 && events[0]!.requestId === events[1]!.requestId && events.every(event => event.requestedModel === comboId)
        && events[0]!.attemptIndex === 0 && events[0]!.requestFinal === false && events[1]!.attemptIndex === 1 && events[1]!.requestFinal === true
    }).toBe(true)
  } finally {
    const deleted = await request.delete(`/api/admin/combos/${combo.id}`, { headers: setup.workspaceHeaders })
    expect(deleted.ok()).toBe(true)
    await deleteProvider(request, setup.providerId, setup.workspaceHeaders)
  }
})
