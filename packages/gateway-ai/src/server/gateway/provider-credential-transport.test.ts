import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { closeLocalDatabase, getDatabase } from "@rawroute/platform/server/database"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { _resetMemoryBackend, deleteProvider, deleteProviderApiKey, getProvider, getProviderCredentialRoutingSnapshot, upsertProvider, upsertProviderApiKey, withProviderCredentialRoutingSnapshot } from "../store"
import { normalizeRoutingFailure } from "./gateway"
import type { Protocol } from "../../contracts/domain"
import type { ResolvedGatewayModel } from "./model-resolution"
import { createProviderCredentialScheduler, type ProviderCredentialScheduler } from "./provider-credential-scheduler"
import { prepareProviderRequest, proxyToProvider } from "./transport"

const encoder = new TextEncoder()
const ownerWorkspace = { id: "provider-credential-owner", storageMode: "scoped" as const }
const caller = { workspaceId: "provider-credential-consumer", gatewayKeyId: "gateway-key-one" }
const originalFetch = globalThis.fetch

let providerId: string
let resolved: ResolvedGatewayModel
let scheduler: ProviderCredentialScheduler
let now: number
let providerSequence = 0

async function setupProvider(keys: Array<{ name: string; key: string; rpmLimit?: number; maxConcurrency?: number; priority?: number }>) {
  const provider = await upsertProvider({
    name: "Synthetic Responses Provider",
    prefix: `synthetic${++providerSequence}`,
    baseUrl: "https://responses.synthetic.invalid",
    protocol: "openai-responses",
    authType: "bearer",
    headers: {},
    enabled: true,
  })
  providerId = provider.id
  const credentials = []
  for (const input of keys) credentials.push(await upsertProviderApiKey(providerId, { ...input, enabled: true }))
  resolved = {
    upstreamModel: "synthetic/model",
    upstreamProtocol: "openai-responses",
    pricingGatewayModelId: "synthetic/model",
    modelName: "Synthetic model",
    providerId,
    providerPrefix: provider.prefix,
    promptCacheKey: false,
    upstream: {
      baseUrl: provider.baseUrl,
      protocol: "openai-responses",
      authType: "bearer",
      headers: {},
      apiKeys: credentials,
      codex: false,
    },
  }
}

async function invoke(payload: Record<string, unknown>, headers: Record<string, string> = {}, callerIdentity = caller, model = resolved, signal?: AbortSignal) {
  const body = encoder.encode(JSON.stringify(payload))
  const request = new Request("http://rawroute.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    ...(signal ? { signal } : {}),
  })
  const prepared = prepareProviderRequest(body, model, "openai-responses")
  return runInWorkspace(ownerWorkspace, () => proxyToProvider(request, model, prepared, "openai-responses", callerIdentity, scheduler))
}

function jsonResponse(id: string, outputId = `${id}-item`) {
  return Response.json({ id, output: [{ id: outputId, type: "message", role: "assistant", content: [] }] })
}

