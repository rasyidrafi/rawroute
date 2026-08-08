import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { closeLocalDatabase, deleteLocalDocuments, listLocalDocuments, upsertLocalDocuments } from "@/lib/local-db"
import { startOfZonedDay, startOfZonedHour, startOfZonedMonth } from "@/lib/timezone"
import type { UsageRollup } from "@/lib/types"

type LegacyApiKeyRow = {
  id: string
  key: string
  name: string | null
  machineId: string | null
  isActive: number | null
  createdAt: string
}

type LegacyUsageRow = {
  timestamp: string
  provider: string | null
  model: string | null
  apiKey: string | null
  promptTokens: number | null
  completionTokens: number | null
  cost: number | null
}

type ApiKeyBinding = {
  id: string
  key: string
  name: string
  createdAt: string
  documentPath: string
  collectionPath: string
  rollupCollectionPath: string
  workspaceId: string
  workspaceStorageMode: "legacy" | "scoped"
}

type Aggregate = {
  granularity: UsageRollup["granularity"]
  bucketStart: string
  gatewayKeyId: string
  gatewayModelId: string
  rollupCollectionPath: string
  requests: number
  inputTokens: number
  outputTokens: number
  costMicros: number
  pricedRequests: number
  unpricedRequests: number
  lastEventAt: string
}

const args = process.argv.slice(2)
const inputPath = args[args.indexOf("--input") + 1] || "old-uage/9router-keyed-usage.sqlite"
// Asia/Jakarta's 5 August ends at 17:00 UTC. SQLite is authoritative through
// that boundary; Firestore is used for the later live period.
const cutoff = process.env.LEGACY_USAGE_CUTOFF || "2026-08-05T17:00:00.000Z"
const cutoffMs = Date.parse(cutoff)
if (!Number.isFinite(cutoffMs)) throw new Error(`Invalid LEGACY_USAGE_CUTOFF: ${cutoff}`)

const defaultApiKeysPath = "rawroute/apiKeys/apiKeys"
const legacyRollupsPath = "rawroute_usage_rollups"
const legacyKeyId = "legacy-9router"
const indexCollectionPath = "rawroute_api_key_indexes"
// These gateway keys were explicitly retired from the Default workspace. A
// future replay of the SQLite snapshot must not resurrect their credentials or
// historical usage after the deletion has been audited and applied.
const retiredGatewayKeyIds = new Set([
  "09f41154-9cc4-45c8-8ea9-8a8cde14b1e6",
  "0f66f287-bbb1-409e-a7b0-ddaccb1d8784",
])
const retiredGatewayKeyNames = new Set(["Unlimited GPT-5.3 Codex Spark", "CCS imported 18"])

function numeric(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function count(value: unknown) {
  return Math.max(0, Math.round(numeric(value)))
}

function costMicros(value: unknown) {
  const parsed = numeric(value)
  if (parsed < 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed * 1_000_000))
}

function hasRecordedCost(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function hasRecordedCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function modelId(provider: unknown, model: unknown) {
  const providerValue = typeof provider === "string" ? provider.trim() : ""
  const modelValue = typeof model === "string" ? model.trim() : ""
  if (!modelValue) return providerValue ? `${providerValue}/unknown` : "unknown"
  return providerValue ? `${providerValue}/${modelValue}` : modelValue
}

function bucketStart(timestamp: string, granularity: UsageRollup["granularity"]) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return undefined
  if (granularity === "hourly") return startOfZonedHour(date).toISOString()
  if (granularity === "monthly") return startOfZonedMonth(date).toISOString()
  return startOfZonedDay(date).toISOString()
}

function aggregateKey(aggregate: Pick<Aggregate, "granularity" | "bucketStart" | "gatewayKeyId" | "gatewayModelId" | "rollupCollectionPath">) {
  return [aggregate.rollupCollectionPath, aggregate.granularity, aggregate.bucketStart, aggregate.gatewayKeyId, aggregate.gatewayModelId].join("\u0000")
}

function keyHash(value: string) {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex")
}

function rollupId(granularity: UsageRollup["granularity"], bucket: string, gatewayKeyId: string, gatewayModelId: string) {
  const suffix = createHash("sha256").update(`${gatewayKeyId}:${gatewayModelId}`).digest("hex").slice(0, 24)
  return `${granularity}:${bucket}:${suffix}`
}

