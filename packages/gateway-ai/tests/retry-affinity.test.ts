import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { configurePlatformServer, resetWorkspacesForTests } from "@rawroute/platform/server/runtime"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { _resetMemoryBackend, deleteProviderApiKey, listProviderApiKeys, upsertCombo, upsertModel, upsertProvider, upsertProviderApiKey } from "../src/server/store"
import { listUsageEvents } from "../src/server/analytics"
import { drainGatewayExecutions, resumeGatewayExecutions } from "../src/server/gateway/admission"
import * as analytics from "../src/server/analytics"
import { createProviderCredentialScheduler, providerCredentialScheduler } from "../src/server/gateway/provider-credential-scheduler"
import { registerCodexCredential } from "../src/server/codex-credentials"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { prepareProviderRequest, proxyToProvider } from "../src/server/gateway/transport"
import type { ResolvedGatewayModel } from "../src/server/gateway/model-resolution"
import { sessionPromptCacheScope } from "../src/server/gateway/prompt-cache"
import { GatewayRetry } from "../src/server/gateway/retry"
import { proxyGatewayRequestInWorkspace } from "../src/server/gateway/gateway"

const workspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
const originalFetch = globalThis.fetch
let sequence = 0

async function makeModel(key: string) {
  const provider = await upsertProvider({ name: key, prefix: `affinity${++sequence}`, baseUrl: `https://${key}.invalid/v1`, protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
  await upsertProviderApiKey(provider.id, { name: key, key, enabled: true, maxConcurrency: 1, priority: 10 })
  const modelId = `${key}/model`
  await upsertModel(provider.id, { gatewayModelId: modelId, name: key, upstreamModel: modelId, enabled: true })
  return { provider, modelId }
}

async function invoke(model: string, large: boolean, signal?: AbortSignal) {
  return runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(new Request("http://gateway.test/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "x".repeat(large ? 330_000 : 1) }] }),
  }), "/v1/chat/completions", { id: "affinity-key" }))
}

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  _resetMemoryBackend()
  configurePlatformServer({ identity: { initialize: () => {}, changed: () => {} }, participants: [] })
  await resetWorkspacesForTests()
  resumeGatewayExecutions()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  resumeGatewayExecutions()
  await closeLocalDatabase()
  await resetWorkspacesForTests()
  _resetMemoryBackend()
})

for (const crossMember of [false, true]) for (const large of [false, true]) {
  test(`${crossMember ? "combo member" : "credential"} ${large ? "long probe" : "short rotation"}`, async () => {
    const model = await runInWorkspace(workspace, async () => {
      const first = await makeModel("a")
      if (crossMember) {
        const second = await makeModel("b")
        await upsertCombo({ combo: "route", name: "route", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
        return "route"
      }
      await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true, maxConcurrency: 1 })
      return first.modelId
    })
    const calls: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("authorization")!)
      if (calls.length < (large ? 3 : 2)) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "600" } })
      return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }) as typeof fetch
    const before = await runInWorkspace(workspace, () => listUsageEvents())
    const response = await invoke(model, large)
    expect(response.status).toBe(200)
    expect(calls).toEqual(large ? ["Bearer a", "Bearer a", "Bearer b"] : ["Bearer a", "Bearer b"])
    const events = await runInWorkspace(workspace, () => listUsageEvents())
    expect(events.filter(event => event.requestFinal).length - before.filter(event => event.requestFinal).length).toBe(1)
  })
}


test("hint-free credential walk wraps A B C A", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true, priority: 5 })
    await upsertProviderApiKey(first.provider.id, { name: "c", key: "c", enabled: true })
    return first.modelId
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 4 ? Response.json({ choices: [] }) : Response.json({ error: "unavailable" }, { status: 503 })
  }) as typeof fetch
  expect((await invoke(model, false)).status).toBe(200)
  expect(calls).toEqual(["Bearer a", "Bearer b", "Bearer c", "Bearer a"])
})

for (const drain of [false, true]) test(`${drain ? "drain" : "abort"} during probe settles only the completed attempt`, async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true })
    return first.modelId
  })
  const controller = new AbortController()
  let calls = 0
  let reached!: () => void
  const sleeping = new Promise<void>(resolve => { reached = resolve })
  const original = GatewayRetry.prototype.waitForProbe
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(function (this: GatewayRetry, key, signal, keys) {
    reached()
    return original.call(this, key, signal, keys)
  })
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "600" } }) }) as unknown as typeof fetch
  const before = await runInWorkspace(workspace, () => listUsageEvents())
  try {
    const response = invoke(model, true, controller.signal)
    await sleeping
    if (drain) {
      const draining = drainGatewayExecutions()
      expect((await response).status).toBe(429)
      await draining
    } else {
      controller.abort()
      await expect(response).rejects.toBeDefined()
    }
    const events = await runInWorkspace(workspace, () => listUsageEvents())
    expect(calls).toBe(1)
    expect(events.length - before.length).toBe(1)
    expect(events.filter(event => event.requestFinal).length - before.filter(event => event.requestFinal).length).toBe(1)
  } finally { wait.mockRestore() }
})


