import { listProviderApiKeys, listProviders } from "@/lib/store"
import { listWorkspaces } from "@/lib/workspaces"
import { runInWorkspace } from "@/lib/workspace-context"
import type { ProviderApiKey } from "@/lib/types"

const DEFAULT_CLIPROXY_URL = "http://cli-proxy-api:8317"
const SYNC_TTL_MS = 5 * 60 * 1000

type AuthFileEntry = {
  name?: unknown
  type?: unknown
}

type CodexAuthFile = {
  type: "codex"
  access_token: string
  refresh_token?: string
  id_token?: string
  account_id?: string
  email?: string
  plan_type?: string
  expired?: string
  last_refresh?: string
  disabled?: boolean
}

let lastSyncAt = 0
let syncInflight: Promise<{ accounts: number; uploaded: number; removed: number }> | undefined

function cliProxyUrl(path: string) {
  const base = (process.env.CLIPROXY_URL || DEFAULT_CLIPROXY_URL).replace(/\/$/, "")
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}

async function management(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY?.trim()
  if (managementKey) headers.set("x-management-key", managementKey)
  return fetch(cliProxyUrl(path), { ...init, headers, cache: "no-store" })
}

async function managementJson<T>(path: string, init: RequestInit = {}) {
  const response = await management(path, init)
  const data = await response.json().catch(() => undefined) as T | undefined
  return { response, data }
}

function authFileName(account: ProviderApiKey) {
  const identity = (account.accountId || account.id).trim().replace(/[^A-Za-z0-9._-]+/g, "-")
  return `codex-rawroute-${identity}.json`
}

function authFilePayload(account: ProviderApiKey): CodexAuthFile {
  if (!account.key.trim()) throw new Error(`Codex account ${account.name} has no access token.`)
  return {
    type: "codex",
    access_token: account.key,
    ...(account.refreshToken ? { refresh_token: account.refreshToken } : {}),
    ...(account.idToken ? { id_token: account.idToken } : {}),
    ...(account.accountId ? { account_id: account.accountId } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { plan_type: account.planType } : {}),
    ...(account.expiresAt ? { expired: account.expiresAt } : {}),
    ...(account.lastRefresh ? { last_refresh: account.lastRefresh } : {}),
    ...(account.enabled === false ? { disabled: true } : {}),
  }
}

async function localCodexAccounts() {
  const workspaces = await listWorkspaces()
  const accounts = new Map<string, ProviderApiKey>()
  for (const workspace of workspaces) {
    const workspaceAccounts = await runInWorkspace(workspace, async () => {
      const provider = (await listProviders()).find((entry) => entry.prefix === "codex")
      if (!provider) return [] as ProviderApiKey[]
      return (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-oauth")
    })
    for (const account of workspaceAccounts) {
      const identity = account.accountId || account.id
      if (!accounts.has(identity)) accounts.set(identity, account)
    }
  }
  return [...accounts.values()]
}

async function syncNow(force: boolean) {
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY?.trim()
  if (!managementKey) return { accounts: 0, uploaded: 0, removed: 0 }

  const { response, data } = await managementJson<{ files?: AuthFileEntry[] }>("/v0/management/auth-files")
  if (!response.ok) throw new Error(`CLIProxy auth-file list failed (${response.status}).`)
  const files = Array.isArray(data?.files) ? data.files : []
  const accounts = await localCodexAccounts()
  const desired = new Map(accounts.map((account) => [authFileName(account), account]))
  const existingNames = new Set(files.flatMap((file) => typeof file.name === "string" ? [file.name] : []))
  let uploaded = 0
  for (const [name, account] of desired) {
    if (!force && existingNames.has(name)) continue
    const upload = await management(`/v0/management/auth-files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authFilePayload(account)),
    })
    if (!upload.ok) throw new Error(`CLIProxy auth-file upload failed (${upload.status}).`)
    uploaded += 1
  }

  let removed = 0
  for (const file of files) {
    const name = typeof file.name === "string" ? file.name : ""
    const type = typeof file.type === "string" ? file.type.toLowerCase() : ""
    if (!name || type !== "codex" || desired.has(name)) continue
    const deletion = await management(`/v0/management/auth-files?name=${encodeURIComponent(name)}`, { method: "DELETE" })
    if (!deletion.ok && deletion.status !== 404) throw new Error(`CLIProxy stale auth-file removal failed (${deletion.status}).`)
    if (deletion.ok) removed += 1
  }
  return { accounts: accounts.length, uploaded, removed }
}

export async function syncCodexAccountsToCliProxy(options: { force?: boolean } = {}) {
  const force = options.force === true
  if (!force && lastSyncAt + SYNC_TTL_MS > Date.now()) return { accounts: 0, uploaded: 0, removed: 0 }
  if (syncInflight) return syncInflight
  const promise = syncNow(force).then((result) => {
    lastSyncAt = Date.now()
    return result
  }).finally(() => {
    syncInflight = undefined
  })
  syncInflight = promise
  return promise
}

export function invalidateCodexCliProxySync() {
  lastSyncAt = 0
}
