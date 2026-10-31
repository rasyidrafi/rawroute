import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { queryAudit } from "@rawroute/platform/server/audit"
import { closeLocalCache, localCacheDelete, localCacheGet, localCacheSet } from "@rawroute/platform/server/local-cache"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { closeLocalDatabase } from "@rawroute/platform/server/database"

import { aiLocalDatabase } from "../local-db"
import { _resetMemoryBackend, listProviderApiKeys } from "../store"
import { readCodexCredentialSecrets } from "../codex-credentials"
import { listCodexAccounts } from "./oauth"
import {
  cleanupWorkspaceCodexLogin,
  hasPendingCodexLogin,
  refreshCodexCredentialSession,
  setCodexOAuthFetchForTests,
  takePendingCodexLogin,
} from "./login"
import { getCodexResetAccountStatus, redeemCodexReset, setCodexResetApiCallForTests } from "./reset"
import { setCodexUsageApiCallForTests } from "./usage"
import { POST as startLogin } from "../routes/api/admin/oauth-providers/codex/device/start/index"
import { POST as pollLogin } from "../routes/api/admin/oauth-providers/codex/device/poll/index"
import { POST as submitCallback } from "../routes/api/admin/oauth-providers/codex/device/callback/index"
import { POST as cancelLogin } from "../routes/api/admin/oauth-providers/codex/device/cancel/index"
import { PATCH as patchAccount, DELETE as deleteAccount } from "../routes/api/admin/oauth-providers/by-account/index"
import { POST as reorderAccounts } from "../routes/api/admin/providers/by-provider/api-keys/reorder/index"

const defaultWorkspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
let temporaryDirectory: string | undefined

/** The fixed canonical issuer used by @openai-oauth/core defaults. */
const tokenEndpoint = "https://auth.openai.com/oauth/token"

type PendingSession = { state: string; codeVerifier: string; workspaceId: string; expiresAt: number }

const accountId = "acct-codex-one"
const secretFragments = ["access-codex-one", "refresh-codex-one", "access-codex-two", "rotated-refresh-token", "verifier-secret", "secret-upstream-detail"]

function fakeIdToken(claims: Record<string, unknown> = {}) {
  const payload = Buffer.from(JSON.stringify({
    email: "user@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, plan_type: "pro" },
    ...claims,
  })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

type Endpoint = (body: Record<string, string>) => Promise<{ status?: number; payload?: TokenResponse }> | { status?: number; payload?: TokenResponse }

function fakeTokenEndpoint(handler: Endpoint = () => ({})) {
  const calls: Array<{ url: string; body: Record<string, string> }> = []
  const perform = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const text = await request.text()
    const body = request.headers.get("content-type")?.includes("json") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
    calls.push({ url: request.url, body: body as Record<string, string> })
    const outcome = await handler(body as Record<string, string>)
    const status = outcome.status ?? 200
    if (status !== 200) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret-upstream-detail" }), { status, headers: { "content-type": "application/json" } })
    const payload = outcome.payload ?? { access_token: "access-codex-one", refresh_token: "refresh-codex-one", id_token: fakeIdToken(), expires_in: 3600 }
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  }
  const fetch = Object.assign(perform, { preconnect: () => undefined })
  return { fetch, calls }
}

function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const fragment of secretFragments) expect(serialized).not.toContain(fragment)
}

const json = (body: unknown) => new Request("http://rawroute.test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

beforeEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  globalThis.__rawrouteMemoryAudit = []
  _resetMemoryBackend()
})

afterEach(async () => {
  setCodexOAuthFetchForTests(undefined)
  setCodexResetApiCallForTests()
  setCodexUsageApiCallForTests()
  await closeLocalDatabase()
  await closeLocalCache()
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

async function useSqlite() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "rawroute-login-"))
  Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: join(temporaryDirectory, "test.sqlite") })
}

