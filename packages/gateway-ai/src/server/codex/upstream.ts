import type { ProviderApiKey } from "../../contracts/domain"
import { getCodexCredential, readCodexCredentialSecrets } from "../codex-credentials"
import { refreshCodexCredentialSession } from "./login"

const CODEX_API_ORIGIN = "https://chatgpt.com"
const REQUEST_TIMEOUT_MS = 10_000

type CodexFetch = typeof fetch

let fetchOverride: CodexFetch | undefined

export interface PreparedCodexAccount {
  account: ProviderApiKey
  sessionVersion: number
}

function unavailable(): Error {
  return new Error("Codex account is no longer available.")
}

function tokenExpired(expiresAt: string | undefined) {
  if (!expiresAt) return false
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry <= Date.now()
}

async function currentAccount(account: ProviderApiKey) {
  const current = await getCodexCredential(account.providerId, account.id)
  if (!current || !current.enabled || !current.accountId) throw unavailable()
  return current
}

async function currentSession(account: ProviderApiKey, expectedVersion?: number) {
  let current = await currentAccount(account)
  let secrets = await readCodexCredentialSecrets(current.id)
  if (!secrets) throw unavailable()
  if (tokenExpired(secrets.expiresAt)) {
    secrets = await refreshCodexCredentialSession(current.providerId, current.id)
    current = await currentAccount(account)
  }
  if (expectedVersion !== undefined && secrets.version !== expectedVersion) {
    throw new Error("Codex account changed during model discovery.")
  }
  return { account: current, secrets }
}

function codexUrl(value: string | URL) {
  let url: URL
  try {
    url = new URL(value, CODEX_API_ORIGIN)
  } catch {
    throw new Error("Invalid Codex request URL.")
  }
  if (url.origin !== CODEX_API_ORIGIN || !url.pathname.startsWith("/backend-api/") || url.username || url.password) {
    throw new Error("Codex request URL is not allowed.")
  }
  return url
}

async function send(account: ProviderApiKey, url: URL, init: RequestInit, expectedVersion?: number, beforeDispatch?: () => void) {
  const { account: current, secrets } = await currentSession(account, expectedVersion)
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${secrets.accessToken}`)
  headers.set("accept", headers.get("accept") || "application/json")
  headers.set("chatgpt-account-id", current.accountId!)
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  try {
    beforeDispatch?.()
    return await (fetchOverride || globalThis.fetch)(url, { ...init, headers, signal, cache: "no-store" })
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Codex request timed out.")
    }
    throw new Error("Codex request failed.")
  }
}

/**
 * Make an authenticated request for one workspace-owned Codex account.
 * Session renewal always goes through login's single-flight and
 * compare-and-swap writer. Only idempotent reads may retry once after a 401;
 * callers must not use this behavior for reset-credit consumption.
 */
export async function fetchCodexAccount(
  account: ProviderApiKey,
  input: string | URL,
  init: RequestInit = {},
  expectedVersion?: number,
  beforeDispatch?: () => void,
) {
  const url = codexUrl(input)
  const method = (init.method || "GET").toUpperCase()
  const response = await send(account, url, init, expectedVersion, beforeDispatch)
  if (response.status !== 401 || method !== "GET") return response

  await refreshCodexCredentialSession(account.providerId, account.id)
  const current = await currentAccount(account)
  const secrets = await readCodexCredentialSecrets(current.id)
  if (!secrets) throw unavailable()
  // Do not retry with a session that changed after discovery took its snapshot.
  if (expectedVersion !== undefined && secrets.version === expectedVersion) {
    throw new Error("Codex account changed during model discovery.")
  }
  return send(account, url, init, expectedVersion === undefined ? undefined : secrets.version, beforeDispatch)
}

/** Refresh expired credentials before taking a discovery snapshot. */
export async function prepareCodexAccount(account: ProviderApiKey): Promise<PreparedCodexAccount> {
  const { account: current, secrets } = await currentSession(account)
  return { account: current, sessionVersion: secrets.version }
}

/** Read the latest public account state and secret revision without exposing secrets. */
export async function readCodexAccountRevision(account: ProviderApiKey): Promise<PreparedCodexAccount> {
  const current = await getCodexCredential(account.providerId, account.id)
  if (!current) throw unavailable()
  const secrets = await readCodexCredentialSecrets(current.id)
  if (!secrets) throw unavailable()
  return { account: current, sessionVersion: secrets.version }
}

export function setCodexUpstreamFetchForTests(fetch?: CodexFetch) {
  fetchOverride = fetch
}
