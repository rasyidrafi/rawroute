import type { Database } from "bun:sqlite"

/**
 * Codex OAuth credential persistence is schema-gated: databases created
 * before the feature carry external auth-file mappings only and must be converted by the
 * stopped-writer CLI before request-time use. The marker is created only for
 * empty (fresh) databases here, so an existing database is never silently
 * upgraded; the offline conversion in `scripts/migrations/codex-credentials.ts`
 * owns the transition and raises this version.
 */
const tableName = "ai_codex_credential_schema"
const schemaVersion = 1

export function codexCredentialSchemaVersion(database: Database) {
  if (!database.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${tableName}'`).get()) return undefined
  return database.query<{ version: number }, []>(`SELECT version FROM ${tableName} WHERE id = 1`).get()?.version ?? null
}

export function createCodexCredentialSchema(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`)
  database.run(`INSERT OR REPLACE INTO ${tableName} (id, version) VALUES (1, ?)`, [schemaVersion])
}

export function hasCodexCredentialSchema(database: Database) {
  return codexCredentialSchemaVersion(database) === schemaVersion
}

/** Fresh databases receive the marker; populated databases must be offline-migrated. */
export function ensureCodexCredentialSchema(database: Database, initial = false) {
  if (!initial) return
  const documents = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rawroute_documents'").get()
  if (!documents || !database.query("SELECT 1 FROM rawroute_documents LIMIT 1").get()) createCodexCredentialSchema(database)
}

/** Request-time guard: refuse to serve Codex credentials from an unconverted database. */
export function assertCodexCredentialSchema(database: Database) {
  if (!hasCodexCredentialSchema(database)) throw new Error("Codex credentials require offline migration: scripts/migrations/codex-credentials.ts")
}
