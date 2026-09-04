import { createHash } from "node:crypto"

import { listProviderApiKeys, listProviders, upsertProviderApiKey } from "@/lib/store"
import type { Provider, ProviderApiKey } from "@/lib/types"
import { runInWorkspace } from "@/lib/workspace-context"
import { listWorkspaces } from "@/lib/workspaces"

const DEFAULT_CLIPROXY_URL = "http://cli-proxy-api:8317"

export type CliProxyAuthFile = {
  name: string
  type: string
  authIndex?: string
  prefix?: string
  status?: string
  statusMessage?: string
  disabled: boolean
  unavailable: boolean
  email?: string
  accountId?: string
  planType?: string
  expiresAt?: string
  lastRefresh?: string
}

type RawAuthFile = Record<string, unknown>

function cliProxyUrl(path: string) {
  const base = (process.env.CLIPROXY_URL || DEFAULT_CLIPROXY_URL).replace(/\/$/, "")
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}

export async function cliproxyManagement(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY?.trim()
  if (!managementKey) throw new Error("CLIPROXY_MANAGEMENT_KEY is required for Codex credentials.")
  headers.set("x-management-key", managementKey)
  return fetch(cliProxyUrl(path), { ...init, headers, cache: "no-store" })
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function nestedString(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value) ? string((value as Record<string, unknown>)[key]) : undefined
}

function authFile(value: RawAuthFile): CliProxyAuthFile | undefined {
  const name = string(value.name)
  const type = string(value.type)?.toLowerCase()
  if (!name || type !== "codex") return undefined
  const claims = value.id_token
  return {
    name,
    type,
    authIndex: string(value.auth_index),
    prefix: string(value.prefix),
    status: string(value.status),
    statusMessage: string(value.status_message),
    disabled: value.disabled === true,
    unavailable: value.unavailable === true,
    email: string(value.email),
    accountId: nestedString(claims, "chatgpt_account_id") || string(value.account_id),
    planType: nestedString(claims, "plan_type") || string(value.plan_type),
    expiresAt: string(value.expired) || string(value.expires_at),
    lastRefresh: string(value.last_refresh),
  }
}

export async function listCliProxyCodexAuthFiles() {
  const response = await cliproxyManagement("/v0/management/auth-files")
  const payload = await response.json().catch(() => undefined) as { files?: RawAuthFile[] } | undefined
  if (!response.ok) throw new Error(`CLIProxy auth-file list failed (${response.status}).`)
  return (Array.isArray(payload?.files) ? payload.files : []).flatMap((value) => authFile(value) ? [authFile(value)!] : [])
}

function authFileSignature(file: CliProxyAuthFile) {
  return JSON.stringify([file.authIndex, file.accountId, file.email, file.expiresAt, file.lastRefresh])
}

export function codexWorkspacePrefix(workspaceId: string) {
  const digest = createHash("sha1").update(`rawroute:codex:${workspaceId}`).digest("hex").slice(0, 16)
  return `rr-codex-${digest}`
}

function legacyAuthFileName(workspaceId: string, account: ProviderApiKey) {
  const identity = (account.accountId || account.id).trim().replace(/[^A-Za-z0-9._-]+/g, "-")
  return `codex-rawroute-${codexWorkspacePrefix(workspaceId)}-${identity}.json`
}

function mappedFileName(account: ProviderApiKey, workspaceId: string) {
  return account.cliProxyAuthFile || legacyAuthFileName(workspaceId, account)
}

async function mappedWorkspaceForFile(fileName: string, targetWorkspaceId: string) {
  for (const workspace of await listWorkspaces()) {
    if (workspace.id === targetWorkspaceId) continue
    const matched = await runInWorkspace(workspace, async () => {
      const provider = (await listProviders()).find((entry) => entry.prefix === "codex")
      if (!provider) return false
      return (await listProviderApiKeys(provider.id)).some((account) => account.credentialKind === "codex-cli-proxy" && account.cliProxyAuthFile === fileName)
    })
    if (matched) return workspace.id
  }
  return undefined
}

