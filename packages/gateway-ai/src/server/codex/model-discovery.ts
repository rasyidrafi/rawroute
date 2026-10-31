import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { localCacheCompareAndDelete, localCacheGet, localCacheSet, localCacheSetIfAbsent } from "@rawroute/platform/server/local-cache"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

import type { ProviderApiKey } from "../../contracts/domain"
import type { CodexDiscoveryStatus } from "../../contracts/codex"
import { listProviderModels, listProviders, reconcileDiscoveredModel, routingConfigurationRevision } from "../store"
import { listCodexAccounts } from "./oauth"
import { fetchCodexAccount, prepareCodexAccount, readCodexAccountRevision } from "./upstream"

const inflight = new Map<string, Promise<CodexDiscoveryStatus>>()
const ttl = 300_000
const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
const CODEX_CLIENT_VERSION = "0.144.1"
const statusKey = (workspaceId = currentWorkspaceId()) => `rawroute:codex-models:${workspaceId}:status`

export async function codexDiscoveryStatus(): Promise<CodexDiscoveryStatus | undefined> {
  const value = await localCacheGet(statusKey())
  try { return value ? JSON.parse(value) : undefined } catch { return undefined }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseCodexModels(payload: unknown) {
  const rows = objectValue(payload)?.models
  if (!Array.isArray(rows)) throw new Error("Invalid Codex model catalog.")
  const models = new Map<string, string>()
  for (const entry of rows) {
    const row = objectValue(entry)
    if (!row || typeof row.slug !== "string") throw new Error("Invalid Codex model entry.")
    const id = row.slug
    if (!id || id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id)) throw new Error("Invalid Codex model ID.")
    if (row.supported_in_api !== undefined && typeof row.supported_in_api !== "boolean") throw new Error("Invalid Codex model availability.")
    if (row.visibility !== undefined && typeof row.visibility !== "string") throw new Error("Invalid Codex model visibility.")
    if (row.supported_in_api === false || row.visibility !== undefined && row.visibility !== "list") continue
    const label = typeof row.display_name === "string" && row.display_name.trim()
      ? row.display_name.trim()
      : typeof row.name === "string" && row.name.trim() ? row.name.trim() : id
    models.set(id, label.slice(0, 80))
  }
  if (!models.size) throw new Error("Codex returned no API-visible models; keeping the saved catalog.")
  return models
}

export function refreshCodexModels(force = false): Promise<CodexDiscoveryStatus> {
  const workspaceId = currentWorkspaceId()
  const pending = inflight.get(workspaceId)
  if (pending) return pending
  const task = refresh(force, workspaceId).finally(() => inflight.delete(workspaceId))
  inflight.set(workspaceId, task)
  return task
}

