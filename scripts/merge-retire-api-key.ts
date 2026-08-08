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

const sourceKeyId = argument("--source-id", "17eb22fe-83ac-4e4d-adca-71ebc84fae0e")
const sourceKeyName = argument("--source-name", "CCS imported 09")
const targetKeyId = argument("--target-id", "qm7yMCP48nwrPHsD1Llq")
const targetKeyName = argument("--target-name", "Rizky")
const targetWorkspaceId = argument("--target-workspace", "nfNhLY9SfoepHOZBXAO2")
const targetWorkspaceName = argument("--target-workspace-name", "HT NonSHI")
const backupDirectory = process.env.KEY_MERGE_BACKUP_DIR || "/tmp/rawroute-key-merge-backup"
const apply = process.argv.includes("--apply")

const legacyCollections = ["rawroute_usage_events", "rawroute_usage_rollups"]
const targetEventsCollection = `rawroute_workspaces/${targetWorkspaceId}/usageEvents`
const targetRollupsCollection = `rawroute_workspaces/${targetWorkspaceId}/usageRollups`
const numericRollupFields = [
  "requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens",
  "costMicros", "pricedRequests", "unpricedRequests", "failedRequests",
]

function argument(name: string, fallback: string) {
  const value = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1).trim()
  return value || fallback
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function targetRollupPath(data: Record<string, unknown>) {
  const granularity = String(data.granularity || "")
  const bucketStart = String(data.bucketStart || "")
  const gatewayModelId = String(data.gatewayModelId || "")
  if (!granularity || !bucketStart || !gatewayModelId) throw new Error("A usage rollup is missing its dimensions.")
  return `${targetRollupsCollection}/${granularity}:${bucketStart}:${hash(`${targetKeyId}:${gatewayModelId}`)}`
}

function destinationPath(row: Row, data: Record<string, unknown>) {
  if (row.collection_path === "rawroute_usage_events") return `${targetEventsCollection}/${row.document_id}`
  if (row.collection_path === "rawroute_usage_rollups") return targetRollupPath(data)
  throw new Error(`Unsupported migration collection: ${row.collection_path}`)
}