test("probe boundary releases lease before fresh admission", async () => {
  let providerId = ""
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    providerId = first.provider.id
    await upsertProviderApiKey(providerId, { name: "b", key: "b", enabled: true })
    return first.modelId
  })
  const original = GatewayRetry.prototype.waitForProbe
  let inspected = false
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(async function (this: GatewayRetry, key, signal, keys) {
    const credentials = await runInWorkspace(workspace, () => listProviderApiKeys(providerId))
    const admission = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId, credentials, requiredCredentialId: credentials.find(item => item.key === "a")!.id })
    expect(admission.ok).toBe(true)
    if (admission.ok) admission.cancelBeforeDispatch()
    inspected = true
    return original.call(this, key, signal, keys)
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length < 3 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })
  }) as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(inspected).toBe(true)
    expect(calls).toEqual(["Bearer a", "Bearer a", "Bearer b"])
  } finally { wait.mockRestore() }
})

test("removed preferred credential yields to alternate after one sleep", async () => {
  let providerId = ""
  let credentialId = ""
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    providerId = first.provider.id
    credentialId = (await listProviderApiKeys(providerId)).find(item => item.key === "a")!.id
    await upsertProviderApiKey(providerId, { name: "b", key: "b", enabled: true })
    return first.modelId
  })
  const original = GatewayRetry.prototype.waitForProbe
  let sleeps = 0
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(async function (this: GatewayRetry, key, signal, keys) {
    sleeps++
    const result = await original.call(this, key, signal, keys)
    await runInWorkspace(workspace, () => deleteProviderApiKey(providerId, credentialId))
    return result
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 1 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })
  }) as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(calls).toEqual(["Bearer a", "Bearer b"])
    expect(sleeps).toBe(1)
  } finally { wait.mockRestore() }
})

test("combo probe supplies ready alternate for allowance accounting", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    const second = await makeModel("b")
    await upsertCombo({ combo: "route", name: "route", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
    return "route"
  })
  const original = GatewayRetry.prototype.waitForProbe
  let keys: string[] | undefined
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(function (this: GatewayRetry, key, signal, alternatives) {
    keys = alternatives
    return original.call(this, key, signal, alternatives)
  })
  let calls = 0
  globalThis.fetch = (async () => ++calls < 3 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })) as unknown as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(keys).toHaveLength(2)
  } finally { wait.mockRestore() }
})


test("Codex one-shot probe sends the same account before alternate", async () => {
  const target = await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({ name: "Codex", prefix: "codex", baseUrl: "https://chatgpt.com/backend-api/codex", protocol: "openai-responses", authType: "bearer", headers: {}, enabled: true })
    const accounts = []
    for (const name of ["a", "b"]) {
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: name } })).toString("base64url")
      accounts.push(await registerCodexCredential(provider.id, { accountId: name, name, secrets: { accessToken: `token-${name}`, refreshToken: `refresh-${name}`, idToken: `e30.${payload}.sig`, expiresAt: new Date(Date.now() + 60_000).toISOString() } }))
    }
    return { upstreamModel: "gpt-5", upstreamProtocol: "openai-responses", pricingGatewayModelId: "codex/gpt-5", modelName: "GPT-5", providerId: provider.id, providerPrefix: "codex", promptCacheKey: true, reasoningSummaries: false, upstream: { baseUrl: provider.baseUrl, protocol: "openai-responses", authType: "bearer", headers: {}, apiKeys: accounts, codex: true } } satisfies ResolvedGatewayModel
  })
  let now = 0
  const retry = new GatewayRetry({ inputTokens: 80_000, now: () => now, random: () => 0, wait: async ms => { now += ms } })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json({ object: "list", data: [] })
    calls.push(new Headers(init.headers).get("authorization")!)
    return calls.length < 3 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : new Response("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-done\",\"output\":[]}}\n\n", { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-5", input: "hello" }))
  const invokeCodex = (probeKey?: string) => runInWorkspace(workspace, () => proxyToProvider(new Request("http://gateway.test/v1/responses", { method: "POST", body }), target, prepareProviderRequest(body, target, "openai-responses"), "openai-responses", { workspaceId: workspace.id, gatewayKeyId: "codex-probe" }, undefined, retry, probeKey))
  try {
    const first = await invokeCodex()
    expect(first.probe).toBeDefined()
    expect(await retry.waitForProbe(first.probe!.key, new AbortController().signal, first.probe!.memberKeys)).toBe(true)
    const second = await invokeCodex(first.probe!.key)
    expect(second.response.status).toBe(200)
    expect(calls).toEqual(["Bearer token-a", "Bearer token-a", "Bearer token-b"])
  } finally { await closeLocalCache() }
})