function directApiKeyBinding(path: string, data: Record<string, unknown>): ApiKeyBinding | undefined {
  if (typeof data.key !== "string" || typeof data.name !== "string" || typeof data.createdAt !== "string") return undefined
  const collectionPath = path.slice(0, path.lastIndexOf("/"))
  if (collectionPath === defaultApiKeysPath) {
    const id = path.slice(path.lastIndexOf("/") + 1)
    return {
      id,
      key: data.key.trim(),
      name: data.name,
      createdAt: data.createdAt,
      documentPath: path,
      collectionPath,
      rollupCollectionPath: legacyRollupsPath,
      workspaceId: "default",
      workspaceStorageMode: "legacy",
    }
  }
  const segments = collectionPath.split("/")
  if (segments.length !== 3 || segments[0] !== "rawroute_workspaces" || segments[2] !== "apiKeys") return undefined
  const id = path.slice(path.lastIndexOf("/") + 1)
  return {
    id,
    key: data.key.trim(),
    name: data.name,
    createdAt: data.createdAt,
    documentPath: path,
    collectionPath,
    rollupCollectionPath: `${segments[0]}/${segments[1]}/usageRollups`,
    workspaceId: segments[1],
    workspaceStorageMode: "scoped",
  }
}

function toRollup(aggregate: Aggregate): UsageRollup {
  const id = rollupId(aggregate.granularity, aggregate.bucketStart, aggregate.gatewayKeyId, aggregate.gatewayModelId)
  return {
    id,
    granularity: aggregate.granularity,
    bucketStart: aggregate.bucketStart,
    gatewayKeyId: aggregate.gatewayKeyId,
    gatewayModelId: aggregate.gatewayModelId,
    requests: aggregate.requests,
    inputTokens: aggregate.inputTokens,
    outputTokens: aggregate.outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: aggregate.inputTokens + aggregate.outputTokens,
    costMicros: aggregate.costMicros,
    pricedRequests: aggregate.pricedRequests,
    unpricedRequests: aggregate.unpricedRequests,
    lastEventAt: aggregate.lastEventAt,
    updatedAt: new Date().toISOString(),
    backfillSource: "legacy-9router-keyed-usage-history",
    ...(aggregate.unpricedRequests === 0 ? { costSource: "provider-recorded" as const } : {}),
  } as UsageRollup
}

function isRollupCollection(collectionPath: string) {
  return collectionPath === legacyRollupsPath || /^rawroute_workspaces\/[^/]+\/usageRollups$/.test(collectionPath)
}

function rollupCleanupBoundaries(firstTimestamp: string) {
  return {
    hourly: startOfZonedHour(new Date(firstTimestamp)).toISOString(),
    daily: startOfZonedDay(new Date(firstTimestamp)).toISOString(),
  } satisfies Pick<Record<UsageRollup["granularity"], string>, "hourly" | "daily">
}

async function writeBatches(documents: Array<{ path: string; data: object }>, label: string) {
  const batchSize = 300
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const batch = documents.slice(offset, offset + batchSize)
    await upsertLocalDocuments(batch)
    process.stdout.write(`${label} ${Math.min(offset + batch.length, documents.length)}/${documents.length}\n`)
  }
}

async function deleteBatches(paths: string[], label: string) {
  const batchSize = 300
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const batch = paths.slice(offset, offset + batchSize)
    await deleteLocalDocuments(batch)
    process.stdout.write(`${label} ${Math.min(offset + batch.length, paths.length)}/${paths.length}\n`)
  }
}