function accountControlSnapshot(accounts: ProviderApiKey[]) {
  return JSON.stringify(accounts.map(account => [
    account.id,
    account.providerId,
    account.credentialKind,
    account.accountId,
    account.name,
    account.email,
    account.planType,
    account.enabled,
    account.priority,
    account.createdAt,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

async function accountSnapshot(accounts: ProviderApiKey[]) {
  const revisions = await mapConcurrent(accounts, 4, account => readCodexAccountRevision(account))
  const state = revisions.map(({ account, sessionVersion }) => ({
    id: account.id,
    providerId: account.providerId,
    credentialKind: account.credentialKind,
    accountId: account.accountId,
    name: account.name,
    email: account.email,
    planType: account.planType,
    enabled: account.enabled,
    priority: account.priority,
    createdAt: account.createdAt,
    expiresAt: account.expiresAt,
    lastRefresh: account.lastRefresh,
    sessionVersion,
  })).sort((a, b) => a.id.localeCompare(b.id))
  return { state, serialized: JSON.stringify(state) }
}

async function discoverAccount(account: ProviderApiKey, sessionVersion: number) {
  try {
    const url = new URL(`models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`, `${CODEX_API_BASE}/`)
    const response = await fetchCodexAccount(account, url, { method: "GET", headers: { accept: "application/json" } }, sessionVersion)
    if (!response.ok) throw new Error("Codex model catalog request failed.")
    return parseCodexModels(await response.json())
  } catch {
    // Upstream response bodies can contain sensitive diagnostics. Keep only a
    // stable, non-secret discovery error for the workspace status and UI.
    throw new Error("Codex model discovery failed for one account.")
  }
}

async function refresh(force: boolean, workspaceId: string): Promise<CodexDiscoveryStatus> {
  const previousValue = await localCacheGet(statusKey(workspaceId))
  let previous: CodexDiscoveryStatus | undefined
  try { previous = previousValue ? JSON.parse(previousValue) : undefined } catch { previous = undefined }
  if (!force && previous && Date.now() - Date.parse(previous.attemptedAt) < ttl) return previous
  const status: CodexDiscoveryStatus = { attemptedAt: new Date().toISOString(), succeededAt: previous?.succeededAt, added: 0, skipped: 0 }
  const key = `${statusKey(workspaceId)}:lock`
  const token = crypto.randomUUID()
  const lock = await localCacheSetIfAbsent(key, token, 120_000)
  if (lock === false) return previous || { ...status, error: "Model refresh is already running." }
  try {
    const provider = (await listProviders()).find((entry) => entry.prefix === "codex")
    if (!provider) return status

    const initialRevision = routingConfigurationRevision()
    const listed = await listCodexAccounts()
    const before = listed.accounts
    const beforeControl = accountControlSnapshot(before)
    const initialSnapshot = await accountSnapshot(before)
    if (routingConfigurationRevision() !== initialRevision) {
      throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    }
    const preparationFailures = new Set<string>()
    const errors: string[] = []
    const prepared = new Map<string, Awaited<ReturnType<typeof prepareCodexAccount>>>()
    await mapConcurrent(before.filter(account => account.enabled), 4, async account => {
      try { prepared.set(account.id, await prepareCodexAccount(account)) }
      catch {
        preparationFailures.add(account.id)
        errors.push("Codex model discovery failed for one account.")
      }
    })

    const current = await listCodexAccounts()
    if (accountControlSnapshot(current.accounts) !== beforeControl) {
      throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    }
    const enabledIds = current.accounts.filter(account => account.enabled).map(account => account.id).sort()
    const attemptedIds = [...prepared.keys(), ...preparationFailures].sort()
    if (JSON.stringify(enabledIds) !== JSON.stringify(attemptedIds)) {
      throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    }
    const snapshot = await accountSnapshot(current.accounts)
    const initialById = new Map(initialSnapshot.state.map(account => [account.id, account]))
    const snapshotById = new Map(snapshot.state.map(account => [account.id, account]))
    let refreshes = 0
    for (const account of before) {
      const initial = initialById.get(account.id)
      const latest = snapshotById.get(account.id)
      if (!initial || !latest) throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
      if (!account.enabled) {
        if (initial.sessionVersion !== latest.sessionVersion) throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
        continue
      }
      if (latest.sessionVersion < initial.sessionVersion || latest.sessionVersion > initial.sessionVersion + 1) {
        throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
      }
      if (latest.sessionVersion !== initial.sessionVersion) refreshes++
      const preparation = prepared.get(account.id)
      if ((preparation && preparation.sessionVersion !== latest.sessionVersion) || (!preparation && !preparationFailures.has(account.id))) {
        throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
      }
    }
    // Token refreshes are the only expected configuration writes during the
    // preparation phase. Any other revision means the account snapshot raced
    // with an enable, removal, reorder, or identity update (including ABA).
    if (routingConfigurationRevision() - initialRevision !== refreshes) {
      throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    }

    const accounts = current.accounts.filter(account => account.enabled && prepared.has(account.id))
    const routingRevisionAtFetch = routingConfigurationRevision()
    const failed = new Set(preparationFailures)
    const observations = new Map<string, { name: string; accountIds: string[] }>()
    const deadline = Date.now() + 60_000
    await mapConcurrent(accounts, 4, async account => {
      try {
        if (Date.now() >= deadline) throw new Error("Model discovery deadline exceeded.")
        const preparation = prepared.get(account.id)
        if (!preparation) throw new Error("Codex account preparation failed.")
        const models = await discoverAccount(account, preparation.sessionVersion)
        for (const [id, name] of models) {
          const entry = observations.get(id) || { name, accountIds: [] }
          entry.accountIds.push(account.id)
          observations.set(id, entry)
        }
      } catch {
        failed.add(account.id)
        errors.push("Codex model discovery failed for one account.")
      }
    })

    const latest = await listCodexAccounts()
    const finalSnapshot = await accountSnapshot(latest.accounts)
    if (snapshot.serialized !== finalSnapshot.serialized || routingConfigurationRevision() !== routingRevisionAtFetch) {
      throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    }
    if (accounts.length > 0 && observations.size === 0 && errors.length > 0) {
      throw new Error("Codex model discovery failed for every enabled account; keeping the saved catalog.")
    }

    const existing = await listProviderModels(provider.id)
    const candidates = new Map(observations)
    for (const model of existing) {
      if (model.source === "discovered" && !candidates.has(model.upstreamModel)) candidates.set(model.upstreamModel, { name: model.name, accountIds: [] })
    }
    const existingByGatewayId = new Map(existing.map(model => [model.gatewayModelId, model]))
    await mapConcurrent([...candidates], 1, async ([id, observed]) => {
      const gatewayModelId = `codex/${id}`
      const model = existingByGatewayId.get(gatewayModelId)
      if (model && model.source !== "discovered") { status.skipped++; return }
      const retained = model?.discovery?.accountIds.filter(accountId => failed.has(accountId)) || []
      const accountIds = [...new Set([...observed.accountIds, ...retained])].sort()
      const discovery = { lastSeenAt: observed.accountIds.length ? status.attemptedAt : model?.discovery?.lastSeenAt, accountIds, stale: !observed.accountIds.length }
      try {
        await reconcileDiscoveredModel(provider.id, { gatewayModelId, upstreamModel: id, name: observed.name, discovery })
        if (!model) status.added++
      } catch (error) {
        if (error instanceof Error && error.message === "Custom model owns this gateway ID.") status.skipped++
        else throw error
      }
    })
    if (errors.length) status.error = [...new Set(errors)].join(" ")
    else status.succeededAt = status.attemptedAt
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Codex model discovery failed."
  } finally {
    await localCacheSet(statusKey(workspaceId), JSON.stringify(status), 30 * 86400_000)
    if (lock) await localCacheCompareAndDelete(key, token)
  }
  return status
}
