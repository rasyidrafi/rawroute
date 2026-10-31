import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { _resetMemoryBackend, listProviderApiKeys, upsertProvider } from "../../../packages/gateway-ai/src/server/store"
import { registerCodexCredential } from "../../../packages/gateway-ai/src/server/codex-credentials"
import { setCodexOAuthFetchForTests } from "../../../packages/gateway-ai/src/server/codex/login"
import { prepareProviderRequest, proxyToProvider } from "../../../packages/gateway-ai/src/server/gateway/transport"
import type { ResolvedGatewayModel } from "../../../packages/gateway-ai/src/server/gateway/model-resolution"

const workspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
let originalFetch: typeof fetch
let providerId = ""

function idToken(accountId: string) {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

async function addAccount(accountId: string, accessToken: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return registerCodexCredential(providerId, {
    accountId,
    name: accountId,
    secrets: { accessToken, refreshToken: `refresh-${accountId}`, idToken: idToken(accountId), expiresAt },
  })
}

function resolved(account: Awaited<ReturnType<typeof addAccount>>): ResolvedGatewayModel {
  return {
    upstreamModel: "gpt-5",
    upstreamProtocol: "openai-responses",
    pricingGatewayModelId: "codex/gpt-5",
    modelName: "GPT-5",
    providerId,
    promptCacheKey: true,
    upstream: {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      protocol: "openai-responses",
      authType: "bearer",
      headers: {},
      apiKeys: [account],
      codex: true,
    },
  }
}

function request(body: Record<string, unknown>) {
  return new Request("http://gateway.test/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer rawroute-gateway-key", "x-api-key": "rawroute-gateway-key", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function completedResponse(id: string, text: string) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5",
    output: [{ id: `item-${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  }
}

beforeEach(async () => {
  originalFetch = globalThis.fetch
  await closeLocalDatabase()
  await closeLocalCache()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  globalThis.__rawrouteMemoryAudit = []
  _resetMemoryBackend()
  await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({
      name: "Codex OAuth",
      prefix: "codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      protocol: "openai-responses",
      authType: "bearer",
      headers: {},
      enabled: true,
    })
    providerId = provider.id
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  setCodexOAuthFetchForTests(undefined)
  await closeLocalDatabase()
  await closeLocalCache()
})

test("refreshes an expired Codex session before direct execution", async () => {
  const account = await runInWorkspace(workspace, () => addAccount("acct-refresh", "expired-token", new Date(Date.now() - 60_000).toISOString()))
  const oauthCalls: string[] = []
  setCodexOAuthFetchForTests((async (input, init) => {
    const body = await new Request(input, init).text()
    oauthCalls.push(body)
    return Response.json({ access_token: "fresh-access-token", refresh_token: "fresh-refresh-token", id_token: idToken("acct-refresh"), expires_in: 3600 })
  }) as typeof fetch)
  const calls: Array<{ url: string; authorization: string | null; accountId: string | null; body: string }> = []
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input)
    if (url.includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" })
    if (url.includes("/models")) return Response.json({ object: "list", data: [] })
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), accountId: new Headers(init?.headers).get("chatgpt-account-id"), body: String(init?.body) })
    const value = completedResponse("refresh-response", "refreshed")
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch

  await runInWorkspace(workspace, async () => {
    const target = resolved(account)
    const body = { model: "codex/gpt-5", input: "hello" }
    const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-responses")
    const result = await proxyToProvider(request(body), target, prepared, "openai-responses")
    expect(result.response.status).toBe(200)
    await result.response.text()
    expect(await listProviderApiKeys(providerId)).toHaveLength(1)
  })

  expect(oauthCalls).toHaveLength(1)
  expect(oauthCalls[0]).toContain("refresh-acct-refresh")
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((call) => call.authorization === "Bearer fresh-access-token" && call.accountId === "acct-refresh")).toBe(true)
  expect(JSON.stringify(calls)).not.toContain("rawroute-gateway-key")
})

test("keeps Codex replay state isolated across credentials and callers", async () => {
  const firstAccount = await runInWorkspace(workspace, () => addAccount("acct-first", "first-access-token"))
  const secondAccount = await runInWorkspace(workspace, () => addAccount("acct-second", "second-access-token"))
  const allAccounts = await runInWorkspace(workspace, () => listProviderApiKeys(providerId))
  const first = allAccounts.find((entry) => entry.id === firstAccount.id)!
  const second = allAccounts.find((entry) => entry.id === secondAccount.id)!
  const requests: Array<{ accountId: string | null; body: Record<string, unknown> }> = []
  let responseIndex = 0
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" })
    if (String(input).includes("/models")) return Response.json({ object: "list", data: [] })
    requests.push({ accountId: new Headers(init?.headers).get("chatgpt-account-id"), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    const response = completedResponse(`response-${++responseIndex}`, responseIndex === 1 ? "private-first-conversation" : "second caller")
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch

  await runInWorkspace(workspace, async () => {
    for (const { account, body, gatewayKeyId } of [
      { account: first, body: { model: "codex/gpt-5", input: "private-first-conversation" }, gatewayKeyId: "caller-one" },
      { account: first, body: { model: "codex/gpt-5", previous_response_id: "response-1", input: "first-caller-followup" }, gatewayKeyId: "caller-one" },
      { account: second, body: { model: "codex/gpt-5", previous_response_id: "response-1", input: "private-second-request" }, gatewayKeyId: "caller-two" },
    ] as const) {
      const target = resolved(account)
      const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-responses")
      const result = await proxyToProvider(request(body), target, prepared, "openai-responses", { workspaceId: workspace.id, gatewayKeyId })
      expect(result.response.status).toBe(200)
      await result.response.text()
    }
  })

  expect(requests.map((entry) => entry.accountId)).toEqual(["acct-first", "acct-first", "acct-second"])
  expect(JSON.stringify(requests[1]?.body)).toContain("private-first-conversation")
  expect(JSON.stringify(requests[1]?.body)).toContain("first-caller-followup")
  expect(JSON.stringify(requests[2]?.body)).toContain("response-1")
  expect(JSON.stringify(requests[2]?.body)).toContain("private-second-request")
  expect(JSON.stringify(requests[2]?.body)).not.toContain("private-first-conversation")
  expect(JSON.stringify(requests)).not.toContain("rawroute-gateway-key")
})

test("keeps a Responses item continuation on its originating Codex account", async () => {
  const accountA = await runInWorkspace(workspace, () => addAccount("acct-a", "access-a"))
  const accountB = await runInWorkspace(workspace, () => addAccount("acct-b", "access-b"))
  const requests: Array<{ accountId: string | null; body: Record<string, unknown> }> = []
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" })
    if (String(input).includes("/models")) return Response.json({ object: "list", models: [] })
    const accountId = new Headers(init?.headers).get("chatgpt-account-id")
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ accountId, body })
    const response = completedResponse("response-item", "private replayed output")
    const item = response.output[0]
    const wire = [
      ": provider heartbeat\r\n\r\n",
      `event: response.output_item.done\r\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\r\n\r\n`,
      ": another heartbeat\n\n",
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
    ].join("")
    const bytes = new TextEncoder().encode(wire)
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch

  await runInWorkspace(workspace, async () => {
    const firstTarget = resolved(accountB)
    firstTarget.upstream!.apiKeys = [accountB, accountA]
    const firstBody = { model: "codex/gpt-5", input: "first request", stream: true }
    const first = await proxyToProvider(request(firstBody), firstTarget, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(firstBody)), firstTarget, "openai-responses"), "openai-responses", { workspaceId: workspace.id, gatewayKeyId: "caller-item" })
    expect(first.response.status).toBe(200)
    await first.response.text()
    await expect(first.streamUsage).resolves.toMatchObject({ terminalEventSeen: true, usage: { input: 2, output: 1 } })

    const secondTarget = resolved(accountA)
    secondTarget.upstream!.apiKeys = [accountA, accountB]
    const secondBody = { model: "codex/gpt-5", input: [{ type: "item_reference", id: "item-response-item" }] }
    const second = await proxyToProvider(request(secondBody), secondTarget, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(secondBody)), secondTarget, "openai-responses"), "openai-responses", { workspaceId: workspace.id, gatewayKeyId: "caller-item" })
    expect(second.response.status).toBe(200)
    await second.response.text()
  })

  expect(requests.map((entry) => entry.accountId)).toEqual(["acct-b", "acct-b"])
  expect(JSON.stringify(requests[1]?.body)).toContain("private replayed output")
})
