import type { Database } from "bun:sqlite"

const tableName = "ai_codex_reset_schema"
const schemaVersion = 1

export function codexResetSchemaVersion(database: Database) {
  if (!database.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${tableName}'`).get()) return undefined
  return database.query<{ version: number }, []>(`SELECT version FROM ${tableName} WHERE id = 1`).get()?.version ?? null
}

export function createCodexResetSchema(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`)
  database.run(`INSERT OR REPLACE INTO ${tableName} (id, version) VALUES (1, ?)`, [schemaVersion])
}

export function hasCodexResetSchema(database: Database) {
  return codexResetSchemaVersion(database) === schemaVersion
}

/** Fresh databases start at the current layout; populated databases require offline conversion. */
export function ensureCodexResetSchema(database: Database, initial = false) {
  if (!initial) return
  const documents = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rawroute_documents'").get()
  if (!documents || !database.query("SELECT 1 FROM rawroute_documents LIMIT 1").get()) createCodexResetSchema(database)
}

export function assertCodexResetSchema(database: Database) {
  if (!hasCodexResetSchema(database)) throw new Error("Codex reset history requires offline migration: scripts/migrations/codex-reset-identity.ts")
}
