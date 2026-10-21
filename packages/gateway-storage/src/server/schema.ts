import type { Database } from "bun:sqlite"

export const storageSchemaVersion = 1
// Shared by the stopped-writer CLI and pre-runtime startup, under an exclusive
// transaction. Existing databases are backed up before additive DDL.
export function prepareStorageSchema(database: Database, backup: () => void) {
  const table = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_schema'").get()
  if (table) {
    if (database.query<{ version: number }, []>("SELECT version FROM storage_schema").get()?.version !== storageSchemaVersion) throw new Error("Unsupported existing Storage schema.")
    return false
  }
  if (database.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) backup()
  installStorageSchema(database)
  return true
}
export function installStorageSchema(database: Database) {
  database.run("CREATE TABLE IF NOT EXISTS storage_schema (version INTEGER PRIMARY KEY CHECK(version = 1))")
  database.run("INSERT OR IGNORE INTO storage_schema VALUES (1)")
  database.run("CREATE TABLE IF NOT EXISTS storage_records (kind TEXT NOT NULL, id TEXT NOT NULL, workspace_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id))")
  database.run("CREATE INDEX IF NOT EXISTS storage_workspace ON storage_records(workspace_id,kind)")
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS storage_bucket_name ON storage_records(json_extract(data,'$.name')) WHERE kind='bucket'")
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS storage_remote_bucket ON storage_records(json_extract(data,'$.remoteIdentity')) WHERE kind='bucket'")
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS storage_access_key ON storage_records(json_extract(data,'$.accessKeyId')) WHERE kind='key'")
}
export function assertStorageSchema(database: Database, initial?: boolean) {
  if (!initial) return
  const table = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_schema'").get()
  if (!table) {
    const existing = database.query<{ count: number }, []>("SELECT count(*) AS count FROM rawroute_documents").get()!.count
    if (existing) throw new Error("Storage persistence was not prepared before opening the database. Restart with STORAGE_ENABLED=true.")
    installStorageSchema(database)
  }
  const version = database.query<{ version: number }, []>("SELECT version FROM storage_schema").get()?.version
  if (version !== storageSchemaVersion) throw new Error("Unsupported storage schema version.")
}
