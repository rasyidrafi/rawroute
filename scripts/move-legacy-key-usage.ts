import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { loadEnvConfig } from "@next/env"
import { Client } from "pg"

loadEnvConfig(process.cwd())

type Row = {
  path: string
  collection_path: string
  document_id: string
  data: Record<string, unknown>
}

const apiKeyId = argument("--api-key-id")
const apply = process.argv.includes("--apply")
const backupDirectory = process.env.KEY_USAGE_BACKUP_DIR || "/tmp/rawroute-key-usage-backup"
const legacyCollections = ["rawroute_usage_events", "rawroute_usage_rollups"]
const numericRollupFields = [
  "requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens",
  "costMicros", "pricedRequests", "unpricedRequests", "failedRequests",
]

function argument(name: string) {
  const value = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1).trim()
  return value || ""
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
  return value
}

function sameData(left: unknown, right: unknown) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(key|apiKey|value|secret|token|password)$/i.test(key) ? "[redacted]" : redacted(item),
  ]))
}

function eventDestination(collection: string, documentId: string, workspaceId: string) {
  return `rawroute_workspaces/${workspaceId}/usageEvents/${documentId}`
}

function rollupDestination(data: Record<string, unknown>, workspaceId: string, keyId: string) {
  const granularity = String(data.granularity || "")
  const bucketStart = String(data.bucketStart || "")
  const model = String(data.gatewayModelId || "")
  if (!granularity || !bucketStart || !model) throw new Error("A legacy usage rollup is missing its dimensions.")
  return `rawroute_workspaces/${workspaceId}/usageRollups/${granularity}:${bucketStart}:${hash(`${keyId}:${model}`)}`
}

function usageDestination(row: Row, data: Record<string, unknown>, workspaceId: string, keyId: string) {
  if (row.collection_path === "rawroute_usage_events") return eventDestination(row.collection_path, row.document_id, workspaceId)
  if (row.collection_path === "rawroute_usage_rollups") return rollupDestination(data, workspaceId, keyId)
  throw new Error(`Unsupported legacy collection: ${row.collection_path}`)
}

function mergeRollup(rows: Array<{ data: Record<string, unknown> }>, existing: Record<string, unknown> | undefined, path: string, keyId: string) {
  const first = rows[0]?.data
  if (!first) throw new Error(`No rollup data for ${path}.`)
  const next: Record<string, unknown> = { ...(existing || {}), ...first, id: path.slice(path.lastIndexOf("/") + 1), gatewayKeyId: keyId }
  for (const field of numericRollupFields) {
    const moved = rows.reduce((total, row) => total + number(row.data[field]), 0)
    if (moved > 0 || existing?.[field] !== undefined) next[field] = number(existing?.[field]) + moved
  }
  const excluded = new Set<string>()
  for (const value of [existing?.excludedEventIds, ...rows.map((row) => row.data.excludedEventIds)]) {
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item) excluded.add(item)
  }
  if (excluded.size) next.excludedEventIds = [...excluded]
  const lastEventAt = [existing?.lastEventAt, ...rows.map((row) => row.data.lastEventAt)]
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .sort()
    .at(-1)
  if (lastEventAt) next.lastEventAt = lastEventAt
  next.updatedAt = new Date().toISOString()
  return next
}