function requestForProtocol(protocol: Protocol) {
  if (protocol === "openai-chat") return { model: "synthetic/model", messages: [{ role: "user", content: "hello" }], max_completion_tokens: 16 }
  if (protocol === "anthropic-messages") return { model: "synthetic/model", max_tokens: 16, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
  return { model: "synthetic/model", input: "hello" }
}

function responseForProtocol(protocol: Protocol) {
  if (protocol === "openai-chat") return {
    id: "chatcmpl-synthetic", object: "chat.completion", created: 1, model: "synthetic/model",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  if (protocol === "anthropic-messages") return {
    id: "msg_synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "hello" }],
    model: "synthetic/model", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  return {
    id: "resp_synthetic", object: "response", status: "completed", model: "synthetic/model",
    output: [{ id: "item_synthetic", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
}

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  _resetMemoryBackend()
  now = 0
  scheduler = createProviderCredentialScheduler({ now: () => now })
  await runInWorkspace(ownerWorkspace, async () => {
    await setupProvider([{ name: "First", key: "synthetic-key-first" }, { name: "Second", key: "synthetic-key-second" }])
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await closeLocalDatabase()
  Object.assign(process.env, { STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  _resetMemoryBackend()
})

describe("ordinary provider credential transport", () => {
  test("reads provider enablement and credentials from one fresh SQLite snapshot", async () => {
    await closeLocalDatabase()
    Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: ":memory:" })
    _resetMemoryBackend()
    let credentialId = ""
    await runInWorkspace(ownerWorkspace, async () => {
      await setupProvider([{ name: "SQLite credential", key: "sqlite-current-key" }])
      credentialId = resolved.upstream!.apiKeys[0]!.id
      const snapshot = await getProviderCredentialRoutingSnapshot(providerId)
      expect(snapshot.provider?.enabled).toBe(true)
      expect(snapshot.apiKeys.map((credential) => credential.id)).toEqual([credentialId])
      let updateCommitted = false
      let update: Promise<unknown> | undefined
      let writeWasBlockedInsideSnapshot = false
      const dispatchSnapshot = await withProviderCredentialRoutingSnapshot(providerId, (current) => {
        update = upsertProvider({ originalId: providerId, baseUrl: "https://committed-after-dispatch.synthetic.invalid/v1" }).then((value) => {
          updateCommitted = true
          return value
        })
        writeWasBlockedInsideSnapshot = !updateCommitted
        return current
      })
      expect(writeWasBlockedInsideSnapshot).toBe(true)
      expect(dispatchSnapshot.provider?.baseUrl).toBe(resolved.upstream!.baseUrl)
      await update
      expect((await getProviderCredentialRoutingSnapshot(providerId)).provider?.baseUrl).toBe("https://committed-after-dispatch.synthetic.invalid/v1")
      await upsertProviderApiKey(providerId, { originalId: credentialId, enabled: false })
      const updated = await getProviderCredentialRoutingSnapshot(providerId)
      expect(updated.apiKeys[0]?.enabled).toBe(false)
    })
  })

  test("does not dispatch if the credential snapshot transaction fails to commit", async () => {
    await closeLocalDatabase()
    Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: ":memory:" })
    _resetMemoryBackend()
    await runInWorkspace(ownerWorkspace, () => setupProvider([{ name: "SQLite dispatch", key: "sqlite-dispatch-key", rpmLimit: 1 }]))
    scheduler = createProviderCredentialScheduler({ now: () => now })
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return jsonResponse("must-not-dispatch")
    }) as unknown as typeof fetch

    const database = getDatabase()
    const run = database.run.bind(database)
    let failCommit = true
    const runSpy = spyOn(database, "run").mockImplementation((query, ...bindings) => {
      if (query === "COMMIT" && failCommit) {
        failCommit = false
        throw new Error("injected SQLite commit failure")
      }
      return run(query, ...bindings)
    })
    try {
      const response = await invoke({ model: "synthetic/model", input: "commit failure" })
      expect(response.response.status).toBe(503)
      expect((await response.response.json()).error.code).toBe("provider_configuration_unavailable")
      expect(fetchCalls).toBe(0)
      expect(failCommit).toBe(false)
    } finally {
      runSpy.mockRestore()
    }

    const reusable = await runInWorkspace(ownerWorkspace, () => scheduler.acquire({
      ownerWorkspaceId: ownerWorkspace.id,
      providerId,
      credentials: resolved.upstream!.apiKeys,
    }))
    expect(reusable.ok).toBe(true)
    if (reusable.ok) reusable.release()
  })

  test("commits before dispatch and releases the database queue while the upstream is pending", async () => {
    await closeLocalDatabase()
    Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: ":memory:" })
    _resetMemoryBackend()
    await runInWorkspace(ownerWorkspace, () => setupProvider([{ name: "SQLite dispatch", key: "sqlite-live-key" }]))
    scheduler = createProviderCredentialScheduler({ now: () => now })

    const database = getDatabase()
    const run = database.run.bind(database)
    let commitCompleted = false
    const runSpy = spyOn(database, "run").mockImplementation((query, ...bindings) => {
      const result = run(query, ...bindings)
      if (query === "COMMIT") commitCompleted = true
      return result
    })
    let markFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve })
    let finishFetch!: (response: Response) => void
    const upstreamPending = new Promise<Response>((resolve) => { finishFetch = resolve })
    let wasCommittedAtDispatch = false
    let dispatchedUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      wasCommittedAtDispatch = commitCompleted
      dispatchedUrl = String(input)
      markFetchStarted()
      return upstreamPending
    }) as unknown as typeof fetch

    const requestPending = invoke({ model: "synthetic/model", input: "hold response" })
    await fetchStarted
    runSpy.mockRestore()
    const providerUpdate = runInWorkspace(ownerWorkspace, () => upsertProvider({
      originalId: providerId,
      baseUrl: "https://new-config.synthetic.invalid/v1",
    }))
    let timeout: ReturnType<typeof setTimeout> | undefined
    const updateFinished = await Promise.race([
      providerUpdate.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 1_000) }),
    ])
    if (timeout) clearTimeout(timeout)
    finishFetch(jsonResponse("sqlite-pending-response"))
    await providerUpdate
    const result = await requestPending
    expect(wasCommittedAtDispatch).toBe(true)
    expect(updateFinished).toBe(true)
    expect(dispatchedUrl).toContain("responses.synthetic.invalid")
    expect(result.response.status).toBe(200)
  })

  test("does not send a rotated secret to a stale provider endpoint", async () => {
    const oldModel = structuredClone(resolved)
    const oldProvider = await runInWorkspace(ownerWorkspace, () => getProvider(providerId))
    const oldCredential = oldModel.upstream!.apiKeys[0]!
    await runInWorkspace(ownerWorkspace, async () => {
      await upsertProvider({ originalId: providerId, baseUrl: "https://replacement.synthetic.invalid/v1", authType: "x-api-key", headers: { "x-provider-generation": "new" } })
      await upsertProviderApiKey(providerId, { originalId: oldCredential.id, key: "replacement-secret" })
    })

    const sent: Array<{ url: string; authorization: string | null; apiKey: string | null }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      sent.push({ url: String(input), authorization: headers.get("authorization"), apiKey: headers.get("x-api-key") })
      return jsonResponse("must-not-send")
    }) as unknown as typeof fetch
    const stale = await invoke({ model: "synthetic/model", input: "stale resolution" }, {}, caller, oldModel)
    expect(stale.response.status).toBe(503)
    expect((await stale.response.json()).error.code).toBe("provider_configuration_changed")
    expect(sent).toHaveLength(0)

    await runInWorkspace(ownerWorkspace, async () => {
      await upsertProvider({
        originalId: providerId,
        baseUrl: oldProvider!.baseUrl,
        protocol: oldProvider!.protocol,
        authType: oldProvider!.authType,
        headers: oldProvider!.headers,
        supportPromptCacheKey: oldProvider!.supportPromptCacheKey,
        enabled: oldProvider!.enabled,
      })
      await upsertProviderApiKey(providerId, { originalId: oldCredential.id, key: oldCredential.key })
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      sent.push({ url: String(input), authorization: headers.get("authorization"), apiKey: headers.get("x-api-key") })
      const used = oldModel.upstream!.apiKeys.find((credential) => `Bearer ${credential.key}` === headers.get("authorization"))!
      await runInWorkspace(ownerWorkspace, async () => {
        await upsertProvider({ originalId: providerId, baseUrl: "https://replacement.synthetic.invalid/v1", authType: "x-api-key", headers: { "x-provider-generation": "new" } })
        await upsertProviderApiKey(providerId, { originalId: used.id, key: "replacement-secret" })
      })
      return Response.json({ error: { message: "The old endpoint rejected its original key." } }, { status: 401 })
    }) as unknown as typeof fetch
    const changedDuringAttempt = await invoke({ model: "synthetic/model", input: "config changed during fallback" }, {}, caller, oldModel)
    expect(changedDuringAttempt.response.status).toBe(401)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toContain("responses.synthetic.invalid")
    expect(sent[0]!.authorization).not.toBeNull()
    expect(oldModel.upstream!.apiKeys.map((credential) => `Bearer ${credential.key}`)).toContain(sent[0]!.authorization!)
    expect(sent[0]!.apiKey).toBeNull()
    expect(JSON.stringify(sent)).not.toContain("replacement-secret")
  })

  test("balances caller sessions, preserves same-session affinity, and leaves no-header routing on saved order", async () => {
    const calls: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return jsonResponse(`response-${calls.length}`)
    }) as unknown as typeof fetch

    await invoke({ model: "synthetic/model", input: "one" }, { "session-id": "session-a" })
    await invoke({ model: "synthetic/model", input: "two" }, { "session-id": "session-b" })
    await invoke({ model: "synthetic/model", input: "three" }, { "session-id": "session-a" })
    await invoke({ model: "synthetic/model", input: "without-session" })
    await invoke({ model: "synthetic/model", input: "without-session-again" })

    expect(calls[0]!.authorization).not.toBe(calls[1]!.authorization)
    expect(calls[0]!.authorization).toBe(calls[2]!.authorization)
    expect(calls[3]!.authorization).toBe(calls[4]!.authorization)
    expect(calls[0]!.body).not.toHaveProperty("prompt_cache_key")
  })

  test("preserves each client/upstream protocol conversion path", async () => {
    for (const clientProtocol of ["openai-chat", "anthropic-messages", "openai-responses"] as const) {
      for (const upstreamProtocol of ["openai-chat", "anthropic-messages", "openai-responses"] as const) {
        if (clientProtocol === upstreamProtocol) continue
        await runInWorkspace(ownerWorkspace, () => upsertProvider({ originalId: providerId, protocol: upstreamProtocol }))
        const model: ResolvedGatewayModel = {
          ...resolved,
          upstreamProtocol,
          upstream: { ...resolved.upstream!, protocol: upstreamProtocol },
        }
        globalThis.fetch = (async () => Response.json(responseForProtocol(upstreamProtocol))) as unknown as typeof fetch
        const body = encoder.encode(JSON.stringify(requestForProtocol(clientProtocol)))
        const request = new Request(`http://rawroute.test/${clientProtocol}`, { method: "POST", body, headers: { "content-type": "application/json" } })
        const prepared = prepareProviderRequest(body, model, clientProtocol)
        const result = await runInWorkspace(ownerWorkspace, () => proxyToProvider(request, model, prepared, clientProtocol, caller, scheduler))
        expect(result.response.status).toBe(200)
        expect((await result.response.text()).length).toBeGreaterThan(0)
      }
    }
  })

  test("keeps converted Responses streams intact while observing upstream completion", async () => {
    await runInWorkspace(ownerWorkspace, () => upsertProvider({ originalId: providerId, protocol: "openai-chat" }))
    const model: ResolvedGatewayModel = {
      ...resolved,
      upstreamProtocol: "openai-chat",
      upstream: { ...resolved.upstream!, protocol: "openai-chat" },
    }
    const frames = [
      `data: ${JSON.stringify({ id: "chat-stream", object: "chat.completion.chunk", created: 1, model: "synthetic/model", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-stream", object: "chat.completion.chunk", created: 1, model: "synthetic/model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-stream", object: "chat.completion.chunk", created: 1, model: "synthetic/model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")
    globalThis.fetch = (async () => new Response(encoder.encode(frames), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch
    const payload = { ...requestForProtocol("openai-responses"), stream: true }
    const body = encoder.encode(JSON.stringify(payload))
    const request = new Request("http://rawroute.test/v1/responses", { method: "POST", body, headers: { "content-type": "application/json" } })
    const prepared = prepareProviderRequest(body, model, "openai-responses")
    const result = await runInWorkspace(ownerWorkspace, () => proxyToProvider(request, model, prepared, "openai-responses", caller, scheduler))
    const streamed = await result.response.text()
    await result.streamUsage
    expect(result.response.status).toBe(200)
    expect(streamed).toContain("response.output_text.delta")
    expect(streamed).toContain("response.completed")
  })

  test("pins JSON and streamed Responses continuations to the issuing credential", async () => {
    const authorizations: Array<string | null> = []
    let requestNumber = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"))
      requestNumber++
      if (requestNumber === 1) return jsonResponse("json-response", "json-item")
      if (requestNumber === 4) {
        const frames = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "stream-response" } })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { id: "stream-item" } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "stream-response", status: "completed", output: [{ id: "stream-item" }] } })}\n\n`,
        ].join("")
        return new Response(encoder.encode(frames), { headers: { "content-type": "text/event-stream" } })
      }
      return jsonResponse(`follow-up-${requestNumber}`)
    }) as unknown as typeof fetch

    const json = await invoke({ model: "synthetic/model", input: "start" })
    const jsonCredential = authorizations[0]
    await json.response.text()
    const fromJsonResponse = await invoke({ model: "synthetic/model", previous_response_id: "json-response", input: "continue" })
    const fromJsonItem = await invoke({ model: "synthetic/model", input: [{ type: "item_reference", id: "json-item" }] })
    const streamed = await invoke({ model: "synthetic/model", input: "stream-start", stream: true }, { "session-id": "stream-origin" })
    await streamed.response.text()
    await invoke({ model: "synthetic/model", input: "bind another session" }, { "session-id": "session-b" })
    await invoke({ model: "synthetic/model", input: "bind one more session" }, { "session-id": "session-c" })
    const fromStreamResponse = await invoke({ model: "synthetic/model", previous_response_id: "stream-response", input: "continue" }, { "session-id": "session-d" })
    const fromStreamItem = await invoke({ model: "synthetic/model", input: [{ type: "item_reference", id: "stream-item" }] }, { "session-id": "session-e" })

    expect([authorizations[1], authorizations[2]]).toEqual([jsonCredential, jsonCredential])
    expect(authorizations[4]).not.toBe(authorizations[3])
    expect(authorizations[5]).toBe(authorizations[3])
    expect([authorizations[6], authorizations[7]]).toEqual([authorizations[3], authorizations[3]])
    expect(fromJsonResponse.response.ok).toBe(true)
    expect(fromJsonItem.response.ok).toBe(true)
    expect(fromStreamResponse.response.ok).toBe(true)
    expect(fromStreamItem.response.ok).toBe(true)
  })

  test("fails closed for unknown, conflicting, cross-caller, and revoked continuation references", async () => {
    const authorizations: Array<string | null> = []
    let id = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"))
      return jsonResponse(`known-${++id}`, `item-${id}`)
    }) as unknown as typeof fetch

    await invoke({ model: "synthetic/model", input: "A" }, { "session-id": "session-a" })
    await invoke({ model: "synthetic/model", input: "B" }, { "session-id": "session-b" })
    const beforeInvalid = authorizations.length
    const conflicting = await invoke({ model: "synthetic/model", previous_response_id: "known-1", input: [{ type: "item_reference", id: "item-2" }] })
    const unknown = await invoke({ model: "synthetic/model", previous_response_id: "not-captured" })
    const otherCaller = await invoke({ model: "synthetic/model", previous_response_id: "known-1" }, {}, { ...caller, gatewayKeyId: "different-gateway-key" })
    expect(conflicting.response.status).toBe(400)
    expect(unknown.response.status).toBe(503)
    expect(otherCaller.response.status).toBe(503)
    expect(authorizations).toHaveLength(beforeInvalid)

    const firstKey = authorizations[0]!.replace("Bearer ", "")
    const snapshot = await runInWorkspace(ownerWorkspace, async () => {
      return getProviderCredentialRoutingSnapshot(providerId)
    })
    const issuingCredential = snapshot.apiKeys.find((credential) => credential.key === firstKey)!
    await runInWorkspace(ownerWorkspace, () => upsertProviderApiKey(providerId, { originalId: issuingCredential.id, key: "rotated-current-key" }))
    const rotated = await invoke({ model: "synthetic/model", previous_response_id: "known-1" })
    expect(rotated.response.status).toBe(503)
    expect(authorizations).toHaveLength(beforeInvalid)
    await runInWorkspace(ownerWorkspace, () => deleteProviderApiKey(providerId, issuingCredential.id))
    const revoked = await invoke({ model: "synthetic/model", previous_response_id: "known-1" })
    expect(revoked.response.status).toBe(503)
    expect(authorizations).toHaveLength(beforeInvalid)
  })

  test("fails closed when bounded continuation state evicts an older response", async () => {
    let id = 0
    globalThis.fetch = (async () => jsonResponse(`evict-${++id}`)) as unknown as typeof fetch
    await invoke({ model: "synthetic/model", input: "first" })
    for (let index = 0; index < 2_050; index++) await invoke({ model: "synthetic/model", input: "evict" })
    const beforeContinuation = id
    const evicted = await invoke({ model: "synthetic/model", previous_response_id: "evict-1" })
    expect(evicted.response.status).toBe(503)
    expect(id).toBe(beforeContinuation)
  })

  test("fails closed for a continuation after a process restart", async () => {
    globalThis.fetch = (async () => jsonResponse("captured-before-restart")) as unknown as typeof fetch
    const original = await invoke({ model: "synthetic/model", input: "before restart" })
    await original.response.text()

    const resolvedJson = JSON.stringify(resolved)
    const callerJson = JSON.stringify(caller)
    const workspaceJson = JSON.stringify(ownerWorkspace)
    const transportUrl = JSON.stringify(new URL("./transport.ts", import.meta.url).href)
    const script = `
      const { proxyToProvider } = await import(${transportUrl});
      const { runInWorkspace } = await import("@rawroute/platform/server/workspace-context");
      const resolved = ${resolvedJson};
      const caller = ${callerJson};
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls++; return Response.json({ id: "unexpected" }); };
      const body = new TextEncoder().encode(JSON.stringify({ model: "synthetic/model", previous_response_id: "captured-before-restart", input: "continue" }));
      const request = new Request("http://rawroute.test/v1/responses", { method: "POST", body, headers: { "content-type": "application/json" } });
      const result = await runInWorkspace(${workspaceJson}, () => proxyToProvider(request, resolved, { body }, "openai-responses", caller));
      console.log(JSON.stringify({ status: result.response.status, body: await result.response.json(), fetchCalls }));
    `
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", STORAGE_BACKEND: "memory" },
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    const output = child.stdout.trim().split("\n").at(-1)!
    expect(JSON.parse(output)).toMatchObject({
      status: 503,
      body: { error: { code: "provider_response_continuation_unavailable" } },
      fetchCalls: 0,
    })
  })

  test("does not mix continuation state across consumer workspaces", async () => {
    let calls = 0
    globalThis.fetch = (async () => jsonResponse(`scope-${++calls}`)) as unknown as typeof fetch
    await invoke({ model: "synthetic/model", input: "consumer one" })
    const wrongWorkspace = await invoke({ model: "synthetic/model", previous_response_id: "scope-1" }, {}, { ...caller, workspaceId: "another-consumer" })
    expect(wrongWorkspace.response.status).toBe(503)
    expect(calls).toBe(1)
  })

  test("allows only definite auth/rate rejection fallback and stops on ambiguous network/body failures", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("authorization") || "")
      return calls.length === 1 ? Response.json({ error: { message: "bad credentials" } }, { status: 401 }) : jsonResponse("accepted")
    }) as unknown as typeof fetch
    const authFallback = await invoke({ model: "synthetic/model", input: "auth fallback" })
    expect(authFallback.response.status).toBe(200)
    expect(calls).toHaveLength(2)

    calls.length = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("authorization") || "")
      return calls.length === 1 ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }) : jsonResponse("rate-limit-fallback")
    }) as unknown as typeof fetch
    const rateFallback = await invoke({ model: "synthetic/model", input: "rate fallback" })
    expect(rateFallback.response.status).toBe(200)
    expect(calls).toHaveLength(2)

    await runInWorkspace(ownerWorkspace, async () => {
      _resetMemoryBackend()
      await setupProvider([{ name: "Single", key: "single-key", rpmLimit: 1 }])
    })
    scheduler = createProviderCredentialScheduler({ now: () => now })
    let ambiguousCalls = 0
    globalThis.fetch = (async () => {
      ambiguousCalls++
      throw new Error("synthetic socket failure")
    }) as unknown as typeof fetch
    const ambiguous = await invoke({ model: "synthetic/model", input: "ambiguous" })
    expect(ambiguous.response.status).toBe(502)
    expect(ambiguous.response.headers.get("x-rawroute-combo-terminal")).toBe("1")
    expect(ambiguousCalls).toBe(1)
    const next = await invoke({ model: "synthetic/model", input: "after ambiguous" })
    expect(next.response.status).toBe(429)
    expect(next.response.headers.get("retry-after")).toBe("60")
    expect(ambiguousCalls).toBe(1)
  })

  test("marks non-safe upstream responses terminal for combo routing", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return Response.json({ error: { message: "provider failed" } }, { status: 500 })
    }) as unknown as typeof fetch
    const failed = await invoke({ model: "synthetic/model", input: "server error" })
    expect(failed.response.status).toBe(500)
    expect(failed.response.headers.get("x-rawroute-combo-terminal")).toBe("1")
    expect(calls).toBe(1)
  })

  test("pre-dispatch failure refunds RPM, while local RPM blocking keeps a computed retry and normalizes as 429", async () => {
    await runInWorkspace(ownerWorkspace, async () => {
      _resetMemoryBackend()
      await setupProvider([{ name: "Single", key: "pre-send-key", rpmLimit: 1 }])
    })
    scheduler = createProviderCredentialScheduler({ now: () => now })
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      throw new TypeError("synthetic pre-dispatch rejection")
    }) as unknown as typeof fetch
    const preDispatch = await invoke({ model: "synthetic/model", input: "pre-send" })
    expect(preDispatch.response.status).toBe(503)
    expect(calls).toBe(1)
    const fresh = await runInWorkspace(ownerWorkspace, () => scheduler.acquire({
      ownerWorkspaceId: ownerWorkspace.id,
      providerId,
      credentials: resolved.upstream!.apiKeys,
    }))
    expect(fresh.ok).toBe(true)
    if (fresh.ok) fresh.cancelBeforeDispatch()

    const used = await runInWorkspace(ownerWorkspace, () => scheduler.acquire({
      ownerWorkspaceId: ownerWorkspace.id,
      providerId,
      credentials: resolved.upstream!.apiKeys,
    }))
    expect(used.ok).toBe(true)
    if (used.ok) { used.markDispatched(); used.release() }
    globalThis.fetch = (() => { calls++; return Promise.resolve(jsonResponse("should-not-send")) }) as unknown as typeof fetch
    const limited = await invoke({ model: "synthetic/model", input: "limited" })
    expect(limited.response.status).toBe(429)
    expect(limited.response.headers.get("retry-after")).toBe("60")
    expect(limited.response.headers.get("x-rawroute-combo-terminal")).toBeNull()
    expect((await normalizeRoutingFailure(limited.response.clone())).status).toBe(429)
    expect(calls).toBe(1)
  })

  test("maps mixed RPM and concurrency saturation to a local 503", async () => {
    await runInWorkspace(ownerWorkspace, async () => {
      _resetMemoryBackend()
      await setupProvider([
        { name: "RPM-limited", key: "rpm-limited-key", rpmLimit: 1, priority: 2 },
        { name: "Concurrency-limited", key: "concurrency-limited-key", maxConcurrency: 1, priority: 1 },
      ])
    })
    scheduler = createProviderCredentialScheduler({ now: () => now })
    const [rpmCredential, concurrencyCredential] = resolved.upstream!.apiKeys
    const rpmAttempt = scheduler.acquire({ ownerWorkspaceId: ownerWorkspace.id, providerId, credentials: [rpmCredential!] })
    expect(rpmAttempt.ok).toBe(true)
    if (rpmAttempt.ok) { rpmAttempt.markDispatched(); rpmAttempt.release() }
    const active = scheduler.acquire({ ownerWorkspaceId: ownerWorkspace.id, providerId, credentials: [concurrencyCredential!] })
    expect(active.ok).toBe(true)
    if (!active.ok) throw new Error("Expected to hold the synthetic concurrency lease.")
    active.markDispatched()

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return jsonResponse("must-not-dispatch")
    }) as unknown as typeof fetch
    try {
      const response = await invoke({ model: "synthetic/model", input: "mixed capacity" })
      expect(response.response.status).toBe(503)
      expect(response.response.headers.get("retry-after")).toBeNull()
      expect((await response.response.json()).error.code).toBe("provider_credential_concurrency_limit")
      expect(fetchCalls).toBe(0)
    } finally {
      active.release()
    }
  })

  test("holds concurrency through stream EOF and releases on cancellation", async () => {
    await runInWorkspace(ownerWorkspace, async () => {
      await setupProvider([{ name: "Single", key: "stream-key", maxConcurrency: 1 }])
    })
    scheduler = createProviderCredentialScheduler({ now: () => now })
    let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined
    let calls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      const source = new ReadableStream<Uint8Array>({
        start(controller) { sourceController = controller },
      })
      const signal = init?.signal
      signal?.addEventListener("abort", () => {
        try { sourceController?.error(signal.reason) } catch {}
      }, { once: true })
      return new Response(source, { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch

    const stream = await invoke({ model: "synthetic/model", input: "stream", stream: true })
    const blocked = await invoke({ model: "synthetic/model", input: "over capacity" })
    expect(blocked.response.status).toBe(503)
    expect(calls).toBe(1)
    const credential = resolved.upstream!.apiKeys[0]!
    await runInWorkspace(ownerWorkspace, () => upsertProviderApiKey(providerId, { originalId: credential.id, enabled: false }))
    const disabled = await invoke({ model: "synthetic/model", input: "after disable" })
    expect(disabled.response.status).toBe(503)
    expect(JSON.parse(await disabled.response.text()).error.code).toBe("provider_credentials_unavailable")
    await runInWorkspace(ownerWorkspace, () => upsertProviderApiKey(providerId, { originalId: credential.id, enabled: true }))
    const stillBusy = await invoke({ model: "synthetic/model", input: "after enable" })
    expect(stillBusy.response.status).toBe(503)
    expect(JSON.parse(await stillBusy.response.text()).error.code).toBe("provider_credential_concurrency_limit")
    expect(calls).toBe(1)
    sourceController!.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "stream-done", status: "completed" } })}\n\n`))
    sourceController!.close()
    await stream.response.text()
    await stream.streamUsage

    const afterEof = await invoke({ model: "synthetic/model", input: "after EOF" })
    expect(afterEof.response.status).toBe(200)
    expect(calls).toBe(2)
    await runInWorkspace(ownerWorkspace, () => deleteProviderApiKey(providerId, credential.id))
    const afterDelete = await invoke({ model: "synthetic/model", input: "after delete" })
    expect(afterDelete.response.status).toBe(503)
    expect(calls).toBe(2)
    await afterEof.response.body?.cancel().catch(() => undefined)
    await afterEof.streamUsage
    const releasedDeletedCredential = await runInWorkspace(ownerWorkspace, () => scheduler.acquire({
      ownerWorkspaceId: ownerWorkspace.id,
      providerId,
      credentials: [credential],
    }))
    expect(releasedDeletedCredential.ok).toBe(true)
    if (releasedDeletedCredential.ok) releasedDeletedCredential.release()
    const replacement = await runInWorkspace(ownerWorkspace, () => upsertProviderApiKey(providerId, { name: "Replacement", key: "replacement-stream-key", maxConcurrency: 1, enabled: true }))
    resolved = { ...resolved, upstream: { ...resolved.upstream!, apiKeys: [...resolved.upstream!.apiKeys, replacement] } }
    const afterCancel = await invoke({ model: "synthetic/model", input: "after cancel" })
    expect(afterCancel.response.status).toBe(200)
    expect(calls).toBe(3)

    await runInWorkspace(ownerWorkspace, () => deleteProvider(providerId))
    const blockedByDeletedProvider = await invoke({ model: "synthetic/model", input: "provider deleted while active" })
    expect(blockedByDeletedProvider.response.status).toBe(503)
    expect(JSON.parse(await blockedByDeletedProvider.response.text()).error.code).toBe("provider_configuration_changed")
    expect(calls).toBe(3)
    expect(scheduler.acquire({ ownerWorkspaceId: ownerWorkspace.id, providerId, credentials: [replacement] })).toEqual({
      ok: false,
      reason: "concurrency_limit",
    })

    await afterCancel.response.body?.cancel().catch(() => undefined)
    await afterCancel.streamUsage
    const releasedDeletedProvider = scheduler.acquire({ ownerWorkspaceId: ownerWorkspace.id, providerId, credentials: [replacement] })
    expect(releasedDeletedProvider.ok).toBe(true)
    if (releasedDeletedProvider.ok) releasedDeletedProvider.release()
  })

  test("does not retry when a sent response body errors", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "partial-response" } })}\n\n`))
          controller.error(new Error("synthetic body failure"))
        },
      })
      return new Response(source, { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    const response = await invoke({ model: "synthetic/model", input: "body failure", stream: true })
    await expect(response.response.text()).rejects.toThrow("synthetic body failure")
    await response.streamUsage
    expect(calls).toBe(1)
  })

  test("client aborts terminate upstream streams and release their lease", async () => {
    await runInWorkspace(ownerWorkspace, async () => {
      _resetMemoryBackend()
      await setupProvider([{ name: "Single abort key", key: "single-abort-key", maxConcurrency: 1 }])
    })
    scheduler = createProviderCredentialScheduler({ now: () => now })
    let upstreamAborted = false
    let fetchCalls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const signal = init?.signal as AbortSignal
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => {
            upstreamAborted = true
            try { controller.error(signal.reason) } catch {}
          }, { once: true })
        },
      })
      return new Response(source, { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    const requestAbort = new AbortController()
    const result = await invoke({ model: "synthetic/model", input: "abort", stream: true }, {}, caller, resolved, requestAbort.signal)
    const credential = resolved.upstream!.apiKeys[0]!
    const blocked = await invoke({ model: "synthetic/model", input: "still active" })
    expect(blocked.response.status).toBe(503)
    expect(fetchCalls).toBe(1)
    const readResult = result.response.text().then(() => undefined, (error: unknown) => error)
    requestAbort.abort(new Error("Synthetic client disconnected."))
    expect(await readResult).toBeInstanceOf(Error)
    await result.streamUsage
    expect(upstreamAborted).toBe(true)
    const reusable = await runInWorkspace(ownerWorkspace, () => scheduler.acquire({
      ownerWorkspaceId: ownerWorkspace.id,
      providerId,
      credentials: [credential],
    }))
    expect(reusable.ok).toBe(true)
    if (reusable.ok) reusable.release()
  })

  test("stream watchdog aborts and cancels upstream before releasing concurrency", async () => {
    await runInWorkspace(ownerWorkspace, async () => {
      _resetMemoryBackend()
      await setupProvider([{ name: "Single watchdog key", key: "single-watchdog-key", maxConcurrency: 1 }])
    })
    scheduler = createProviderCredentialScheduler({ now: () => now })
    const credential = resolved.upstream!.apiKeys[0]!
    let upstreamAborted = false
    let upstreamCancelled = false
    let fetchCalls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const signal = init?.signal as AbortSignal
      const source = new ReadableStream<Uint8Array>({
        start() { signal.addEventListener("abort", () => { upstreamAborted = true }, { once: true }) },
        cancel() { upstreamCancelled = true },
      })
      return new Response(source, { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    jest.useFakeTimers()
    try {
      const result = await invoke({ model: "synthetic/model", input: "watchdog", stream: true })
      const blocked = await invoke({ model: "synthetic/model", input: "watchdog lease active" })
      expect(blocked.response.status).toBe(503)
      expect(fetchCalls).toBe(1)
      const readResult = result.response.text().then(() => undefined, (error: unknown) => error)
      jest.advanceTimersByTime(299_000)
      for (let index = 0; index < 12; index++) await Promise.resolve()
      expect(await readResult).toBeInstanceOf(Error)
      await result.streamUsage
      expect(upstreamAborted).toBe(true)
      expect(upstreamCancelled).toBe(true)
      const reusable = await runInWorkspace(ownerWorkspace, () => scheduler.acquire({
        ownerWorkspaceId: ownerWorkspace.id,
        providerId,
        credentials: [credential],
      }))
      expect(reusable.ok).toBe(true)
      if (reusable.ok) reusable.release()
    } finally {
      jest.useRealTimers()
    }
  })
})