/** Run one browser-side login through the Codex routes and return its responses. */
async function connectAccount(endpoint: Endpoint = () => ({}), options: { name?: string; accountId?: string } = {}) {
  const token = fakeTokenEndpoint(endpoint)
  setCodexOAuthFetchForTests(token.fetch)
  const started = await startLogin()
  expect(started.status).toBe(200)
  const { loginId, authorizationUrl } = await started.json() as { loginId: string; authorizationUrl: string }
  const session = await takePendingCodexLogin(loginId)
  expect(session).toBeDefined()
  const callback = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session!.state}` }))
  const poll = await pollLogin(json({ loginId, ...(options.name ? { name: options.name } : {}) }))
  return { callback, poll, token, loginId, authorizationUrl, session: session!, accountId: options.accountId }
}

test("start builds a PKCE authorize URL and keeps one pending login per workspace", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    expect(started.status).toBe(200)
    const { loginId, authorizationUrl } = await started.json() as { loginId: string; authorizationUrl: string }

    const url = new URL(authorizationUrl)
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")!).toHaveLength(43)
    expect(url.searchParams.get("client_id")).toBeTruthy()

    const session = await takePendingCodexLogin(loginId)
    expect(session?.workspaceId).toBe(DEFAULT_WORKSPACE_ID)
    expect(session?.state).toBe(url.searchParams.get("state") ?? undefined)
    expect(session?.codeVerifier).toHaveLength(64)
    expect(await hasPendingCodexLogin()).toBe(true)

    const second = await startLogin()
    expect(second.status).toBe(502)
    expect(await second.text()).toContain("already in progress")

    await runInWorkspace({ id: "other-workspace", storageMode: "scoped" }, async () => {
      const other = await startLogin()
      expect(other.status).toBe(200)
      expect(await hasPendingCodexLogin()).toBe(true)
    })
  })
})

test("a valid callback exchanges the code and registers a stable Codex account", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { callback, poll, token, session } = await connectAccount(undefined, { name: "Work Codex" })
    expect(callback.status).toBe(200)
    expect(poll.status).toBe(200)
    const result = await poll.json() as { status: string; account: { id: string; name: string; email?: string; accountId?: string; planType?: string; providerId: string } }
    expect(result.status).toBe("authorized")
    expect(result.account.name).toBe("Work Codex")
    expect(result.account.email).toBe("user@example.com")
    expect(result.account.accountId).toBe(accountId)
    expect(result.account.planType).toBe("pro")

    // Exactly one upstream exchange, bound to this login's code and verifier.
    expect(token.calls).toHaveLength(1)
    expect(token.calls[0]!.url).toBe(tokenEndpoint)
    expect(token.calls[0]!.body).toMatchObject({ grant_type: "authorization_code", code: "auth-code", redirect_uri: "http://localhost:1455/auth/callback", code_verifier: session.codeVerifier })

    const { accounts } = await listCodexAccounts()
    expect(accounts).toHaveLength(1)
    const account = accounts[0]!
    expect(account.credentialKind).toBe("codex-oauth")
    expect(account.enabled).toBe(true)
    expect(account.key).toBe("")
    expect(account.email).toBe("user@example.com")
    expect(Date.parse(account.expiresAt!)).toBeGreaterThan(Date.now() + 3500_000)
    expectNoSecrets(accounts)

    const secrets = await readCodexCredentialSecrets(account.id)
    expect(secrets).toMatchObject({ accessToken: "access-codex-one", refreshToken: "refresh-codex-one", version: 1 })

    // A re-login with the same upstream identity keeps the account stable.
    const again = await connectAccount(() => ({}))
    const againResult = await again.poll.json() as { account: { id: string } }
    expect(againResult.account.id).toBe(account.id)
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-codex-one", version: 2 })

    expectNoSecrets(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("the poll answers pending while the callback has not arrived", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const pending = await pollLogin(json({ loginId }))
    expect(pending.status).toBe(202)
    expect(await pending.json()).toEqual({ status: "pending" })
  })
})

test("the poll keeps waiting while the callback's token exchange is running", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!
    let release!: () => void
    let startedExchange!: () => void
    const exchanged = new Promise<void>(resolve => { startedExchange = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const token = fakeTokenEndpoint(async () => { startedExchange(); await blocked; return {} })
    setCodexOAuthFetchForTests(token.fetch)

    const callback = submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
    await exchanged
    const duringExchange = await pollLogin(json({ loginId }))
    expect(duringExchange.status).toBe(202)
    expect(await duringExchange.json()).toEqual({ status: "pending" })

    release()
    expect((await callback).status).toBe(200)
    const after = await pollLogin(json({ loginId }))
    expect(after.status).toBe(200)
    expect(((await after.json()) as { status: string }).status).toBe("authorized")
  })
})

test("cancelling during the token exchange wins over registration", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!
    let release!: () => void
    let startedExchange!: () => void
    const exchanged = new Promise<void>(resolve => { startedExchange = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const token = fakeTokenEndpoint(async () => { startedExchange(); await blocked; return {} })
    setCodexOAuthFetchForTests(token.fetch)

    const callback = submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
    await exchanged
    const cancelled = await cancelLogin(json({ loginId }))
    expect(cancelled.status).toBe(200)
    expect(await hasPendingCodexLogin()).toBe(false)

    // The workspace is free for a fresh login immediately.
    const restart = await startLogin()
    expect(restart.status).toBe(200)

    // Releasing the old, cancelled exchange registers nothing and cannot
    // clobber the new login's session or outcome.
    release()
    expect((await callback).status).toBe(200)
    expect((await listCodexAccounts()).accounts).toHaveLength(0)
    const oldPoll = await pollLogin(json({ loginId }))
    expect(oldPoll.status).toBe(410)

    // The new login completes on its own session.
    const { loginId: newLoginId } = await restart.json() as { loginId: string }
    const newSession = (await takePendingCodexLogin(newLoginId))!
    setCodexOAuthFetchForTests(fakeTokenEndpoint().fetch)
    const completed = await submitCallback(json({ loginId: newLoginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${newSession.state}` }))
    expect(completed.status).toBe(200)
    const after = await pollLogin(json({ loginId: newLoginId }))
    expect(after.status).toBe(200)
    expect(((await after.json()) as { status: string }).status).toBe("authorized")
    expect((await listCodexAccounts()).accounts).toHaveLength(1)
    expectNoSecrets(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("invalid callback URLs are rejected before any upstream exchange", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const token = fakeTokenEndpoint()
    setCodexOAuthFetchForTests(token.fetch)
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!
    const callback = (redirectUrl: string) => submitCallback(json({ loginId, redirectUrl }))

    expect((await callback("http://203.0.113.10:8080/auth/callback?code=c&state=" + session.state)).status).toBe(400)
    expect((await callback("http://localhost:1456/auth/callback?code=c&state=" + session.state)).status).toBe(400)
    expect((await callback("http://localhost:1455/auth/cb?code=c&state=" + session.state)).status).toBe(400)
    expect((await callback("http://localhost:1455/auth/callback?code=c&state=other-state")).status).toBe(400)
    expect((await callback("http://localhost:1455/auth/callback?state=" + session.state)).status).toBe(400)
    expect((await callback("not a url")).status).toBe(400)
    expect(token.calls).toHaveLength(0)
    // The login is untouched and can still complete.
    const completed = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
    expect(completed.status).toBe(200)
    expect(token.calls).toHaveLength(1)
  })
})