test("24th failure stops without another probe wait", async () => {
  const model = await runInWorkspace(workspace, async () => (await makeModel("a")).modelId)
  const originalWait = GatewayRetry.prototype.waitForProbe
  const originalRound = GatewayRetry.prototype.nextRound
  let clock = Date.now()
  const now = spyOn(Date, "now").mockImplementation(() => clock)
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(function (this: GatewayRetry, key, signal, keys) {
    clock += 61_000
    return originalWait.call(this, key, signal, keys)
  })
  const round = spyOn(GatewayRetry.prototype, "nextRound").mockImplementation(function (this: GatewayRetry, signal) {
    clock += 61_000
    return originalRound.call(this, signal)
  })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "1" } }) }) as unknown as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(503)
    expect(calls).toBe(24)
  } finally { wait.mockRestore(); round.mockRestore(); now.mockRestore() }
})


test("hint-free combo resumes rotation after a multi-key member", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true })
    const second = await makeModel("c")
    await upsertCombo({ combo: "route", name: "route", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
    return "route"
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 6 ? Response.json({ choices: [] }) : Response.json({ error: "unavailable" }, { status: 503 })
  }) as typeof fetch
  expect((await invoke(model, false)).status).toBe(200)
  expect(calls).toEqual(["Bearer a", "Bearer b", "Bearer c", "Bearer a", "Bearer b", "Bearer c"])
})


test("member reservation release occurs before probe wait", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true })
    return first.modelId
  })
  let releases = 0
  const originalRelease = analytics.releaseBudgetReservation
  const release = spyOn(analytics, "releaseBudgetReservation").mockImplementation(async reservation => {
    releases++
    await originalRelease(reservation)
  })
  const originalWait = GatewayRetry.prototype.waitForProbe
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(function (this: GatewayRetry, key, signal, keys) {
    expect(releases).toBe(1)
    return originalWait.call(this, key, signal, keys)
  })
  let calls = 0
  globalThis.fetch = (async () => ++calls < 3 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })) as unknown as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(releases).toBe(2)
  } finally { wait.mockRestore(); release.mockRestore() }
})


test("locally denied preferred credential yields to ready alternate", async () => {
  let providerId = ""
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    providerId = first.provider.id
    await upsertProviderApiKey(providerId, { name: "b", key: "b", enabled: true })
    return first.modelId
  })
  const original = GatewayRetry.prototype.waitForProbe
  let release: (() => void) | undefined
  let waits = 0
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockImplementation(async function (this: GatewayRetry, key, signal, keys) {
    waits++
    const result = await original.call(this, key, signal, keys)
    const credentials = await runInWorkspace(workspace, () => listProviderApiKeys(providerId))
    const admission = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId, credentials, requiredCredentialId: credentials.find(item => item.key === "a")!.id })
    expect(admission.ok).toBe(true)
    if (admission.ok) release = admission.cancelBeforeDispatch
    return result
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 1 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })
  }) as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(calls).toEqual(["Bearer a", "Bearer b"])
    expect(waits).toBe(1)
  } finally { release?.(); wait.mockRestore() }
})

test("completed redirect rotates, but rejected fetch never replays", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true })
    return first.modelId
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    expect(init?.redirect).toBe("manual")
    if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "https://elsewhere.invalid" } })
    throw new Error("connection lost")
  }) as typeof fetch
  const result = await invoke(model, false)
  expect(result.status).toBe(502)
  expect((await result.json() as { error: { code: string } }).error.code).toBe("provider_request_outcome_unknown")
  expect(calls).toEqual(["Bearer a", "Bearer b"])
})


test("combo probe declined at allowance boundary continues the yielding member", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const first = await makeModel("a")
    await upsertProviderApiKey(first.provider.id, { name: "b", key: "b", enabled: true })
    const second = await makeModel("c")
    await upsertCombo({ combo: "route", name: "route", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
    return "route"
  })
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe").mockResolvedValue(false)
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 1 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })
  }) as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(calls).toEqual(["Bearer a", "Bearer b"])
  } finally { wait.mockRestore() }
})


