import { randomUUID } from "node:crypto"
import {
  createOpenAIOAuthRequest,
  deriveAccountId,
  exchangeOpenAIOAuthCode,
  parseJwtClaims,
  refreshOpenAIOAuthTokens,
  type FetchFunction,
  type OpenAIOAuthTokenResponse,
} from "@openai-oauth/core"
import { localCacheCompareAndDelete, localCacheDelete, localCacheGet, localCacheSet, localCacheSetIfAbsent } from "@rawroute/platform/server/local-cache"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

import type { ProviderApiKey } from "../../contracts/domain"
import {
  getCodexCredential,
  refreshCodexCredential,
  registerCodexCredential,
  updateCodexCredential,
  type CodexCredentialSecrets,
  type CodexCredentialSecretsInput,
} from "../codex-credentials"
import { ensureCodexProvider } from "./oauth"

/**
 * Codex OAuth. `@openai-oauth/core` owns the protocol
 * (PKCE, the authorize URL, token exchange and refresh); this module owns the
 * workspace-scoped login session, the account registry writes and the
 * per-account refresh single-flight. OAuth state, code verifiers and token
 * values live only in process-local coordination storage and the server-only
 * secrets store; they never reach browser contracts, audit rows or logs.
 *
 * Every login transition runs under a per-login serialization lock shared with
 * polls and cancellations, so the consume-to-exchanging publication and the
 * registration commit are atomic observations: a poll never sees neither
 * state, a cancellation either lands before any credential write or sees the
 * connected outcome, and only the callback that wins the one-use consume owns
 * the login's cleanup.
 */

const LOGIN_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const REDIRECT_URI = "http://localhost:1455/auth/callback"
const ACTIVE_PREFIX = "rawroute:codex-login:active"
const SESSION_PREFIX = "rawroute:codex-login:session"
const OUTCOME_PREFIX = "rawroute:codex-login:outcome"

export interface PendingCodexLogin {
  state: string
  codeVerifier: string
  workspaceId: string
  expiresAt: number
}

export interface CodexAccountSummary {
  id: string
  providerId: string
  name: string
  email?: string
  accountId?: string
  planType?: string
}

export type CodexLoginOutcome =
  | { status: "exchanging"; workspaceId: string }
  | { status: "authorized"; workspaceId: string; account: CodexAccountSummary }
  | { status: "denied"; workspaceId: string }

export type CodexLoginObservation =
  | { kind: "pending"; workspaceId: string }
  | { kind: "outcome"; workspaceId: string; outcome: CodexLoginOutcome }
  | { kind: "unknown" }

export interface CodexLoginRequest {
  loginId: string
  authorizationUrl: string
}

export class CodexLoginExpiredError extends Error {
  constructor(message = "Codex login has expired. Start it again.") {
    super(message)
    this.name = "CodexLoginExpiredError"
  }
}

function activeCodexLoginKey(workspaceId = currentWorkspaceId()) {
  return `${ACTIVE_PREFIX}:${workspaceId}`
}

function codexLoginSessionKey(loginId: string) {
  return `${SESSION_PREFIX}:${loginId}`
}

function codexLoginOutcomeKey(loginId: string) {
  return `${OUTCOME_PREFIX}:${loginId}`
}

const codexLoginLocks = new Map<string, Promise<unknown>>()

/** Per-login serialization: transitions, polls and cancellations share one queue. */
function withCodexLoginLock<T>(loginId: string, task: () => Promise<T>): Promise<T> {
  const previous = codexLoginLocks.get(loginId)
  // Run the next task even when the previous one rejected; the lock only
  // serializes, it never propagates failures to the waiter.
  const promise = (previous ?? Promise.resolve()).then(task, task)
  codexLoginLocks.set(loginId, promise)
  promise.catch(() => undefined).finally(() => {
    if (codexLoginLocks.get(loginId) === promise) codexLoginLocks.delete(loginId)
  })
  return promise
}

let oauthFetchOverride: FetchFunction | undefined

/** Test seam: exchange and refresh hit this fetch instead of the network. */
export function setCodexOAuthFetchForTests(fetch?: FetchFunction) {
  oauthFetchOverride = fetch
}

let loginTransitionHook: (() => Promise<void>) | undefined

/** Test seam: awaited inside phase one between the one-use consume and the exchanging publication. */
export function setCodexLoginTransitionForTests(hook?: () => Promise<void>) {
  loginTransitionHook = hook
}

let loginObservationHook: (() => void) | undefined

/** Test seam: signals immediately before an observation queues behind a login transition. */
export function setCodexLoginObservationForTests(hook?: () => void) {
  loginObservationHook = hook
}