test("a replayed callback cannot exchange twice", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { token, loginId, session } = await connectAccount()
    expect(token.calls).toHaveLength(1)

    const replay = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
    expect(replay.status).toBe(410)
    expect(token.calls).toHaveLength(1)
    expect(await hasPendingCodexLogin()).toBe(false)
  })
})

test("a concurrent duplicate callback cannot cancel the winning callback", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    let release!: () => void
    let startedExchange!: () => void
    const exchanged = new Promise<void>(resolve => { startedExchange = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const token = fakeTokenEndpoint(async () => { startedExchange(); await blocked; return {} })
    setCodexOAuthFetchForTests(token.fetch)
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!
    const callbackUrl = `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}`

    // Two callbacks race for the same one-use session; the losing one must not
    // overwrite the winner's exchange handle or cancel its published state.
    const first = submitCallback(json({ loginId, redirectUrl: callbackUrl }))
    const second = submitCallback(json({ loginId, redirectUrl: callbackUrl }))
    await exchanged
    const loser = await Promise.race([first, second])
    expect(loser.status).toBe(410)
    expect(token.calls).toHaveLength(1)
    // The winner's exchanging state is still published for polls.
    const poll = await pollLogin(json({ loginId }))
    expect(poll.status).toBe(202)

    release()
    const settled = await Promise.all([first, second])
    expect(settled.map((response) => response.status).sort()).toEqual([200, 410])
    const after = await pollLogin(json({ loginId, name: "Duplicate-safe account" }))
    expect(after.status).toBe(200)
    const result = await after.json() as { status: string; account: { id: string } }
    expect(result.status).toBe("authorized")
    expect((await listCodexAccounts()).accounts).toHaveLength(1)
    expect(await hasPendingCodexLogin()).toBe(false)
    expect(await readCodexCredentialSecrets(result.account.id)).toMatchObject({ accessToken: "access-codex-one", version: 1 })
  })
})