test("untouched later combo member retains prebound session credential", async () => {
  const second = await runInWorkspace(workspace, async () => {
    const first = await makeModel("first")
    const next = await makeModel("b")
    const preferred = await upsertProviderApiKey(next.provider.id, { name: "c", key: "c", enabled: true })
    await upsertCombo({ combo: "route", name: "route", members: [{ modelId: first.modelId }, { modelId: next.modelId }] })
    return { ...next, preferred }
  })
  const headers = new Headers({ "session-id": "prebound-session" })
  const credentials = await runInWorkspace(workspace, () => listProviderApiKeys(second.provider.id))
  const admission = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId: second.provider.id, credentials, sessionScopeHash: sessionPromptCacheScope(headers, workspace.id, "affinity-key"), requiredCredentialId: second.preferred.id })
  expect(admission.ok).toBe(true)
  if (admission.ok) { admission.markDispatched(); admission.release() }
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ choices: [] })
  }) as typeof fetch
  const response = await runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(new Request("http://gateway.test/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify({ model: "route", messages: [{ role: "user", content: "hello" }] }),
  }), "/v1/chat/completions", { id: "affinity-key" }))
  expect(response.status).toBe(200)
  expect(calls).toEqual(["Bearer first", "Bearer c"])
})


test("RPM-blocked preferred credential yields to ready alternate without affinity sleep", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({ name: "rpm", prefix: `affinity${++sequence}`, baseUrl: "https://rpm.invalid/v1", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
    await upsertProviderApiKey(provider.id, { name: "a", key: "a", enabled: true, priority: 10, rpmLimit: 1 })
    await upsertProviderApiKey(provider.id, { name: "b", key: "b", enabled: true })
    await upsertModel(provider.id, { gatewayModelId: "rpm/model", name: "rpm", upstreamModel: "rpm/model", enabled: true })
    return "rpm/model"
  })
  const wait = spyOn(GatewayRetry.prototype, "waitForProbe")
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization")!)
    return calls.length === 1 ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })
  }) as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(calls).toEqual(["Bearer a", "Bearer b"])
    expect(wait).not.toHaveBeenCalled()
  } finally { wait.mockRestore() }
})


test("scheduler capacity snapshot respects active leases and rolling RPM without mutation", () => {
  let now = 0
  const scheduler = createProviderCredentialScheduler({ now: () => now })
  const credential = { id: "a", providerId: "provider", name: "a", key: "secret", enabled: true, createdAt: "2025-01-01T00:00:00Z", rpmLimit: 1, maxConcurrency: 1 }
  const input = { ownerWorkspaceId: "owner", providerId: "provider", credential }
  expect(scheduler.isAdmissible(input)).toBe(true)
  expect(scheduler.isAdmissible(input)).toBe(true)
  const lease = scheduler.acquire({ ...input, credentials: [credential] })
  expect(lease.ok).toBe(true)
  if (!lease.ok) throw new Error("Expected admission")
  expect(scheduler.isAdmissible(input)).toBe(false)
  expect(scheduler.isAdmissible({ ...input, ownerWorkspaceId: "other" })).toBe(true)
  expect(scheduler.isAdmissible({ ...input, providerId: "other" })).toBe(true)
  lease.markDispatched()
  lease.release()
  expect(scheduler.isAdmissible(input)).toBe(false)
  now = 60_000
  expect(scheduler.isAdmissible(input)).toBe(true)
  const next = scheduler.acquire({ ...input, credentials: [credential] })
  expect(next.ok).toBe(true)
  if (next.ok) next.cancelBeforeDispatch()
})


test("unavailable probe is checked after member reservation release", async () => {
  const model = await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({ name: "rpm", prefix: `affinity${++sequence}`, baseUrl: "https://rpm.invalid/v1", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
    await upsertProviderApiKey(provider.id, { name: "a", key: "a", enabled: true, priority: 10, rpmLimit: 1 })
    await upsertProviderApiKey(provider.id, { name: "b", key: "b", enabled: true })
    await upsertModel(provider.id, { gatewayModelId: "rpm/model", name: "rpm", upstreamModel: "rpm/model", enabled: true })
    return "rpm/model"
  })
  let releases = 0
  const originalRelease = analytics.releaseBudgetReservation
  const release = spyOn(analytics, "releaseBudgetReservation").mockImplementation(async reservation => { releases++; await originalRelease(reservation) })
  const originalCheck = providerCredentialScheduler.isAdmissible
  const check = spyOn(providerCredentialScheduler, "isAdmissible").mockImplementation(input => {
    expect(releases).toBe(1)
    return originalCheck(input)
  })
  let calls = 0
  globalThis.fetch = (async () => ++calls === 1 ? Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "600" } }) : Response.json({ choices: [] })) as unknown as typeof fetch
  try {
    expect((await invoke(model, true)).status).toBe(200)
    expect(check).toHaveBeenCalledTimes(1)
  } finally { check.mockRestore(); release.mockRestore() }
})