function mergeRollupData(rows: Array<{ data: Record<string, unknown> }>, existing: Record<string, unknown> | undefined, path: string) {
  const first = rows[0]?.data
  if (!first) throw new Error(`No rollup data for ${path}.`)
  const next: Record<string, unknown> = { ...(existing || {}), ...first, id: path.slice(path.lastIndexOf("/") + 1), gatewayKeyId: targetKeyId }
  for (const field of numericRollupFields) {
    const moved = rows.reduce((total, row) => total + number(row.data[field]), 0)
    const previous = number(existing?.[field])
    if (moved > 0 || existing?.[field] !== undefined) next[field] = previous + moved
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

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
  return value
}

function sameData(left: unknown, right: unknown) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function backupRow(row: Row) {
  if (!row.path.endsWith(`/apiKeys/${sourceKeyId}`) && !row.path.endsWith(`/apiKeys/${targetKeyId}`)) return row
  return { ...row, data: { ...row.data, key: "[redacted]" } }
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")

    const read = async (sql: string, parameters: unknown[] = []) => (await client.query<Row>(sql, parameters)).rows
    const sourceKeys = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = $1", [`rawroute/apiKeys/apiKeys/${sourceKeyId}`])
    const targetKeys = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = $1", [`rawroute_workspaces/${targetWorkspaceId}/apiKeys/${targetKeyId}`])
    const workspaceRows = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = $1", [`rawroute_workspaces/${targetWorkspaceId}`])
    if (sourceKeys.length !== 1 || sourceKeys[0].data.name !== sourceKeyName) throw new Error(`Expected Default key ${sourceKeyName} was not found.`)
    if (targetKeys.length !== 1 || targetKeys[0].data.name !== targetKeyName) throw new Error(`Expected target key ${targetKeyName} was not found.`)
    if (workspaceRows.length !== 1 || workspaceRows[0].data.name !== targetWorkspaceName) throw new Error(`Expected target workspace ${targetWorkspaceName} was not found.`)

    const sourceIndexes = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = 'rawroute_api_key_indexes' AND data->>'apiKeyId' = $1", [sourceKeyId])
    const sourceUsage = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = ANY($1::text[]) AND (data->>'gatewayKeyId' = $2 OR data->>'apiKeyId' = $2)", [legacyCollections, sourceKeyId])
    const targetLegacyUsage = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = ANY($1::text[]) AND data->>'gatewayKeyId' = $2", [legacyCollections, targetKeyId])
    const movingRows = [...sourceUsage, ...targetLegacyUsage]
    const destinationPaths = [...new Set(movingRows.map((row) => destinationPath(row, { ...row.data, gatewayKeyId: targetKeyId })))]
    const destinationRows = destinationPaths.length
      ? await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE path = ANY($1::text[])", [destinationPaths])
      : []
    const sourceBudgetRows = await read("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE data->>'apiKeyId' = $1", [sourceKeyId])
    const allBefore = new Map<string, Row>()
    for (const row of [...sourceKeys, ...targetKeys, ...workspaceRows, ...sourceIndexes, ...movingRows, ...destinationRows, ...sourceBudgetRows]) allBefore.set(row.path, row)

    let backupPath: string | undefined
    if (apply) {
      await mkdir(backupDirectory, { recursive: true })
      backupPath = join(backupDirectory, `merge-retire-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}.jsonl`)
      await writeFile(backupPath, [...allBefore.values()].map((row) => JSON.stringify(backupRow(row))).join("\n") + "\n", "utf8")
    }

    const movedEvents = movingRows.filter((row) => row.collection_path === "rawroute_usage_events")
    const movedRollups = movingRows.filter((row) => row.collection_path === "rawroute_usage_rollups")
    const existingByPath = new Map(destinationRows.map((row) => [row.path, row]))
    const eventWrites = movedEvents.map((row) => {
      const data = { ...row.data, gatewayKeyId: targetKeyId }
      const path = destinationPath(row, data)
      const existing = existingByPath.get(path)
      if (existing && !sameData(existing.data, data)) throw new Error(`Destination event already exists with different data: ${path}`)
      return { path, collectionPath: targetEventsCollection, documentId: row.document_id, data }
    })
    const rollupGroups = new Map<string, Array<{ data: Record<string, unknown> }>>()
    for (const row of movedRollups) {
      const data = { ...row.data, gatewayKeyId: targetKeyId }
      const path = destinationPath(row, data)
      const rows = rollupGroups.get(path) || []
      rows.push({ data })
      rollupGroups.set(path, rows)
    }
    const rollupWrites = [...rollupGroups.entries()].map(([path, rows]) => {
      const existing = existingByPath.get(path)
      return { path, collectionPath: targetRollupsCollection, documentId: path.slice(path.lastIndexOf("/") + 1), data: mergeRollupData(rows, existing?.data, path) }
    })

    const deletions = [...new Set([
      ...movingRows.map((row) => row.path),
      sourceKeys[0].path,
      ...sourceIndexes.map((row) => row.path),
      ...sourceBudgetRows.map((row) => row.path),
    ])]
    if (apply) {
      for (const write of [...eventWrites, ...rollupWrites]) {
        await client.query(
          `INSERT INTO rawroute_documents (path, collection_path, document_id, data, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [write.path, write.collectionPath, write.documentId, JSON.stringify(write.data)],
        )
      }
      if (deletions.length) await client.query("DELETE FROM rawroute_documents WHERE path = ANY($1::text[])", [deletions])
      await client.query("COMMIT")
    } else {
      await client.query("ROLLBACK")
    }
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      sourceKey: { id: sourceKeyId, name: sourceKeyName },
      targetKey: { id: targetKeyId, name: targetKeyName, workspace: targetWorkspaceName },
      sourceUsageRows: sourceUsage.length,
      leakedTargetRows: targetLegacyUsage.length,
      eventWrites: eventWrites.length,
      rollupWrites: rollupWrites.length,
      deletedRows: deletions.length,
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
