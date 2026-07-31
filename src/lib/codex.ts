import { createHash, randomBytes } from "node:crypto"

import { getProviderApiKey, listProviderApiKeys, listProviders, upsertProvider, upsertProviderApiKey } from "@/lib/store"
import type { Provider, ProviderApiKey } from "@/lib/types"

export const CODEX_PROVIDER_PREFIX = "codex"
export const CODEX_PROVIDER_NAME = "Codex OAuth"

type FetchLike = typeof fetch

export interface CodexDeviceCode {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
  verificationUrl: string
}

export interface CodexTokenBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt?: string
  accountId?: string
  email?: string
  planType?: string
}

export type CodexDevicePollResult =
  | { status: "pending" }
  | { status: "authorized"; code: string; verifier: string }

function authBaseUrl() {
  return (process.env.CODEX_AUTH_BASE_URL || "https://auth.openai.com").replace(/\/$/, "")
}

function clientId() {
  return process.env.CODEX_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann"
}

export function codexBaseUrl() {
  return (process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/$/, "")
}

function jsonBody(value: unknown) {
  return JSON.stringify(value)
}

async function responseError(response: Response, operation: string) {
  let detail = ""
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {}
  return new Error(`${operation} failed (${response.status})${detail ? `: ${detail}` : "."}`)
}

function base64UrlJson(value: string): Record<string, unknown> | undefined {
  try {
    const [, encoded] = value.split(".")
    if (!encoded) return undefined
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function parseTokenBundle(payload: Record<string, unknown>, previous?: ProviderApiKey): CodexTokenBundle {
  const accessToken = stringClaim(payload.access_token)
  if (!accessToken) throw new Error("Codex token response did not contain an access token.")
  const idToken = stringClaim(payload.id_token) || previous?.idToken
  const claims = idToken ? base64UrlJson(idToken) : undefined
  const authClaims = claims?.["https://api.openai.com/auth"]
  const auth = authClaims && typeof authClaims === "object" && !Array.isArray(authClaims) ? authClaims as Record<string, unknown> : undefined
  const profileClaims = claims?.["https://api.openai.com/profile"]
  const profile = profileClaims && typeof profileClaims === "object" && !Array.isArray(profileClaims) ? profileClaims as Record<string, unknown> : undefined
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in)
  const jwtExpiration = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : jwtExpiration ? new Date(jwtExpiration).toISOString() : previous?.expiresAt
  return {
    accessToken,
    refreshToken: stringClaim(payload.refresh_token) || previous?.refreshToken,
    idToken,
    expiresAt,
    accountId: stringClaim(auth?.chatgpt_account_id) || previous?.accountId,
    email: stringClaim(claims?.email) || stringClaim(profile?.email) || previous?.email,
    planType: stringClaim(auth?.chatgpt_plan_type) || previous?.planType,
  }
}

export function generatePkce() {
  const verifier = randomBytes(64).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export function buildCodexAuthorizationUrl(state: string, challenge: string) {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  })
  return `${authBaseUrl()}/oauth/authorize?${params.toString()}`
}

export async function requestCodexDeviceCode(fetchImpl: FetchLike = fetch): Promise<CodexDeviceCode> {
  const response = await fetchImpl(`${authBaseUrl()}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: jsonBody({ client_id: clientId() }),
  })
  if (!response.ok) throw await responseError(response, "Codex device login")
  const payload = await response.json() as Record<string, unknown>
  const deviceAuthId = stringClaim(payload.device_auth_id)
  const userCode = stringClaim(payload.user_code) || stringClaim(payload.usercode)
  if (!deviceAuthId || !userCode) throw new Error("Codex device login returned an invalid code response.")
  const interval = Number(payload.interval)
  return {
    deviceAuthId,
    userCode,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
    verificationUrl: `${authBaseUrl()}/codex/device`,
  }
}

export async function pollCodexDeviceCode(deviceAuthId: string, userCode: string, fetchImpl: FetchLike = fetch): Promise<CodexDevicePollResult> {
  const response = await fetchImpl(`${authBaseUrl()}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: jsonBody({ device_auth_id: deviceAuthId, user_code: userCode }),
  })
  if (response.status === 403 || response.status === 404) return { status: "pending" }
  if (!response.ok) throw await responseError(response, "Codex device login polling")
  const payload = await response.json() as Record<string, unknown>
  const code = stringClaim(payload.authorization_code)
  const verifier = stringClaim(payload.code_verifier)
  if (!code || !verifier) throw new Error("Codex device login returned an invalid authorization response.")
  return { status: "authorized", code, verifier }
}