export async function migrateLegacyCodexAccounts(provider: Provider, workspaceId: string, accounts: ProviderApiKey[]) {
  const files = await listCliProxyCodexAuthFiles()
  const byName = new Map(files.map((file) => [file.name, file]))
  const migrated: ProviderApiKey[] = []
  for (const account of accounts) {
    if (account.credentialKind !== "codex-oauth") continue
    const file = byName.get(legacyAuthFileName(workspaceId, account))
    if (!file) continue
    migrated.push(await upsertProviderApiKey(provider.id, {
      originalId: account.id,
      name: account.name,
      key: "",
      credentialKind: "codex-cli-proxy",
      accountId: file.accountId || account.accountId,
      email: file.email || account.email,
      planType: file.planType || account.planType,
      expiresAt: file.expiresAt,
      lastRefresh: file.lastRefresh,
      cliProxyAuthFile: file.name,
      cliProxyAuthIndex: file.authIndex,
      cliProxyStatus: file.status,
      cliProxyStatusMessage: file.statusMessage,
      enabled: !file.disabled,
      priority: account.priority,
    }))
  }
  return migrated.length
}

export async function listMappedCodexAccounts(provider: Provider, workspaceId: string) {
  let accounts = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-oauth" || entry.credentialKind === "codex-cli-proxy")
  if (accounts.some((entry) => entry.credentialKind === "codex-oauth")) {
    await migrateLegacyCodexAccounts(provider, workspaceId, accounts)
    accounts = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-oauth" || entry.credentialKind === "codex-cli-proxy")
  }
  const limitedMappings = accounts.filter((entry) => entry.credentialKind === "codex-cli-proxy" && (entry.rpmLimit !== undefined || entry.maxConcurrency !== undefined))
  if (limitedMappings.length) {
    await Promise.all(limitedMappings.map((account) => upsertProviderApiKey(provider.id, {
      originalId: account.id,
      credentialKind: "codex-cli-proxy",
      key: "__unchanged__",
    })))
    accounts = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-oauth" || entry.credentialKind === "codex-cli-proxy")
  }
  const files = await listCliProxyCodexAuthFiles()
  const byName = new Map(files.map((file) => [file.name, file]))
  return accounts.map((account) => {
    const file = byName.get(mappedFileName(account, workspaceId))
    if (!file) return {
      ...account,
      cliProxyStatus: "missing",
      cliProxyStatusMessage: account.credentialKind === "codex-oauth"
        ? "Legacy credential could not be matched to a CLIProxy auth file. Reconnect this account."
        : "Credential mapping is missing in CLIProxy.",
      enabled: false,
    }
    return {
      ...account,
      accountId: file.accountId || account.accountId,
      email: file.email || account.email,
      planType: file.planType || account.planType,
      expiresAt: file.expiresAt,
      lastRefresh: file.lastRefresh,
      cliProxyAuthFile: file.name,
      cliProxyAuthIndex: file.authIndex,
      cliProxyStatus: file.status,
      cliProxyStatusMessage: file.statusMessage,
      enabled: !file.disabled,
    }
  })
}

export async function registerCliProxyCodexAccount(provider: Provider, input: { name?: string; authFile: CliProxyAuthFile }) {
  const file = input.authFile
  if (!file.authIndex) throw new Error("CLIProxy Codex credential has no auth_index.")
  const existing = (await listProviderApiKeys(provider.id)).find((account) => account.credentialKind === "codex-cli-proxy" && account.cliProxyAuthFile === file.name)
  return upsertProviderApiKey(provider.id, {
    ...(existing ? { originalId: existing.id } : {}),
    name: input.name?.trim() || existing?.name || file.email || file.accountId || "Codex account",
    key: "",
    credentialKind: "codex-cli-proxy",
    accountId: file.accountId,
    email: file.email,
    planType: file.planType,
    expiresAt: file.expiresAt,
    lastRefresh: file.lastRefresh,
    cliProxyAuthFile: file.name,
    cliProxyAuthIndex: file.authIndex,
    cliProxyStatus: file.status,
    cliProxyStatusMessage: file.statusMessage,
    enabled: !file.disabled,
    priority: existing?.priority,
  })
}

export async function setCliProxyCodexAccountEnabled(account: ProviderApiKey, enabled: boolean) {
  const name = account.cliProxyAuthFile
  if (!name) throw new Error("Codex account has no CLIProxy auth-file mapping.")
  const response = await cliproxyManagement("/v0/management/auth-files/status", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ...(account.cliProxyAuthIndex ? { auth_index: account.cliProxyAuthIndex } : {}), disabled: !enabled }),
  })
  if (!response.ok) throw new Error(`CLIProxy auth-file update failed (${response.status}).`)
}

export async function setCliProxyCodexAccountPriority(account: ProviderApiKey, priority: number) {
  const name = account.cliProxyAuthFile
  if (!name) throw new Error("Codex account has no CLIProxy auth-file mapping.")
  const response = await cliproxyManagement("/v0/management/auth-files/fields", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, priority }),
  })
  if (!response.ok) throw new Error(`CLIProxy auth-file priority update failed (${response.status}).`)
}

