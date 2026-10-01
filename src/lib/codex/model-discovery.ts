import { mapConcurrent } from "@/lib/concurrency"
import { cliproxyManagement, codexWorkspacePrefix, listCliProxyCodexAuthFiles, mappedWorkspaceForFile } from "@/lib/codex/cliproxy"
import { localRedisCompareAndDelete, localRedisGet, localRedisSet, localRedisSetIfAbsent } from "@/lib/local-redis"
import { listProviderApiKeys, listProviderModels, listProviders, reconcileDiscoveredModel } from "@/server/store"
import { currentWorkspaceId } from "@/lib/workspace/context"

export type CodexDiscoveryStatus = { attemptedAt: string; succeededAt?: string; error?: string; added: number; skipped: number }
const inflight = new Map<string, Promise<CodexDiscoveryStatus>>()
const ttl = 300_000
const statusKey = (workspaceId = currentWorkspaceId()) => `rawroute:codex-models:${workspaceId}:status`

export async function codexDiscoveryStatus(): Promise<CodexDiscoveryStatus | undefined> {
  const value = await localRedisGet(statusKey())
  try { return value ? JSON.parse(value) : undefined } catch { return undefined }
}

export function parseCodexModels(payload: unknown, prefix: string) {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) throw new Error("Invalid CLIProxy model catalog.")
  const models = new Map<string, string>()
  for (const entry of (payload as { models: unknown[] }).models) {
    if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") throw new Error("Invalid CLIProxy model entry.")
    const row = entry as { id: string; display_name?: unknown }
    if (!row.id.startsWith(`${prefix}/`)) continue
    const id = row.id.slice(prefix.length + 1)
    if (!id || id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id)) throw new Error("Invalid CLIProxy model ID.")
    models.set(id, typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim().slice(0, 80) : id.slice(0, 80))
  }
  if (!models.size) throw new Error("CLIProxy returned no workspace-scoped models; keeping the saved catalog.")
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

type CodexAccount = Awaited<ReturnType<typeof listProviderApiKeys>>[number]

async function readMappedWorkspaces(accounts: CodexAccount[], workspaceId: string) {
  const fileNames = [...new Set(accounts.map((account) => account.cliProxyAuthFile).filter((name): name is string => Boolean(name)))]
  return new Map(await mapConcurrent(fileNames, 4, async (name) => [name, await mappedWorkspaceForFile(name, workspaceId)] as const))
}

