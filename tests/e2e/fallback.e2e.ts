import { expect, test, type APIRequestContext } from "@playwright/test"

async function authenticate(request: APIRequestContext) {
  let login = await request.post("/api/auth/login", { data: { username: "admin", password: "change-me-now" } })
  if (!login.ok()) login = await request.post("/api/auth/login", { data: { username: "admin", password: "private-password" } })
  expect(login.ok()).toBe(true)
}

async function codexModels(request: APIRequestContext) {
  const response = await request.get("/v1/models", { headers: { authorization: "Bearer sk-local-change-me" } })
  expect(response.ok()).toBe(true)
  return ((await response.json()).data as Array<{ id: string }>).map((model) => model.id).filter((id) => id.startsWith("codex/"))
}

test("synthetic CLIProxy cooldown never exposes a long retry delay", async ({ request }) => {
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "always-cooldown" } })
  const [model] = await codexModels(request)
  expect(model).toBeTruthy()

  const response = await request.post("/v1/responses", {
    headers: { authorization: "Bearer sk-local-change-me" },
    data: { model, input: "hello", stream: true },
  })

  expect(response.status()).toBe(503)
  expect(response.headers()["retry-after"]).toBeUndefined()
  await expect(response.json()).resolves.toMatchObject({ error: { code: "upstream_unavailable" } })
})

test("Codex cooldown never reaches OpenCode as a retry instruction", async ({ request }) => {
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "codex-cooldown" } })
  const [model] = await codexModels(request)

  const response = await request.post("/v1/responses", {
    headers: { authorization: "Bearer sk-local-change-me" },
    data: { model, input: "hello", stream: true },
  })

  expect(response.status()).toBe(503)
  expect(response.headers()["retry-after"]).toBeUndefined()
  await expect(response.json()).resolves.toMatchObject({ error: { code: "upstream_unavailable" } })
})

test("ambiguous upstream 429 cannot impose a retry deadline", async ({ request }) => {
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "ambiguous-429" } })
  const [model] = await codexModels(request)

  const response = await request.post("/v1/responses", {
    headers: { authorization: "Bearer sk-local-change-me" },
    data: { model, input: "hello", stream: true },
  })

  expect(response.status()).toBe(503)
  expect(response.headers()["retry-after"]).toBeUndefined()
})

test("combo immediately falls back instead of forwarding model cooldown", async ({ request }) => {
  await authenticate(request)
  await request.post("http://127.0.0.1:3211/routing-mode", { data: { mode: "cooldown-once" } })
  const models = await codexModels(request)
  expect(models.length).toBeGreaterThanOrEqual(2)
  const comboId = `e2e-fallback-${Date.now()}`
  const saved = await request.post("/api/admin/combos", {
    data: { combo: { combo: comboId, name: "E2E immediate fallback", memberModelIds: models.slice(0, 2) } },
  })
  expect(saved.ok()).toBe(true)

  const response = await request.post("/v1/responses", {
    headers: { authorization: "Bearer sk-local-change-me" },
    data: { model: comboId, input: "hello", stream: true },
  })

  expect(response.ok()).toBe(true)
  expect(response.headers()["retry-after"]).toBeUndefined()
  expect(await response.text()).toContain("response.completed")
  const debug = await request.get("http://127.0.0.1:3211/debug")
  expect((await debug.json()).routingAttempts).toBe(2)
})