let registerOverride: typeof registerCodexCredential | undefined

/** Test seam: replaces the registration call inside the commit section. */
export function setCodexLoginRegisterForTests(register?: typeof registerCodexCredential) {
  registerOverride = register
}

function sanitizeOAuthError(error: unknown, action: string) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new Error(`${action} timed out.`)
  const status = error instanceof Error ? /HTTP (\d{3})/.exec(error.message)?.[1] : undefined
  return new Error(status ? `${action} (HTTP ${status}).` : `${action}.`)
}

function expiresAtFrom(expiresIn: number | undefined) {
  return expiresIn !== undefined && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
}

function claimString(claims: Record<string, unknown> | undefined, key: string) {
  const value = claims?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function nestedClaimString(claims: Record<string, unknown> | undefined, key: string) {
  const nested = claims?.["https://api.openai.com/auth"]
  return nested && typeof nested === "object" && !Array.isArray(nested) ? claimString(nested as Record<string, unknown>, key) : undefined
}

/**
 * Start a login: build the PKCE request, then hold its verifier behind a
 * workspace-scoped lease. The lease keeps one pending login per workspace
 * (the browser flow is single-purpose) without a cross-workspace global lock.
 */
export async function startCodexLogin(): Promise<CodexLoginRequest> {
  const workspaceId = currentWorkspaceId()
  const loginId = randomUUID()
  if (!(await localCacheSetIfAbsent(activeCodexLoginKey(workspaceId), loginId, LOGIN_TTL_MS))) {
    throw new Error("Another Codex login is already in progress. Finish or cancel it before starting another.")
  }
  try {
    const request = await createOpenAIOAuthRequest({ redirectUri: REDIRECT_URI })
    const session: PendingCodexLogin = { state: request.state, codeVerifier: request.codeVerifier, workspaceId, expiresAt: Date.now() + LOGIN_TTL_MS }
    if (!(await localCacheSetIfAbsent(codexLoginSessionKey(loginId), JSON.stringify(session), LOGIN_TTL_MS))) throw new Error("Unable to save the pending Codex login session.")
    return { loginId, authorizationUrl: request.authorizationUrl }
  } catch (error) {
    await cancelCodexLogin(loginId, workspaceId)
    throw error
  }
}

/** Read a pending login session; expired or malformed entries are dropped and free their workspace lease. */
export async function takePendingCodexLogin(loginId: string): Promise<PendingCodexLogin | undefined> {
  const raw = await localCacheGet(codexLoginSessionKey(loginId))
  if (typeof raw !== "string" || !raw) return undefined
  let value: Partial<PendingCodexLogin>
  try {
    value = JSON.parse(raw)
  } catch {
    await localCacheDelete(codexLoginSessionKey(loginId))
    return undefined
  }
  if (typeof value.state === "string" && typeof value.codeVerifier === "string" && typeof value.workspaceId === "string" && typeof value.expiresAt === "number" && value.expiresAt >= Date.now()) {
    return value as PendingCodexLogin
  }
  await localCacheDelete(codexLoginSessionKey(loginId))
  if (typeof value.workspaceId === "string") await releaseActiveCodexLogin(loginId, value.workspaceId)
  return undefined
}

/** One-use consume: succeeds only when the stored session is still this one. */
export function consumePendingCodexLogin(loginId: string, session: PendingCodexLogin): Promise<boolean> {
  return localCacheCompareAndDelete(codexLoginSessionKey(loginId), JSON.stringify(session))
}

/** Parse a stored outcome without mutating it; none of its fields are secrets. */
async function readCodexLoginOutcome(loginId: string): Promise<CodexLoginOutcome | undefined> {
  const raw = await localCacheGet(codexLoginOutcomeKey(loginId))
  if (typeof raw !== "string" || !raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<CodexLoginOutcome>
    if (typeof value.workspaceId !== "string" || (value.status !== "exchanging" && value.status !== "authorized" && value.status !== "denied")) return undefined
    if (value.status === "authorized" && typeof value.account?.id !== "string") return undefined
    return value as CodexLoginOutcome
  } catch {
    return undefined
  }
}

/**
 * Observe a login coherently: the outcome and pending session are read under
 * the login's serialization lock, so a callback consuming the session and
 * publishing its exchanging state between reads can never make an observer
 * see neither state (and falsely report expiry).
 */
export function observeCodexLogin(loginId: string): Promise<CodexLoginObservation> {
  loginObservationHook?.()
  return withCodexLoginLock(loginId, async () => {
    const outcome = await readCodexLoginOutcome(loginId)
    if (outcome) return { kind: "outcome", workspaceId: outcome.workspaceId, outcome }
    const raw = await localCacheGet(codexLoginSessionKey(loginId))
    let session: Partial<PendingCodexLogin> | undefined
    try { session = typeof raw === "string" && raw ? JSON.parse(raw) : undefined } catch { session = undefined }
    return session && typeof session.workspaceId === "string" && typeof session.expiresAt === "number" && session.expiresAt >= Date.now()
      ? { kind: "pending", workspaceId: session.workspaceId }
      : { kind: "unknown" }
  })
}

function releaseActiveCodexLogin(loginId: string, workspaceId: string) {
  return localCacheCompareAndDelete(activeCodexLoginKey(workspaceId), loginId)
}

interface CodexLoginExchange {
  cancelled: boolean
}

/** In-flight completions, so a cancellation during the token exchange wins. */
const codexLoginExchanges = new Map<string, CodexLoginExchange>()

/**
 * Cancel a login under its serialization lock: a login whose outcome is
 * already connected cannot be cancelled (the registration committed first, so
 * the cancellation must not claim success); otherwise the completion exchange
 * is told to discard, the workspace lease is released and the session and
 * outcome are dropped.
 */
export async function cancelCodexLogin(loginId: string, workspaceId: string): Promise<{ cancelled: boolean }> {
  return withCodexLoginLock(loginId, async () => {
    const outcome = await readCodexLoginOutcome(loginId)
    if (outcome?.status === "authorized") return { cancelled: false }
    const exchange = codexLoginExchanges.get(loginId)
    if (exchange) exchange.cancelled = true
    await releaseActiveCodexLogin(loginId, workspaceId)
    await localCacheDelete(codexLoginSessionKey(loginId), codexLoginOutcomeKey(loginId))
    return { cancelled: true }
  })
}

export async function hasPendingCodexLogin(workspaceId = currentWorkspaceId()) {
  return Boolean(await localCacheGet(activeCodexLoginKey(workspaceId)))
}

/** Workspace teardown: the pending login is purely local, so it is dropped. */
export async function cleanupWorkspaceCodexLogin(workspaceId: string) {
  const loginId = await localCacheGet(activeCodexLoginKey(workspaceId))
  if (typeof loginId !== "string" || !loginId) return
  await cancelCodexLogin(loginId, workspaceId)
}

function publicCodexAccount(account: ProviderApiKey): CodexAccountSummary {
  return {
    id: account.id,
    providerId: account.providerId,
    name: account.name,
    ...(account.email ? { email: account.email } : {}),
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.planType ? { planType: account.planType } : {}),
  }
}