async function main() {
  if (!apiKeyId) throw new Error("Pass --api-key-id=<gateway key id>.")

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    const read = async (sql: string, parameters: unknown[] = []) => (await client.query<Row>(sql, parameters)).rows
    const indexes = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = 'rawroute_api_key_indexes' AND data->>'apiKeyId' = $1", [apiKeyId])
    if (indexes.length !== 1) throw new Error(`Expected one API-key index for the supplied id; found ${indexes.length}.`)
    const index = indexes[0].data
    const workspaceId = typeof index.workspaceId === "string" ? index.workspaceId : ""
    const workspaceStorageMode = typeof index.workspaceStorageMode === "string" ? index.workspaceStorageMode : ""
    const keyName = typeof index.name === "string" ? index.name : ""
    if (!workspaceId || workspaceId === "default" || workspaceStorageMode !== "scoped") throw new Error("The key is not an additional scoped-workspace key; refusing to move legacy Default data.")

    const workspaceRows = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = $1", [`rawroute_workspaces/${workspaceId}`])
    const keyRows = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = $1", [`rawroute_workspaces/${workspaceId}/apiKeys/${apiKeyId}`])
    if (workspaceRows.length !== 1 || keyRows.length !== 1 || keyRows[0].data.name !== keyName) throw new Error("The scoped workspace key record did not match the API-key index.")

    const sourceUsage = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = ANY($1::text[]) AND (data->>'gatewayKeyId' = $2 OR data->>'apiKeyId' = $2)", [legacyCollections, apiKeyId])
    const destinationPaths = sourceUsage.map((row) => usageDestination(row, { ...row.data, gatewayKeyId: apiKeyId }, workspaceId, apiKeyId))
    const destinationRows = destinationPaths.length
      ? await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = ANY($1::text[])", [destinationPaths])
      : []
    if (destinationRows.some((row) => row.collection_path.endsWith("usageEvents"))) throw new Error("A destination usage event already exists; refusing to risk double-counting.")

    const allBefore = [...indexes, ...workspaceRows, ...keyRows, ...sourceUsage, ...destinationRows]
    let backupPath: string | undefined
    if (apply) {
      await mkdir(backupDirectory, { recursive: true })
      backupPath = join(backupDirectory, `move-legacy-key-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}.jsonl`)
      await writeFile(backupPath, allBefore.map((row) => JSON.stringify({ ...row, data: redacted(row.data) })).join("\n") + "\n", "utf8")
    }

    const existingByPath = new Map(destinationRows.map((row) => [row.path, row]))
    const eventRows = sourceUsage.filter((row) => row.collection_path === "rawroute_usage_events")
    const rollupRows = sourceUsage.filter((row) => row.collection_path === "rawroute_usage_rollups")
    const eventWrites = eventRows.map((row) => {
      const data = { ...row.data, gatewayKeyId: apiKeyId }
      const path = usageDestination(row, data, workspaceId, apiKeyId)
      const existing = existingByPath.get(path)
      if (existing && !sameData(existing.data, data)) throw new Error(`Destination event differs: ${path}`)
      return { path, collectionPath: `rawroute_workspaces/${workspaceId}/usageEvents`, documentId: row.document_id, data }
    })
    const rollupGroups = new Map<string, Array<{ data: Record<string, unknown> }>>()
    for (const row of rollupRows) {
      const data = { ...row.data, gatewayKeyId: apiKeyId }
      const path = usageDestination(row, data, workspaceId, apiKeyId)
      const group = rollupGroups.get(path) || []
      group.push({ data })
      rollupGroups.set(path, group)
    }
    const rollupWrites = [...rollupGroups.entries()].map(([path, rows]) => ({
      path,
      collectionPath: `rawroute_workspaces/${workspaceId}/usageRollups`,
      documentId: path.slice(path.lastIndexOf("/") + 1),
      data: mergeRollup(rows, existingByPath.get(path)?.data, path, apiKeyId),
    }))

    if (apply) {
      for (const write of [...eventWrites, ...rollupWrites]) {
        await client.query(
          `INSERT INTO rawroute_documents (path, collection_path, document_id, data, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [write.path, write.collectionPath, write.documentId, JSON.stringify(write.data)],
        )
      }
      await client.query("DELETE FROM rawroute_documents WHERE path = ANY($1::text[])", [sourceUsage.map((row) => row.path)])
      await client.query("COMMIT")
    } else {
      await client.query("ROLLBACK")
    }
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      keyName,
      workspaceId,
      sourceUsageRows: sourceUsage.length,
      sourceEvents: eventRows.length,
      sourceRollups: rollupRows.length,
      destinationRows: destinationRows.length,
      eventWrites: eventWrites.length,
      rollupWrites: rollupWrites.length,
      backupPath,
    }, null, 2))
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