test("a foreign workspace cannot complete or poll another workspace's login", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const token = fakeTokenEndpoint()
    setCodexOAuthFetchForTests(token.fetch)
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!

    await runInWorkspace({ id: "other-workspace", storageMode: "scoped" }, async () => {
      const callback = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
      expect(callback.status).toBe(403)
      const poll = await pollLogin(json({ loginId }))
      expect(poll.status).toBe(403)
      const cancel = await cancelLogin(json({ loginId }))
      expect(cancel.status).toBe(403)
    })
    expect(token.calls).toHaveLength(0)
    // The owning workspace can still finish it.
    const completed = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
    expect(completed.status).toBe(200)
  })
})

test("expired logins are refused and forgotten", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const key = `rawroute:codex-login:session:${loginId}`
    const stored = JSON.parse((await localCacheGet(key))!) as PendingSession
    stored.expiresAt = Date.now() - 1
    await localCacheDelete(key)
    await localCacheSet(key, JSON.stringify(stored), 60_000)

    const poll = await pollLogin(json({ loginId }))
    expect(poll.status).toBe(410)
    const callback = await submitCallback(json({ loginId, redirectUrl: "http://localhost:1455/auth/callback?code=auth-code&state=expired" }))
    expect(callback.status).toBe(410)
    expect(await hasPendingCodexLogin()).toBe(false)
  })
})

test("cancellation frees the login for a fresh start", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const token = fakeTokenEndpoint()
    setCodexOAuthFetchForTests(token.fetch)
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!

    const cancelled = await cancelLogin(json({ loginId }))
    expect(cancelled.status).toBe(200)
    expect(await hasPendingCodexLogin()).toBe(false)
    const afterCancel = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${session.state}` }))
    expect(afterCancel.status).toBe(410)
    expect(token.calls).toHaveLength(0)

    const restart = await startLogin()
    expect(restart.status).toBe(200)
  })
})

test("a denied authorization is reported to the poll without upstream details", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!

    const denied = await submitCallback(json({ loginId, redirectUrl: `http://localhost:1455/auth/callback?error=access_denied&error_description=secret-upstream-detail&state=${session.state}` }))
    expect(denied.status).toBe(200)
    expect(await hasPendingCodexLogin()).toBe(false)

    const poll = await pollLogin(json({ loginId }))
    expect(poll.status).toBe(401)
    const body = await poll.text()
    expect(body).toContain("declined")
    expect(body).not.toContain("secret-upstream-detail")
  })
})

test("upstream exchange failures fail the login without leaking upstream details", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { callback, poll } = await connectAccount(() => ({ status: 400 }))
    expect(callback.status).toBe(502)
    const body = await callback.text()
    expect(body).toContain("HTTP 400")
    expect(body).not.toContain("secret-upstream-detail")
    expect(poll.status).toBe(410)
    const { accounts } = await listCodexAccounts()
    expect(accounts).toHaveLength(0)
    expectNoSecrets(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("refresh rotates the refresh token atomically and keeps an omitted one", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount()
    const account = (await poll.json() as { account: { id: string; providerId: string } }).account

    const token = fakeTokenEndpoint(() => ({ payload: { access_token: "access-codex-two", refresh_token: "rotated-refresh-token", id_token: fakeIdToken(), expires_in: 3600 } }))
    setCodexOAuthFetchForTests(token.fetch)
    const refreshed = await refreshCodexCredentialSession(account.providerId, account.id)
    expect(refreshed).toMatchObject({ accessToken: "access-codex-two", refreshToken: "rotated-refresh-token" })
    expect(token.calls).toHaveLength(1)
    expect(token.calls[0]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-codex-one" })

    const secrets = await readCodexCredentialSecrets(account.id)
    expect(secrets).toMatchObject({ accessToken: "access-codex-two", refreshToken: "rotated-refresh-token", version: 2 })

    // An upstream response without a refresh token preserves the previous one.
    const kept = fakeTokenEndpoint(() => ({ payload: { access_token: "access-codex-three", expires_in: 3600 } }))
    setCodexOAuthFetchForTests(kept.fetch)
    const renewed = await refreshCodexCredentialSession(account.providerId, account.id)
    expect(renewed.refreshToken).toBe("rotated-refresh-token")
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-codex-three", refreshToken: "rotated-refresh-token", version: 3 })
  })
})