async function exchangeCodexLoginCode(session: PendingCodexLogin, code: string): Promise<OpenAIOAuthTokenResponse> {
  try {
    return await exchangeOpenAIOAuthCode({ code, codeVerifier: session.codeVerifier, redirectUri: REDIRECT_URI, ...(oauthFetchOverride ? { fetch: oauthFetchOverride } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw sanitizeOAuthError(error, "Unable to complete the Codex login")
  }
}

/**
 * Complete a login from its validated callback in two serialized phases:
 *
 * Phase one consumes the one-use session and publishes the exchanging state
 * under the login lock; only the callback that wins the consume owns the
 * exchange handle and the login's cleanup, so a losing duplicate callback can
 * neither overwrite the winner's handle nor cancel it.
 *
 * Phase two is the registration commit: the cancellation check, the credential
 * write and the authorized publication are one locked section, so the outcome
 * linearizes — either the cancellation lands before any write, or it runs
 * after the commit and observes the connected account.
 *
 * Returns `undefined` when the login was cancelled before its outcome settled.
 */
export async function completeCodexLogin(loginId: string, session: PendingCodexLogin, input: { code?: string; error?: string }): Promise<CodexLoginOutcome | undefined> {
  let exchange: CodexLoginExchange | undefined
  let owned = false
  try {
    owned = await withCodexLoginLock(loginId, async () => {
      if (!(await consumePendingCodexLogin(loginId, session))) return false
      if (loginTransitionHook) await loginTransitionHook()
      exchange = { cancelled: false }
      codexLoginExchanges.set(loginId, exchange)
      await localCacheSet(codexLoginOutcomeKey(loginId), JSON.stringify({ status: "exchanging", workspaceId: session.workspaceId } as CodexLoginOutcome), LOGIN_TTL_MS)
      return true
    })
    if (!owned) throw new CodexLoginExpiredError()
    const publish = async (outcome: CodexLoginOutcome) => {
      await localCacheSet(codexLoginOutcomeKey(loginId), JSON.stringify(outcome), LOGIN_TTL_MS)
      await releaseActiveCodexLogin(loginId, session.workspaceId)
      return outcome
    }
    if (!input.code) {
      return await withCodexLoginLock(loginId, async () => {
        if (exchange!.cancelled) return undefined
        return publish({ status: "denied", workspaceId: session.workspaceId })
      })
    }
    const response = await exchangeCodexLoginCode(session, input.code)
    const provider = await ensureCodexProvider()
    return await withCodexLoginLock(loginId, async () => {
      // Cancellation requested during the exchange wins over the registration;
      // nothing awaits between this check and the registry write, and the
      // section holds until the commit and its publication are durable.
      if (exchange!.cancelled) return undefined
      const accountId = deriveAccountId(response.idToken) ?? deriveAccountId(response.accessToken)
      if (!accountId) throw new Error("The Codex sign-in did not identify an account. Try connecting it again.")
      const claims = parseJwtClaims(response.idToken) ?? parseJwtClaims(response.accessToken)
      const email = claimString(claims, "email")
      const planType = nestedClaimString(claims, "plan_type") ?? claimString(claims, "plan_type")
      const expiresAt = expiresAtFrom(response.expiresIn)
      const account = await (registerOverride ?? registerCodexCredential)(provider.id, {
        accountId,
        ...(email ? { email } : {}),
        ...(planType ? { planType } : {}),
        secrets: {
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          idToken: response.idToken,
          ...(expiresAt ? { expiresAt } : {}),
          lastRefresh: new Date().toISOString(),
        },
      })
      return publish({ status: "authorized", workspaceId: session.workspaceId, account: publicCodexAccount(account) })
    })
  } catch (error) {
    // Only the owning callback cleans the login up; a duplicate callback that
    // lost the consume must not cancel the winner.
    if (owned) await cancelCodexLogin(loginId, session.workspaceId)
    throw error
  } finally {
    if (exchange && codexLoginExchanges.get(loginId) === exchange) codexLoginExchanges.delete(loginId)
  }
}

/**
 * Apply the optional account label chosen during login. The account is already
 * connected; the label is a plain local rename so the operation is idempotent
 * across poll retries.
 */
export async function nameCodexLoginAccount(account: CodexAccountSummary, name: string): Promise<ProviderApiKey | undefined> {
  const current = await getCodexCredential(account.providerId, account.id)
  if (!current || current.name === name) return current
  return updateCodexCredential(account.providerId, account.id, { name })
}

const codexSessionRefreshInflight = new Map<string, Promise<CodexCredentialSecrets>>()

async function renewCodexSession(current: CodexCredentialSecrets): Promise<CodexCredentialSecretsInput | undefined> {
  if (!current.refreshToken) throw new Error("The Codex account has no refresh token. Reconnect the account.")
  let response: OpenAIOAuthTokenResponse
  try {
    response = await refreshOpenAIOAuthTokens({ refreshToken: current.refreshToken, ...(oauthFetchOverride ? { fetch: oauthFetchOverride } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw sanitizeOAuthError(error, "Unable to refresh the Codex session")
  }
  // Atomic rotation: a response that omits the refresh token keeps the previous
  // one, so the stored session never loses its renewal capability.
  const expiresAt = expiresAtFrom(response.expiresIn)
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken ?? current.refreshToken,
    idToken: response.idToken ?? current.idToken,
    ...(expiresAt ? { expiresAt } : {}),
    lastRefresh: new Date().toISOString(),
  }
}

/**
 * Per-account Codex refresh with single-flight: concurrent callers share one
 * upstream exchange and one compare-and-swap write. The rotation itself is
 * atomic through the secrets store's version guard, so a credential deleted
 * while the exchange was in flight can never be resurrected.
 */
export function refreshCodexCredentialSession(providerId: string, credentialId: string): Promise<CodexCredentialSecrets> {
  const key = `${currentWorkspaceId()}:${providerId}:${credentialId}`
  const pending = codexSessionRefreshInflight.get(key)
  if (pending) return pending
  const task = refreshCodexCredential(providerId, credentialId, renewCodexSession).then(
    (secrets) => { if (codexSessionRefreshInflight.get(key) === task) codexSessionRefreshInflight.delete(key); return secrets },
    (error) => { if (codexSessionRefreshInflight.get(key) === task) codexSessionRefreshInflight.delete(key); throw error },
  )
  codexSessionRefreshInflight.set(key, task)
  return task
}
