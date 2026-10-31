/**
 * Deterministic race tests for the Codex login. Each race is pinned
 * with a barrier through the module's test seams (no module mocking, no real
 * network, no real upstream): the transition hook holds the consume-to-
 * exchanging window open, and the register seam holds the registration commit
 * open, so the crossing observer/cancellation is scheduled exactly where the
 * race would otherwise hide.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"

import { queryAudit } from "@rawroute/platform/server/audit"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { closeLocalDatabase } from "@rawroute/platform/server/database"

import { registerCodexCredential } from "../codex-credentials"
import { listCodexAccounts } from "./oauth"
import {
  CodexLoginExpiredError,
  completeCodexLogin,
  hasPendingCodexLogin,
  observeCodexLogin,
  setCodexLoginObservationForTests,
  setCodexLoginRegisterForTests,
  setCodexLoginTransitionForTests,
  setCodexOAuthFetchForTests,
  takePendingCodexLogin,
} from "./login"
import { POST as startLogin } from "../routes/api/admin/oauth-providers/codex/device/start/index"
import { POST as pollLogin } from "../routes/api/admin/oauth-providers/codex/device/poll/index"
import { POST as submitCallback } from "../routes/api/admin/oauth-providers/codex/device/callback/index"
import { POST as cancelLogin } from "../routes/api/admin/oauth-providers/codex/device/cancel/index"

const defaultWorkspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }

function fakeIdToken() {
  const payload = Buffer.from(JSON.stringify({
    email: "user@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-one", plan_type: "pro" },
  })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

function fakeTokenEndpoint(handler: (body: Record<string, string>) => Promise<void> | void = () => undefined) {
  const calls: Array<{ url: string; body: Record<string, string> }> = []
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const text = await request.text()
    const body = request.headers.get("content-type")?.includes("json") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
    calls.push({ url: request.url, body: body as Record<string, string> })
    await handler(body as Record<string, string>)
    return new Response(JSON.stringify({ access_token: "access-codex-one", refresh_token: "refresh-codex-one", id_token: fakeIdToken(), expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })
  }, { preconnect: () => undefined })
  return { fetch, calls }
}

const json = (body: unknown) => new Request("http://rawroute.test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const callbackUrl = (state: string) => `http://localhost:1455/auth/callback?code=auth-code&state=${state}`

beforeEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  globalThis.__rawrouteMemoryAudit = []
  const { _resetMemoryBackend } = await import("../store")
  _resetMemoryBackend()
})

afterEach(async () => {
  setCodexOAuthFetchForTests(undefined)
  setCodexLoginObservationForTests(undefined)
  setCodexLoginTransitionForTests(undefined)
  setCodexLoginRegisterForTests(undefined)
  await closeLocalDatabase()
  await closeLocalCache()
})

/** Start a login and submit its callback, returning both. */
async function startCallback(fetch = fakeTokenEndpoint().fetch) {
  setCodexOAuthFetchForTests(fetch)
  const started = await startLogin()
  const { loginId } = await started.json() as { loginId: string }
  const session = (await takePendingCodexLogin(loginId))!
  return { loginId, session, callback: submitCallback(json({ loginId, redirectUrl: callbackUrl(session.state) })) }
}

test("cancellation waits for the registration commit instead of racing it", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    let releaseRegister!: () => void
    let registerEntered!: () => void
    const entered = new Promise<void>(resolve => { registerEntered = resolve })
    const blocked = new Promise<void>(resolve => { releaseRegister = resolve })
    setCodexLoginRegisterForTests(async (providerId, input) => {
      registerEntered()
      await blocked
      return registerCodexCredential(providerId, input)
    })
    let observationStarted!: () => void
    const observing = new Promise<void>(resolve => { observationStarted = resolve })
    setCodexLoginObservationForTests(observationStarted)
    try {
      const { loginId, callback } = await startCallback()
      await entered // phase two holds the login lock inside registration

      // The cancellation arrives while the registration is blocked. Under the
      // login lock it must wait for the commit boundary, then observe the
      // connected account instead of claiming it cancelled the login.
      const cancellation = cancelLogin(json({ loginId }))
      await observing // the cancellation's observation is queued behind registration

      releaseRegister()
      const cancelled = await cancellation
      expect(cancelled.status).toBe(409)
      expect(await cancelled.text()).toContain("connected before the cancellation")

      // The commit won linearly: the account is registered and healthy.
      const connected = await callback
      expect(connected.status).toBe(200)
      const accounts = (await listCodexAccounts()).accounts
      expect(accounts).toHaveLength(1)
      expect(accounts[0]!.credentialKind).toBe("codex-oauth")
      expect(await hasPendingCodexLogin()).toBe(false)
      const after = await pollLogin(json({ loginId }))
      expect(after.status).toBe(200)
      expect(((await after.json()) as { status: string }).status).toBe("authorized")
      expect(JSON.stringify(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))).not.toContain("access-codex-one")
    } finally {
      releaseRegister()
      setCodexLoginRegisterForTests(undefined)
    }
  })
})