test("concurrent refreshes share one upstream exchange and one write", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount()
    const account = (await poll.json() as { account: { id: string; providerId: string } }).account

    let release!: () => void
    const blocker = new Promise<void>(resolve => { release = resolve })
    const token = fakeTokenEndpoint(() => { void blocker; return { payload: { access_token: "access-codex-two", refresh_token: "rotated-refresh-token", expires_in: 3600 } } })
    setCodexOAuthFetchForTests(token.fetch)
    const first = refreshCodexCredentialSession(account.providerId, account.id)
    const second = refreshCodexCredentialSession(account.providerId, account.id)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(token.calls).toHaveLength(1)
    expect((await readCodexCredentialSecrets(account.id))?.version).toBe(2)
  })
})

test("deletion racing an in-flight refresh cannot resurrect the credential", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount()
    const account = (await poll.json() as { account: { id: string; providerId: string } }).account

    let continueExchange!: () => void
    let exchangeStarted!: () => void
    const started = new Promise<void>(resolve => { exchangeStarted = resolve })
    const blocked = new Promise<void>(resolve => { continueExchange = resolve })
    const token = fakeTokenEndpoint(async () => { exchangeStarted(); await blocked; return { payload: { access_token: "access-codex-two", refresh_token: "rotated-refresh-token", expires_in: 3600 } } })
    setCodexOAuthFetchForTests(token.fetch)
    const refreshing = refreshCodexCredentialSession(account.providerId, account.id)
    await started
    await deleteAccount(new Request("http://rawroute.test", { method: "DELETE" }), { accountId: account.id })
    continueExchange()
    await expect(refreshing).rejects.toThrow()

    expect((await listCodexAccounts()).accounts).toHaveLength(0)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    expect(await getCodexResetAccountStatus(account.id)).toBeUndefined()
    expectNoSecrets(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("accounts are workspace-isolated", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount()
    const account = (await poll.json() as { account: { id: string; providerId: string } }).account

    await runInWorkspace({ id: "other-workspace", storageMode: "scoped" }, async () => {
      expect((await listCodexAccounts()).accounts).toHaveLength(0)
      await expect(refreshCodexCredentialSession(account.providerId, account.id)).rejects.toThrow()
      const foreign = await patchAccount(json({ enabled: false }), { accountId: account.id })
      expect(foreign.status).toBe(404)
    })

    // The owning workspace is unaffected by the foreign attempts.
    const owned = (await listCodexAccounts()).accounts[0]!
    expect(owned.enabled).toBe(true)
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-codex-one" })
  })
})

test("account enable, rename and reorder are local audited operations", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const first = await connectAccount(undefined, { name: "First account" })
    const second = await connectAccount(async () => ({
      payload: {
        access_token: "access-codex-two",
        refresh_token: "rotated-refresh-token",
        id_token: fakeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-two", plan_type: "team" } }),
        expires_in: 3600,
      },
    }), { name: "Second account" })
    const firstAccount = (await first.poll.json() as { account: { id: string; providerId: string } }).account
    const secondAccount = (await second.poll.json() as { account: { id: string; providerId: string } }).account

    const disabled = await patchAccount(json({ enabled: false }), { accountId: firstAccount.id })
    expect(disabled.status).toBe(200)
    const renamed = await patchAccount(json({ name: "Renamed account", enabled: true }), { accountId: firstAccount.id })
    expect(renamed.status).toBe(200)

    const accounts = await listProviderApiKeys(firstAccount.providerId)
    const updated = accounts.find((account) => account.id === firstAccount.id)!
    expect(updated.name).toBe("Renamed account")
    expect(updated.enabled).toBe(true)
    expect(updated.key).toBe("")

    const ordered = await reorderAccounts(json({ orderedIds: [secondAccount.id, firstAccount.id] }), { providerId: firstAccount.providerId })
    expect(ordered.status).toBe(200)
    const after = await listProviderApiKeys(firstAccount.providerId)
    expect(after.find((account) => account.id === secondAccount.id)!.priority).toBe(1)
    expect(after.find((account) => account.id === firstAccount.id)!.priority).toBe(0)

    const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
    expect(audit.filter(event => event.action === "credential.update").length).toBeGreaterThan(0)
    expectNoSecrets(audit)
  })
})