// This snapshot detects changes to catalog inputs; it is not an authentication signature.
function accountSnapshot(accounts: CodexAccount[], files: Awaited<ReturnType<typeof listCliProxyCodexAuthFiles>>, mappedWorkspaces: Map<string, string | undefined>) {
  const byName = new Map(files.map((file) => [file.name, file]))
  return JSON.stringify(accounts.map((account) => {
    const file = byName.get(account.cliProxyAuthFile || "")
    return [account.id, account.cliProxyAuthFile, account.enabled, file?.authIndex, file?.accountId, file?.disabled, file?.unavailable, mappedWorkspaces.get(account.cliProxyAuthFile || "")]
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

async function refresh(force: boolean, workspaceId: string): Promise<CodexDiscoveryStatus> {
  const previousValue = await localRedisGet(statusKey(workspaceId))
  let previous: CodexDiscoveryStatus | undefined
  try { previous = previousValue ? JSON.parse(previousValue) : undefined } catch { previous = undefined }
  if (!force && previous && Date.now() - Date.parse(previous.attemptedAt) < ttl) return previous
  const status: CodexDiscoveryStatus = { attemptedAt: new Date().toISOString(), succeededAt: previous?.succeededAt, added: 0, skipped: 0 }
  const key = `${statusKey(workspaceId)}:lock`
  const token = crypto.randomUUID()
  const lock = await localRedisSetIfAbsent(key, token, 120_000)
  if (lock === false) return previous || { ...status, error: "Model refresh is already running." }
  try {
    const provider = (await listProviders()).find((entry) => entry.prefix === "codex")
    if (!provider) return status
    const mappings = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-cli-proxy")
    const files = await listCliProxyCodexAuthFiles()
    const prefix = codexWorkspacePrefix(workspaceId)
    const fileByName = new Map(files.map((file) => [file.name, file]))
    const mappedWorkspaceByFile = await readMappedWorkspaces(mappings, workspaceId)
    const startingAccounts = accountSnapshot(mappings, files, mappedWorkspaceByFile)
    const failed = new Set<string>()
    const errors: string[] = []
    const activeMappings = mappings.filter((account) => {
      if (!account.enabled) return false
      const file = account.cliProxyAuthFile ? fileByName.get(account.cliProxyAuthFile) : undefined
      return !file || !file.disabled
    })
    const accounts = activeMappings.filter((account) => {
      const file = account.cliProxyAuthFile ? fileByName.get(account.cliProxyAuthFile) : undefined
      if (!file) {
        failed.add(account.id)
        errors.push(`Mapped Codex auth file ${account.cliProxyAuthFile || "(missing filename)"} is missing.`)
        return false
      }
      if (file.unavailable) {
        failed.add(account.id)
        errors.push(`Mapped Codex auth file ${file.name} is unavailable.`)
        return false
      }
      const owner = mappedWorkspaceByFile.get(file.name)
      if (owner) {
        failed.add(account.id)
        errors.push(`Codex auth file ${file.name} is already mapped to another RawRoute workspace.`)
        return false
      }
      return true
    })
    if (activeMappings.length > 0 && accounts.length === 0) {
      throw new Error(errors[0] || "No eligible enabled Codex auth files were found; keeping the saved catalog.")
    }
    const observations = new Map<string, { name: string; accountIds: string[] }>()
    const deadline = Date.now() + 60_000
    await mapConcurrent(accounts, 4, async (account) => {
        try {
          if (Date.now() >= deadline) throw new Error("Model discovery deadline exceeded.")
          const response = await cliproxyManagement(`/v0/management/auth-files/models?name=${encodeURIComponent(account.cliProxyAuthFile!)}`, { signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())) })
          if (!response.ok) throw new Error(`CLIProxy model discovery failed (${response.status}).`)
          for (const [id, name] of parseCodexModels(await response.json(), prefix)) {
            const entry = observations.get(id) || { name, accountIds: [] }
            entry.accountIds.push(account.id)
            observations.set(id, entry)
          }
        } catch (error) {
          failed.add(account.id)
          errors.push(error instanceof Error ? error.message : "Model discovery failed.")
        }
    })
    const currentMappings = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-cli-proxy")
    const currentFiles = await listCliProxyCodexAuthFiles()
    const currentMappedWorkspaceByFile = await readMappedWorkspaces(currentMappings, workspaceId)
    if (startingAccounts !== accountSnapshot(currentMappings, currentFiles, currentMappedWorkspaceByFile)) throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    if (accounts.length > 0 && observations.size === 0 && errors.length > 0) {
      throw new Error(`${[...new Set(errors)].join(" ")} Keeping the saved catalog.`)
    }
    const existing = await listProviderModels(provider.id)
    const candidates = new Map(observations)
    for (const model of existing) {
      if ((model.source === "builtin" || model.source === "discovered") && !candidates.has(model.upstreamModel)) candidates.set(model.upstreamModel, { name: model.name, accountIds: [] })
    }
    const existingByGatewayId = new Map(existing.map((model) => [model.gatewayModelId, model]))
    await mapConcurrent([...candidates], 1, async ([id, observed]) => {
      const gatewayModelId = `codex/${id}`
      const model = existingByGatewayId.get(gatewayModelId)
      if (model && model.source !== "builtin" && model.source !== "discovered") { status.skipped++; return }
      const retained = model?.discovery?.accountIds.filter((accountId) => failed.has(accountId)) || []
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
    status.error = error instanceof Error ? error.message : "Model discovery failed."
  } finally {
    await localRedisSet(statusKey(workspaceId), JSON.stringify(status), 30 * 86400_000)
    if (lock) await localRedisCompareAndDelete(key, token)
  }
  return status
}
