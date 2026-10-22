import type { Database } from "bun:sqlite"

const indexName = "rawroute_documents_request_scope_idx"

/** The owner sees each shared execution; ingress correlation still belongs to the consumer. */
export function requestLogIdentitySql(alias: "" | "d" = "") {
  const prefix = alias ? `${alias}.` : ""
  return `CASE WHEN json_extract(${prefix}data, '$.sharedUsage.role') = 'owner' THEN ${prefix}document_id ELSE COALESCE(json_extract(${prefix}data, '$.requestId'), ${prefix}document_id) END`
}

export function createRequestLogSchema(database: Database) {
  database.run(`CREATE INDEX IF NOT EXISTS ${indexName} ON rawroute_documents (collection_path, (${requestLogIdentitySql()}), COALESCE(json_extract(data, '$.gatewayKeyId'), ''))`)
  database.run("DROP INDEX IF EXISTS rawroute_documents_request_chain_idx")
}

export function hasRequestLogSchema(database: Database) {
  return Boolean(database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName))
}

export function assertRequestLogSchema(database: Database, initial = false) {
  if (initial && !hasRequestLogSchema(database)) {
    const legacy = database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'rawroute_documents_request_chain_idx'").get()
    const populated = database.query("SELECT 1 FROM rawroute_documents LIMIT 1").get()
    // Startup may bootstrap an empty database, but upgrades require the stopped-writer CLI.
    if (!legacy && !populated) createRequestLogSchema(database)
  }
  if (!hasRequestLogSchema(database)) throw new Error("Workspace-scoped request logs require offline migration: scripts/migrations/request-log-groups.ts")
}