test("account removal releases reset-removal coordination and stays idempotent", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount()
    const account = (await poll.json() as { account: { id: string; providerId: string } }).account

    const removed = await deleteAccount(new Request("http://rawroute.test", { method: "DELETE" }), { accountId: account.id })
    expect(removed.status).toBe(200)
    expect((await listCodexAccounts()).accounts).toHaveLength(0)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    expect(await getCodexResetAccountStatus(account.id)).toBeUndefined()
    expectNoSecrets(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))

    const again = await deleteAccount(new Request("http://rawroute.test", { method: "DELETE" }), { accountId: account.id })
    expect(again.status).toBe(404)
  })
})

test("account removal is rejected while a reset-credit request is admitted", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount()
    const account = (await poll.json() as { account: { id: string; providerId: string } }).account
    let postStarted!: () => void
    let releasePost!: (result: { status: number; body: string }) => void
    const started = new Promise<void>(resolve => { postStarted = resolve })
    const pendingPost = new Promise<{ status: number; body: string }>(resolve => { releasePost = resolve })
    setCodexUsageApiCallForTests(async (_account, input) => input.url.endsWith("/usage")
      ? { status: 200, body: JSON.stringify({ rate_limit: { secondary_window: { used_percent: 100 } } }) }
      : { status: 200, body: JSON.stringify({ credits: [{ id: "credit-1", status: "available", expires_at: "2099-01-01T00:00:00Z" }] }) })
    setCodexResetApiCallForTests(async () => { postStarted(); return pendingPost })

    const redemption = redeemCodexReset((await listCodexAccounts()).accounts[0]!, "use my codex reset")
    await started
    const rejectedRemoval = await deleteAccount(new Request("http://rawroute.test", { method: "DELETE" }), { accountId: account.id })
    expect(rejectedRemoval.status).toBe(502)
    expect(await rejectedRemoval.text()).toContain("reset redemption is in progress")

    releasePost({ status: 200, body: "{}" })
    await redemption
    const removed = await deleteAccount(new Request("http://rawroute.test", { method: "DELETE" }), { accountId: account.id })
    expect(removed.status).toBe(200)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    expect(await getCodexResetAccountStatus(account.id)).toBeUndefined()
  })
})

test("workspace teardown drops the pending Codex login", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    expect(await hasPendingCodexLogin()).toBe(true)

    await cleanupWorkspaceCodexLogin(DEFAULT_WORKSPACE_ID)
    expect(await hasPendingCodexLogin()).toBe(false)
    const poll = await pollLogin(json({ loginId }))
    expect(poll.status).toBe(410)
  })
})

test("SQLite: connected accounts survive a restart, pending logins do not", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const { poll } = await connectAccount(undefined, { name: "Work Codex" })
    const account = (await poll.json() as { account: { id: string; accountId?: string } }).account
    expect(account.accountId).toBe(accountId)

    await closeLocalDatabase()
    await closeLocalCache()

    // The account record and its session material persist; the pending login
    // session (state, verifier) was process-local and is gone, so it cannot be
    // replayed after a restart.
    expect(await hasPendingCodexLogin()).toBe(false)
    aiLocalDatabase()
    const persisted = (await listCodexAccounts()).accounts[0]!
    expect(persisted.id).toBe(account.id)
    expect(persisted.name).toBe("Work Codex")
    expect(persisted.email).toBe("user@example.com")
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-codex-one", refreshToken: "refresh-codex-one" })
    const stale = await pollLogin(json({ loginId: "any" }))
    expect(stale.status).toBe(410)
  })
})