async function main() {
  const sqlite = new DatabaseSync(inputPath, { readOnly: true })
  const aggregates = new Map<string, Aggregate>()
  const apiKeyRows = [...sqlite.prepare("SELECT id, key, name, machineId, isActive, createdAt FROM apiKeys ORDER BY createdAt, id").iterate()] as unknown as LegacyApiKeyRow[]
  let sourceRows = 0
  let skippedRows = 0
  let firstTimestamp: string | undefined
  const unknownUsageKeys = new Set<string>()
  const retiredUsageKeyValues = new Set<string>()

  try {
    const localDocuments = await listLocalDocuments()
    const localByValue = new Map<string, ApiKeyBinding>()
    for (const document of localDocuments) {
      const binding = directApiKeyBinding(document.path, document.data)
      if (!binding) continue
      const existing = localByValue.get(binding.key)
      if (existing && existing.documentPath !== binding.documentPath) {
        throw new Error(`Duplicate API key value exists in ${existing.documentPath} and ${binding.documentPath}.`)
      }
      localByValue.set(binding.key, binding)
    }

    const bindingsByValue = new Map<string, ApiKeyBinding>()
    const keyDocuments: Array<{ path: string; data: object }> = []
    const obsoleteLegacyKeyIds = new Set<string>()
    for (const row of apiKeyRows) {
      const value = typeof row.key === "string" ? row.key.trim() : ""
      if (!value) continue
      if (retiredGatewayKeyIds.has(row.id) || (typeof row.name === "string" && retiredGatewayKeyNames.has(row.name.trim()))) {
        retiredUsageKeyValues.add(value)
        continue
      }
      let binding = localByValue.get(value)
      if (!binding) {
        const id = row.id || `sqlite-${keyHash(value).slice(0, 24)}`
        const documentPath = `${defaultApiKeysPath}/${id}`
        binding = {
          id,
          key: value,
          name: row.name?.trim() || `API key ${id}`,
          createdAt: row.createdAt,
          documentPath,
          collectionPath: defaultApiKeysPath,
          rollupCollectionPath: legacyRollupsPath,
          workspaceId: "default",
          workspaceStorageMode: "legacy",
        }
        const data: Record<string, unknown> = {
          key: value,
          name: binding.name,
          createdAt: binding.createdAt,
        }
        if (row.machineId) data.machineId = row.machineId
        if (row.isActive !== null && row.isActive !== undefined) data.isActive = Boolean(row.isActive)
        keyDocuments.push({ path: documentPath, data })
      }
      const duplicate = bindingsByValue.get(value)
      if (duplicate && duplicate.documentPath !== binding.documentPath) throw new Error(`Duplicate SQLite API key value maps to ${duplicate.documentPath} and ${binding.documentPath}.`)
      if (row.id && binding.id !== row.id) obsoleteLegacyKeyIds.add(row.id)
      bindingsByValue.set(value, binding)
    }

    await writeBatches(keyDocuments, "Imported exact API key documents")
    const indexDocuments = [...bindingsByValue.values()].map((binding) => ({
      path: `${indexCollectionPath}/${keyHash(binding.key)}`,
      data: {
        workspaceId: binding.workspaceId,
        workspaceStorageMode: binding.workspaceStorageMode,
        apiKeyId: binding.id,
        name: binding.name,
        createdAt: binding.createdAt,
      },
    }))
    await writeBatches(indexDocuments, "Rebuilt API key indexes")

    const rows = sqlite.prepare(`
      SELECT timestamp, provider, model, apiKey, promptTokens, completionTokens, cost
      FROM usageHistory
      WHERE timestamp < ?
      ORDER BY timestamp ASC
    `).iterate(cutoff) as Iterable<LegacyUsageRow>

    for (const row of rows) {
      sourceRows += 1
      const timestamp = typeof row.timestamp === "string" ? row.timestamp : ""
      const timestampMs = Date.parse(timestamp)
      if (!Number.isFinite(timestampMs) || timestampMs >= cutoffMs) {
        skippedRows += 1
        continue
      }
      const apiKeyValue = typeof row.apiKey === "string" ? row.apiKey.trim() : ""
      if (retiredUsageKeyValues.has(apiKeyValue)) {
        skippedRows += 1
        continue
      }
      const binding = bindingsByValue.get(apiKeyValue)
      if (!binding) {
        if (apiKeyValue) unknownUsageKeys.add(apiKeyValue)
        skippedRows += 1
        continue
      }
      if (!firstTimestamp) firstTimestamp = timestamp
      const gatewayModelId = modelId(row.provider, row.model)
      // Monthly rows span the SQLite/Firestore cutoff and cannot be safely
      // replaced by a pre-cutoff-only aggregate. Runtime long-range views
      // derive monthly charts from daily rows when monthly persistence is off.
      for (const granularity of ["hourly", "daily"] as const) {
        const bucket = bucketStart(timestamp, granularity)
        if (!bucket) continue
        const aggregate: Aggregate = {
          granularity,
          bucketStart: bucket,
          gatewayKeyId: binding.id,
          gatewayModelId,
          rollupCollectionPath: binding.rollupCollectionPath,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          lastEventAt: timestamp,
        }
        const key = aggregateKey(aggregate)
        const current = aggregates.get(key) || aggregate
        current.requests += 1
        current.inputTokens += count(row.promptTokens)
        current.outputTokens += count(row.completionTokens)
        current.costMicros += costMicros(row.cost)
        if (hasRecordedCost(row.cost) && hasRecordedCount(row.promptTokens) && hasRecordedCount(row.completionTokens)) current.pricedRequests += 1
        else current.unpricedRequests += 1
        if (current.lastEventAt < timestamp) current.lastEventAt = timestamp
        aggregates.set(key, current)
      }
    }

    if (unknownUsageKeys.size) throw new Error(`SQLite usage contains ${unknownUsageKeys.size} API key value(s) absent from apiKeys.`)
    if (!firstTimestamp) throw new Error(`SQLite usage contains no rows before ${cutoff}.`)

    const boundaries = rollupCleanupBoundaries(firstTimestamp)
    const keyIds = new Set([...bindingsByValue.values()].map((binding) => binding.id))
    const existing = await listLocalDocuments()
    const obsoletePaths = existing
      .filter((document) => {
        if (document.path === `${defaultApiKeysPath}/${legacyKeyId}`) return true
        if (document.collection_path === indexCollectionPath && document.data.apiKeyId === legacyKeyId) return true
        if (document.collection_path === defaultApiKeysPath && (retiredGatewayKeyIds.has(document.document_id) || (typeof document.data.name === "string" && retiredGatewayKeyNames.has(document.data.name.trim())))) return true
        if (!isRollupCollection(document.collection_path)) return false
        if (retiredGatewayKeyIds.has(String(document.data.gatewayKeyId || "")) || (typeof document.data.gatewayKeyName === "string" && retiredGatewayKeyNames.has(document.data.gatewayKeyName.trim()))) return true
        if (document.data.gatewayKeyId === legacyKeyId || (typeof document.data.gatewayKeyId === "string" && obsoleteLegacyKeyIds.has(document.data.gatewayKeyId))) return true
        if (typeof document.data.gatewayKeyId !== "string" || !keyIds.has(document.data.gatewayKeyId)) return false
        const granularity = document.data.granularity as UsageRollup["granularity"]
        if (granularity !== "hourly" && granularity !== "daily") return false
        const lower = boundaries[granularity]
        const bucket = typeof document.data.bucketStart === "string" ? document.data.bucketStart : ""
        return Boolean(lower && bucket >= lower && bucket < cutoff)
      })
      .map((document) => document.path)
    await deleteBatches([...new Set(obsoletePaths)], "Removed superseded or virtual usage documents")

    const documents = [...aggregates.values()]
      .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart) || left.gatewayKeyId.localeCompare(right.gatewayKeyId) || left.gatewayModelId.localeCompare(right.gatewayModelId) || left.granularity.localeCompare(right.granularity))
      .map((aggregate) => {
        const rollup = toRollup(aggregate)
        return { path: `${aggregate.rollupCollectionPath}/${rollup.id}`, data: rollup }
      })
    await writeBatches(documents, "Imported keyed SQLite usage rollups")

    const dailyTotals = new Map<string, { name: string; requests: number; costMicros: number }>()
    for (const aggregate of aggregates.values()) {
      if (aggregate.granularity !== "daily") continue
      const binding = [...bindingsByValue.values()].find((candidate) => candidate.id === aggregate.gatewayKeyId)
      if (!binding) continue
      const current = dailyTotals.get(binding.id) || { name: binding.name, requests: 0, costMicros: 0 }
      current.requests += aggregate.requests
      current.costMicros += aggregate.costMicros
      dailyTotals.set(binding.id, current)
    }
    const totals = [...dailyTotals.values()].reduce((result, value) => {
      result.requests += value.requests
      result.costMicros += value.costMicros
      return result
    }, { requests: 0, costMicros: 0 })

    console.log(JSON.stringify({
      ok: true,
      inputPath,
      cutoff,
      firstTimestamp,
      sourceRows,
      skippedRows,
      apiKeysInSqlite: apiKeyRows.length,
      exactApiKeysBound: bindingsByValue.size,
      newApiKeyDocuments: keyDocuments.length,
      rollupDocuments: documents.length,
      dailyRows: [...aggregates.values()].filter((aggregate) => aggregate.granularity === "daily").length,
      hourlyRows: [...aggregates.values()].filter((aggregate) => aggregate.granularity === "hourly").length,
      monthlyRows: [...aggregates.values()].filter((aggregate) => aggregate.granularity === "monthly").length,
      cleanupBoundaries: boundaries,
      totals,
      costUsd: totals.costMicros / 1_000_000,
      usageByApiKey: [...dailyTotals.entries()].map(([id, value]) => ({ id, ...value, costUsd: value.costMicros / 1_000_000 })).sort((left, right) => right.requests - left.requests),
    }, null, 2))
  } finally {
    sqlite.close()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => closeLocalDatabase())