export function codexDeviceRedirectUri() {
  return `${authBaseUrl()}/deviceauth/callback`
}

export async function exchangeCodexAuthorizationCode(code: string, verifier: string, redirectUri: string, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(`${authBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId(),
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) throw await responseError(response, "Codex token exchange")
  return parseTokenBundle(await response.json() as Record<string, unknown>)
}

export async function refreshCodexToken(refreshToken: string, previous?: ProviderApiKey, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(`${authBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }).toString(),
  })
  if (!response.ok) throw await responseError(response, "Codex token refresh")
  return parseTokenBundle(await response.json() as Record<string, unknown>, previous)
}

export function codexCredentialNeedsRefresh(account: ProviderApiKey, skewMs = 60_000) {
  if (account.credentialKind !== "codex-oauth") return false
  if (!account.expiresAt) return false
  return Date.parse(account.expiresAt) <= Date.now() + skewMs
}

export async function ensureCodexProvider(): Promise<Provider> {
  const providers = await listProviders()
  const existing = providers.find((provider) => provider.prefix === CODEX_PROVIDER_PREFIX)
  if (existing) {
    if (existing.protocol !== "openai-responses" || existing.authType !== "bearer" || existing.baseUrl !== codexBaseUrl()) {
      throw new Error(`Provider prefix ${CODEX_PROVIDER_PREFIX} is already configured for a different upstream.`)
    }
    return existing
  }
  return upsertProvider({
    name: CODEX_PROVIDER_NAME,
    prefix: CODEX_PROVIDER_PREFIX,
    baseUrl: codexBaseUrl(),
    protocol: "openai-responses",
    authType: "bearer",
    headers: {},
    enabled: true,
  })
}

export async function saveCodexAccount(token: CodexTokenBundle, name?: string) {
  const provider = await ensureCodexProvider()
  const existing = token.accountId
    ? (await listProviderApiKeys(provider.id)).find((account) => account.credentialKind === "codex-oauth" && account.accountId === token.accountId)
    : undefined
  const account = await upsertProviderApiKey(provider.id, {
    ...(existing ? { originalId: existing.id } : {}),
    name: name?.trim() || token.email || token.accountId || "Codex account",
    key: token.accessToken,
    credentialKind: "codex-oauth",
    refreshToken: token.refreshToken,
    idToken: token.idToken,
    accountId: token.accountId,
    email: token.email,
    planType: token.planType,
    expiresAt: token.expiresAt,
    lastRefresh: new Date().toISOString(),
    enabled: existing?.enabled !== false,
    rpmLimit: existing?.rpmLimit,
    maxConcurrency: existing?.maxConcurrency,
    priority: existing?.priority,
  })
  return { provider, account }
}

const refreshes = new Map<string, Promise<ProviderApiKey>>()

export async function refreshCodexAccount(account: ProviderApiKey, force = false) {
  if (account.credentialKind !== "codex-oauth") return account
  if (!force && !codexCredentialNeedsRefresh(account)) return account
  const existingRefresh = refreshes.get(account.id)
  if (existingRefresh) return existingRefresh
  const promise = (async () => {
    const current = await getProviderApiKey(account.providerId, account.id) || account
    if (!force && !codexCredentialNeedsRefresh(current)) return current
    if (!current.refreshToken) throw new Error(`Codex account ${current.name} has no refresh token.`)
    const token = await refreshCodexToken(current.refreshToken, current)
    return upsertProviderApiKey(current.providerId, {
      originalId: current.id,
      name: current.name,
      key: token.accessToken,
      credentialKind: "codex-oauth",
      refreshToken: token.refreshToken,
      idToken: token.idToken,
      accountId: token.accountId,
      email: token.email,
      planType: token.planType,
      expiresAt: token.expiresAt,
      lastRefresh: new Date().toISOString(),
      enabled: current.enabled,
      rpmLimit: current.rpmLimit,
      maxConcurrency: current.maxConcurrency,
      priority: current.priority,
    })
  })()
  refreshes.set(account.id, promise)
  try { return await promise } finally { refreshes.delete(account.id) }
}

export async function listCodexAccounts() {
  const provider = (await listProviders()).find((entry) => entry.prefix === CODEX_PROVIDER_PREFIX)
  if (!provider) return { provider: undefined, accounts: [] as ProviderApiKey[] }
  const accounts = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-oauth")
  return { provider, accounts }
}