export async function deleteCliProxyCodexAccount(account: ProviderApiKey) {
  const name = account.cliProxyAuthFile
  if (!name) throw new Error("Codex account has no CLIProxy auth-file mapping.")
  const response = await cliproxyManagement(`/v0/management/auth-files?name=${encodeURIComponent(name)}`, { method: "DELETE" })
  if (!response.ok && response.status !== 404) throw new Error(`CLIProxy auth-file deletion failed (${response.status}).`)
}

export async function cliProxyCodexApiCall(account: ProviderApiKey, input: { method: string; url: string; headers?: Record<string, string>; data?: string }) {
  if (!account.cliProxyAuthIndex) throw new Error("Codex account has no CLIProxy auth_index.")
  const response = await cliproxyManagement("/v0/management/api-call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth_index: account.cliProxyAuthIndex, method: input.method, url: input.url, header: input.headers, data: input.data }),
  })
  const payload = await response.json().catch(() => undefined) as { status_code?: unknown; body?: unknown } | undefined
  if (!response.ok) throw new Error(`CLIProxy API call failed (${response.status}).`)
  const status = typeof payload?.status_code === "number" ? payload.status_code : 502
  const body = typeof payload?.body === "string" ? payload.body : ""
  return { status, body }
}

export async function startCliProxyCodexLogin() {
  const before = await listCliProxyCodexAuthFiles()
  const response = await cliproxyManagement("/v0/management/codex-auth-url?is_webui=true")
  const payload = await response.json().catch(() => undefined) as { url?: unknown; state?: unknown } | undefined
  const url = string(payload?.url)
  const state = string(payload?.state)
  if (!response.ok || !url || !state) throw new Error(`CLIProxy Codex login could not be started (${response.status}).`)
  return { url, state, existingAuthFiles: Object.fromEntries(before.map((file) => [file.name, authFileSignature(file)])) }
}

export async function cancelCliProxyCodexLogin(state: string) {
  const response = await cliproxyManagement(`/v0/management/oauth-session?state=${encodeURIComponent(state)}`, { method: "DELETE" })
  if (!response.ok) throw new Error(`CLIProxy Codex login cancellation failed (${response.status}).`)
}

export async function completeCliProxyCodexLogin(state: string, existingAuthFiles: Record<string, string>, workspaceId: string, name?: string) {
  const statusResponse = await cliproxyManagement(`/v0/management/get-auth-status?state=${encodeURIComponent(state)}`)
  const statusPayload = await statusResponse.json().catch(() => undefined) as { status?: unknown; error?: unknown } | undefined
  if (!statusResponse.ok) throw new Error(`CLIProxy Codex login status failed (${statusResponse.status}).`)
  const status = string(statusPayload?.status)
  if (status === "wait") return undefined
  if (status !== "ok") throw new Error(string(statusPayload?.error) || "CLIProxy Codex login failed.")
  const files = await listCliProxyCodexAuthFiles()
  const changed = files.filter((entry) => existingAuthFiles[entry.name] !== authFileSignature(entry))
  if (changed.length === 0) throw new Error("CLIProxy completed login but no new or refreshed Codex credential was found.")
  if (changed.length > 1) throw new Error("Multiple Codex credentials changed during login; no workspace mapping was created.")
  const file = changed[0]
  const workspacePrefix = codexWorkspacePrefix(workspaceId)
  if ((file.prefix?.startsWith("rr-codex-") && file.prefix !== workspacePrefix) || await mappedWorkspaceForFile(file.name, workspaceId)) {
    throw new Error("This Codex credential is already mapped to another RawRoute workspace.")
  }
  const previousPrefix = file.prefix || ""
  const response = await cliproxyManagement("/v0/management/auth-files/fields", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, prefix: workspacePrefix }),
  })
  if (!response.ok) throw new Error(`CLIProxy Codex workspace mapping failed (${response.status}).`)
  const updated = (await listCliProxyCodexAuthFiles()).find((entry) => entry.name === file.name) || file
  return { file: updated, name, previousPrefix }
}

export async function setCliProxyCodexAccountPrefix(fileName: string, prefix: string) {
  const response = await cliproxyManagement("/v0/management/auth-files/fields", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: fileName, prefix }),
  })
  if (!response.ok) throw new Error(`CLIProxy Codex workspace mapping rollback failed (${response.status}).`)
}
