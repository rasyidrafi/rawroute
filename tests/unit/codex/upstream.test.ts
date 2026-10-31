import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { _resetMemoryBackend } from "../../../packages/gateway-ai/src/server/store"
import { ensureCodexProvider } from "../../../packages/gateway-ai/src/server/codex/oauth"
import { registerCodexCredential, updateCodexCredential } from "../../../packages/gateway-ai/src/server/codex-credentials"
import { setCodexOAuthFetchForTests } from "../../../packages/gateway-ai/src/server/codex/login"
import { fetchCodexAccount, setCodexUpstreamFetchForTests } from "../../../packages/gateway-ai/src/server/codex/upstream"
import { fetchFreshCodexUsageForReset } from "../../../packages/gateway-ai/src/server/codex/usage"
import { GET as getCodexUsage } from "../../../packages/gateway-ai/src/server/routes/api/admin/oauth-providers/usage/index"

const workspaceTest = (name: string, callback: () => Promise<void>) => test(name, () => runInWorkspace({ id: "codex-upstream-test" }, callback))

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  _resetMemoryBackend()
  setCodexOAuthFetchForTests(undefined)
  setCodexUpstreamFetchForTests(undefined)
})

afterEach(async () => {
  setCodexOAuthFetchForTests(undefined)
  setCodexUpstreamFetchForTests(undefined)
  await closeLocalDatabase()
})

async function createAccount() {
  const provider = await ensureCodexProvider()
  return registerCodexCredential(provider.id, {
    accountId: "acct-upstream-test",
    name: "Upstream test account",
    secrets: {
      accessToken: "access-token-one",
      refreshToken: "refresh-token-one",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  })
}

test("usage and reset-credit inventory use direct authenticated account-scoped endpoints", async () => {
  const account = await runInWorkspace({ id: "codex-upstream-test" }, createAccount)
  const calls: Array<{ url: URL; init: RequestInit }> = []
  setCodexUpstreamFetchForTests(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ url, init: init || {} })
    if (url.pathname.endsWith("/usage")) {
      return Response.json({ plan_type: "plus", rate_limit: { secondary_window: { used_percent: 100 } } })
    }
    return Response.json({ credits: [{ id: "reset-1", status: "available", expires_at: "2099-01-01T00:00:00Z" }] })
  }) as unknown as typeof fetch)

  const result = await runInWorkspace({ id: "codex-upstream-test" }, () => fetchFreshCodexUsageForReset(account))

  expect(result).toMatchObject({ planType: "plus", weekly: { remainingPercent: 0 }, unusedResetCredits: 1, resetCredits: [{ id: "reset-1", status: "available" }] })
  expect(calls.map(call => call.url.pathname)).toEqual([
    "/backend-api/wham/usage",
    "/backend-api/wham/rate-limit-reset-credits",
  ])
  for (const { url, init } of calls) {
    const headers = new Headers(init.headers)
    expect(url.origin).toBe("https://chatgpt.com")
    expect(headers.get("authorization")).toBe("Bearer access-token-one")
    expect(headers.get("chatgpt-account-id")).toBe("acct-upstream-test")
    expect(headers.get("accept")).toBe("application/json")
  }
})

test("retries one idempotent GET after rotating a rejected session", async () => {
  const account = await runInWorkspace({ id: "codex-upstream-test" }, createAccount)
  const calls: Array<{ url: string; authorization: string | null }> = []
  setCodexOAuthFetchForTests((async () => Response.json({
    access_token: "access-token-two",
    refresh_token: "refresh-token-two",
    expires_in: 3600,
  })) as unknown as typeof fetch)
  let requestCount = 0
  setCodexUpstreamFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
    if (++requestCount === 1) return Response.json({ error: "expired" }, { status: 401 })
    return Response.json({ ok: true })
  }) as typeof fetch)

  const response = await runInWorkspace({ id: "codex-upstream-test" }, () => fetchCodexAccount(account, "https://chatgpt.com/backend-api/wham/usage"))

  expect(response.status).toBe(200)
  expect(calls).toEqual([
    { url: "https://chatgpt.com/backend-api/wham/usage", authorization: "Bearer access-token-one" },
    { url: "https://chatgpt.com/backend-api/wham/usage", authorization: "Bearer access-token-two" },
  ])
  expect(await runInWorkspace({ id: "codex-upstream-test" }, () => import("../../../packages/gateway-ai/src/server/codex-credentials").then(({ readCodexCredentialSecrets }) => readCodexCredentialSecrets(account.id))))
    .toMatchObject({ accessToken: "access-token-two", refreshToken: "refresh-token-two", version: 2 })
})

workspaceTest("usage route refreshes only enabled OAuth accounts", async () => {
  const active = await createAccount()
  const provider = await ensureCodexProvider()
  const disabled = await registerCodexCredential(provider.id, {
    accountId: "acct-disabled-upstream-test",
    name: "Disabled account",
    secrets: { accessToken: "disabled-access", refreshToken: "disabled-refresh" },
  })
  await updateCodexCredential(provider.id, disabled.id, { enabled: false })
  const calls = mock(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return url.pathname.endsWith("/usage")
      ? Response.json({ rate_limit: { secondary_window: { used_percent: 50 } } })
      : Response.json({ credits: [] })
  })
  setCodexUpstreamFetchForTests(calls as unknown as typeof fetch)

  const response = await getCodexUsage()
  const result = await response.json() as { accounts: Record<string, unknown> }

  expect(response.status).toBe(200)
  expect(Object.keys(result.accounts)).toEqual([active.id])
  expect(calls).toHaveBeenCalledTimes(2)
})

test("does not retry a reset-credit POST after an authorization response", async () => {
  const account = await runInWorkspace({ id: "codex-upstream-test" }, createAccount)
  const fetch = mock(async () => Response.json({ error: "expired" }, { status: 401 }))
  setCodexUpstreamFetchForTests(fetch as unknown as typeof globalThis.fetch)

  const response = await runInWorkspace({ id: "codex-upstream-test" }, () => fetchCodexAccount(account, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
    method: "POST",
    body: JSON.stringify({ redeem_request_id: "request-1" }),
  }))

  expect(response.status).toBe(401)
  expect(fetch).toHaveBeenCalledTimes(1)
})

workspaceTest("rejects disabled, deleted and foreign-workspace accounts before upstream access", async () => {
  const account = await createAccount()
  const fetch = mock(async () => Response.json({ ok: true }))
  setCodexUpstreamFetchForTests(fetch as unknown as typeof globalThis.fetch)

  await updateCodexCredential(account.providerId, account.id, { enabled: false })
  await expect(fetchCodexAccount(account, "https://chatgpt.com/backend-api/wham/usage")).rejects.toThrow("no longer available")
  expect(fetch).not.toHaveBeenCalled()

  await updateCodexCredential(account.providerId, account.id, { enabled: true })
  await runInWorkspace({ id: "another-workspace" }, async () => {
    await expect(fetchCodexAccount(account, "https://chatgpt.com/backend-api/wham/usage")).rejects.toThrow("no longer available")
  })
  expect(fetch).not.toHaveBeenCalled()

  const { deleteCodexCredential } = await import("../../../packages/gateway-ai/src/server/codex-credentials")
  await deleteCodexCredential(account.providerId, account.id)
  await expect(fetchCodexAccount(account, "https://chatgpt.com/backend-api/wham/usage")).rejects.toThrow("no longer available")
  expect(fetch).not.toHaveBeenCalled()
})