test("a poll crossing the consume transition sees the pending login, not a false expiry", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    setCodexOAuthFetchForTests(fakeTokenEndpoint().fetch)
    let releaseTransition!: () => void
    let transitionEntered!: () => void
    const entered = new Promise<void>(resolve => { transitionEntered = resolve })
    const blocked = new Promise<void>(resolve => { releaseTransition = resolve })
    setCodexLoginTransitionForTests(async () => { transitionEntered(); await blocked })
    let observationStarted!: () => void
    const observing = new Promise<void>(resolve => { observationStarted = resolve })
    setCodexLoginObservationForTests(observationStarted)
    try {
      const started = await startLogin()
      const { loginId } = await started.json() as { loginId: string }
      const session = (await takePendingCodexLogin(loginId))!
      const callback = submitCallback(json({ loginId, redirectUrl: callbackUrl(session.state) }))
      await entered // the session is consumed, the exchanging state not yet published

      // The poll runs exactly in the torn window: under the login lock it waits
      // for the transition to publish instead of observing neither state.
      const poll = pollLogin(json({ loginId }))
      await observing // the poll is queued behind the consume transition
      releaseTransition()
      const crossing = await poll
      expect(crossing.status).toBe(202)
      expect(await crossing.json()).toEqual({ status: "pending" })

      const connected = await callback
      expect(connected.status).toBe(200)
      const after = await pollLogin(json({ loginId }))
      expect(after.status).toBe(200)
      expect(((await after.json()) as { status: string }).status).toBe("authorized")
    } finally {
      releaseTransition()
      setCodexLoginTransitionForTests(undefined)
    }
  })
})

test("a cancellation crossing the consume transition reaches the running exchange", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    let releaseExchange!: () => void
    let exchangeStarted!: () => void
    const exchanged = new Promise<void>(resolve => { exchangeStarted = resolve })
    const blockedExchange = new Promise<void>(resolve => { releaseExchange = resolve })
    const token = fakeTokenEndpoint(async () => { exchangeStarted(); await blockedExchange })
    setCodexOAuthFetchForTests(token.fetch)
    let releaseTransition!: () => void
    let transitionEntered!: () => void
    const entered = new Promise<void>(resolve => { transitionEntered = resolve })
    const blocked = new Promise<void>(resolve => { releaseTransition = resolve })
    setCodexLoginTransitionForTests(async () => { transitionEntered(); await blocked })
    let observationStarted!: () => void
    const observing = new Promise<void>(resolve => { observationStarted = resolve })
    setCodexLoginObservationForTests(observationStarted)
    try {
      const { loginId, callback } = await startCallback(token.fetch)
      await entered // the session is consumed, the exchanging state not yet published

      // The cancellation crosses the same window: after the transition it sees
      // the exchanging outcome, marks the exchange and cancels the login.
      const cancellation = cancelLogin(json({ loginId }))
      await observing // the cancellation is waiting on the transition lock
      releaseTransition()
      await exchanged
      const cancelled = await cancellation
      expect(cancelled.status).toBe(200)
      expect(await hasPendingCodexLogin()).toBe(false)

      // The completion observed the cancellation: no credential is registered.
      releaseExchange()
      expect((await callback).status).toBe(200)
      expect((await listCodexAccounts()).accounts).toHaveLength(0)
      const poll = await pollLogin(json({ loginId }))
      expect(poll.status).toBe(410)
    } finally {
      releaseTransition()
      releaseExchange()
      setCodexLoginTransitionForTests(undefined)
    }
  })
})

test("a duplicate callback consumer cannot replace or cancel the winning exchange", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    let releaseExchange!: () => void
    let exchangeStarted!: () => void
    const exchanged = new Promise<void>(resolve => { exchangeStarted = resolve })
    const blockedExchange = new Promise<void>(resolve => { releaseExchange = resolve })
    const token = fakeTokenEndpoint(async () => { exchangeStarted(); await blockedExchange })
    setCodexOAuthFetchForTests(token.fetch)
    const started = await startLogin()
    const { loginId } = await started.json() as { loginId: string }
    const session = (await takePendingCodexLogin(loginId))!

    let releaseTransition!: () => void
    let transitionEntered!: () => void
    const transitioned = new Promise<void>(resolve => { transitionEntered = resolve })
    const blockedTransition = new Promise<void>(resolve => { releaseTransition = resolve })
    setCodexLoginTransitionForTests(async () => { transitionEntered(); await blockedTransition })
    try {
      const input = { code: "auth-code" }
      const winner = completeCodexLogin(loginId, session, input)
      await transitioned // the winner consumed the one-use session under the login lock

      // Both callbacks already possess the same session. The second consumer
      // queues while the winner holds the consume-to-exchanging transition.
      const loser = completeCodexLogin(loginId, session, input)
      releaseTransition()
      await exchanged
      await expect(loser).rejects.toBeInstanceOf(CodexLoginExpiredError)
      expect(await observeCodexLogin(loginId)).toMatchObject({ kind: "outcome", outcome: { status: "exchanging" } })
      expect(token.calls).toHaveLength(1)

      releaseExchange()
      const outcome = await winner
      expect(outcome?.status).toBe("authorized")
      expect((await listCodexAccounts()).accounts).toHaveLength(1)
      expect(await hasPendingCodexLogin()).toBe(false)
    } finally {
      releaseTransition()
      releaseExchange()
      setCodexLoginTransitionForTests(undefined)
    }
  })
})
