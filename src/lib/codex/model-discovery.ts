import { cliproxyManagement, codexWorkspacePrefix, listCliProxyCodexAuthFiles } from "@/lib/codex/cliproxy"
import { localRedisCompareAndDelete, localRedisGet, localRedisSet, localRedisSetIfAbsent } from "@/lib/local-redis"
import { listProviderApiKeys, listProviderModels, listProviders, reconcileDiscoveredModel } from "@/lib/store"
import { currentWorkspaceId } from "@/lib/workspace/context"

export type CodexDiscoveryStatus = { attemptedAt: string; succeededAt?: string; error?: string; added: number; skipped: number }
const inflight = new Map<string, Promise<CodexDiscoveryStatus>>()
const ttl = 300_000
const statusKey = () => `rawroute:codex-models:${currentWorkspaceId()}:status`

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
  const task = refresh(force).finally(() => inflight.delete(workspaceId))
  inflight.set(workspaceId, task)
  return task
}

async function refresh(force: boolean): Promise<CodexDiscoveryStatus> {
  const previous = await codexDiscoveryStatus()
  if (!force && previous && Date.now() - Date.parse(previous.attemptedAt) < ttl) return previous
  const status: CodexDiscoveryStatus = { attemptedAt: new Date().toISOString(), succeededAt: previous?.succeededAt, added: 0, skipped: 0 }
  const key = `${statusKey()}:lock`
  const token = crypto.randomUUID()
  const lock = await localRedisSetIfAbsent(key, token, 120_000)
  if (lock === false) return previous || { ...status, error: "Model refresh is already running." }
  try {
    const provider = (await listProviders()).find((entry) => entry.prefix === "codex")
    if (!provider) return status
    const mappings = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-cli-proxy")
    const files = await listCliProxyCodexAuthFiles()
    const prefix = codexWorkspacePrefix(currentWorkspaceId())
    const accounts = mappings.filter((account) => files.some((file) => file.name === account.cliProxyAuthFile && file.prefix === prefix && !file.disabled))
    const accountSignature = (rows: typeof mappings, authFiles: typeof files) => JSON.stringify(rows.map((account) => {
      const file = authFiles.find((entry) => entry.name === account.cliProxyAuthFile)
      return [account.id, account.cliProxyAuthFile, file?.prefix, file?.disabled]
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    const startingAccounts = accountSignature(mappings, files)
    const observations = new Map<string, { name: string; accountIds: string[] }>()
    const failed = new Set<string>()
    const errors: string[] = []
    const deadline = Date.now() + 60_000
    for (let index = 0; index < accounts.length; index += 4) {
      await Promise.all(accounts.slice(index, index + 4).map(async (account) => {
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
      }))
    }
    const currentMappings = (await listProviderApiKeys(provider.id)).filter((entry) => entry.credentialKind === "codex-cli-proxy")
    if (startingAccounts !== accountSignature(currentMappings, await listCliProxyCodexAuthFiles())) throw new Error("Codex accounts changed during discovery. Refresh again to use the current accounts.")
    const existing = await listProviderModels(provider.id)
    const candidates = new Map(observations)
    for (const model of existing) {
      if ((model.source === "builtin" || model.source === "discovered") && !candidates.has(model.upstreamModel)) candidates.set(model.upstreamModel, { name: model.name, accountIds: [] })
    }
    for (const [id, observed] of candidates) {
      const gatewayModelId = `codex/${id}`
      const model = existing.find((entry) => entry.gatewayModelId === gatewayModelId)
      if (model && model.source !== "builtin" && model.source !== "discovered") { status.skipped++; continue }
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
    }
    if (errors.length) status.error = [...new Set(errors)].join(" ")
    else status.succeededAt = status.attemptedAt
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Model discovery failed."
  } finally {
    await localRedisSet(statusKey(), JSON.stringify(status), 30 * 86400_000)
    if (lock) await localRedisCompareAndDelete(key, token)
  }
  return status
}
