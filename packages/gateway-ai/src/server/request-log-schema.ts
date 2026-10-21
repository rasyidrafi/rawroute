import type { Database } from "bun:sqlite"

const indexName = "rawroute_documents_request_chain_idx"

export function createRequestLogSchema(database: Database) {
  database.run(`CREATE INDEX IF NOT EXISTS ${indexName} ON rawroute_documents (collection_path, COALESCE(json_extract(data, '$.requestId'), document_id), COALESCE(json_extract(data, '$.gatewayKeyId'), ''))`)
}

export function assertRequestLogSchema(database: Database, initial = false) {
  if (initial) createRequestLogSchema(database)
  if (!database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName)) throw new Error("Request log grouping requires offline migration: scripts/migrations/request-log-groups.ts")
}
