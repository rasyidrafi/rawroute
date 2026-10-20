import { getDatabase, installDocumentIntegration, withTransaction, type DocumentIntegration } from "@rawroute/platform/server/database"
import { assertUsageProjection, projectSqliteUsage, usagePrefix, usageWorkspace } from "./usage-projection"
import { readSqliteUsageRange } from "./usage-range"
import type { RequestLogQuery } from "./request-logs"
import type { UsageEvent } from "../contracts/domain"
import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { aiDocumentAudit } from "./ai-audit"
import { appendAuditSqlite } from "@rawroute/platform/server/audit"
import { assertWorkspaceActivity } from "@rawroute/platform/server/workspace-activity"

// Application persistence composition. All callbacks execute on the platform's
// single connection, inside its existing transaction/queue boundary.
const usageIntegration: DocumentIntegration = {
  initialize(database, initial) {
    if (initial) {
      database.run("CREATE INDEX IF NOT EXISTS rawroute_documents_collection_completed_idx ON rawroute_documents (collection_path, json_extract(data, '$.completedAt'))")
      database.run("CREATE INDEX IF NOT EXISTS rawroute_documents_request_logs_idx ON rawroute_documents (collection_path, json_extract(data, '$.completedAt') DESC, document_id ASC)")
    }
    assertUsageProjection(database, initial)
  },
  validateCollection(collection) {
    const parts = collection.split("/")
    if (parts[0] === `${usagePrefix()}_workspaces` && parts.length >= 3) assertWorkspaceActivity(parts[1]!)
    if (usageWorkspace(collection, "usageRollups") !== undefined || collection === `${usagePrefix()}_usage_events` || collection === `${usagePrefix()}_usage_rollups`) throw new Error("Usage archives are immutable; use an offline projection rebuild")
  },
  tracks: (collection) => usageWorkspace(collection, "usageEvents") !== undefined || aiDocumentAudit(collection, undefined, {}) !== undefined,
  changed(database, collection, path, before, after) {
    const audit = aiDocumentAudit(collection, before, after)
    if (audit) appendAuditSqlite(database, audit)
    if (usageWorkspace(collection, "usageEvents") === undefined) return
    projectSqliteUsage(database, collection, usageWorkspace(collection, "usageEvents")!, before, after)
    if (!after) database.run("UPDATE usage_projection_history SET reason = ? WHERE disposition = 'duplicate' AND reason = ?", [`canonical-copy-deleted:${path}`, `canonical-copy:${path}`])
  },
  async deletingTree(database, prefix, client, deleteDocument) {
    const root = prefix.split("/")
    if (prefix === `${usagePrefix()}_workspaces`) {
      database.run("DELETE FROM usage_buckets")
      database.run("DELETE FROM usage_projection_history")
    } else if (root.length === 2 && root[0] === `${usagePrefix()}_workspaces`) {
      database.run("DELETE FROM usage_buckets WHERE workspaceId = ?", [root[1]!])
      database.run("DELETE FROM usage_projection_history WHERE workspaceId = ?", [root[1]!])
    } else {
      const rows = await client.query("SELECT path, collection_path, data FROM rawroute_documents WHERE (path = $1 OR substr(path, 1, length($2)) = $2) AND substr(collection_path, 1, length($3)) = $3 AND substr(collection_path, -12) = '/usageEvents'", [prefix, `${prefix}/`, `${usagePrefix()}_workspaces/`])
      await mapConcurrent(rows.rows.filter(row => usageWorkspace(row.collection_path, "usageEvents") !== undefined), 1, row => deleteDocument(row.path))
    }
  },
}

export function initializeAiPersistence() {
  installDocumentIntegration(usageIntegration)
}

export async function queryLocalUsageRange(workspaceId: string, from: string, to: string, hourly = false, keyId?: string) {
  initializeAiPersistence()
  return withTransaction(async () => readSqliteUsageRange(getDatabase(), workspaceId, `${usagePrefix()}_workspaces/${workspaceId}/usageEvents`, from, to, hourly, keyId))
}

export async function queryLocalRequestLogs(collectionPath: string, query: RequestLogQuery) {
  initializeAiPersistence()
  return withTransaction(async client => {
    const result = await client.query(`
      SELECT document_id, data FROM rawroute_documents
      WHERE collection_path = $1
        AND json_extract(data, '$.completedAt') >= $2
        AND json_extract(data, '$.completedAt') < $3
        AND ($4 = '' OR json_extract(data, '$.gatewayModelId') = $4)
        AND ($5 = '' OR json_extract(data, '$.gatewayKeyId') = $5)
        AND ($6 = 'all'
          OR ($6 = 'success' AND json_extract(data, '$.status') >= 200 AND json_extract(data, '$.status') < 300)
          OR ($6 NOT IN ('all', 'success') AND (json_extract(data, '$.status') < 200 OR json_extract(data, '$.status') >= 300)))
        AND ($7 IS NULL OR json_extract(data, '$.completedAt') < $7
          OR (json_extract(data, '$.completedAt') = $7 AND document_id > $8))
      ORDER BY json_extract(data, '$.completedAt') DESC, document_id ASC LIMIT 26
    `, [collectionPath, query.from, query.to, query.model || "", query.key || "", query.status, query.after?.at ?? null, query.after?.id ?? null])
    return result.rows.map(row => ({ ...row.data, id: row.document_id }) as unknown as UsageEvent)
  })
}
