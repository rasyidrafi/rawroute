import { Database } from "bun:sqlite"
import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { prepareStorageSchema, storageSchemaVersion } from "@rawroute/gateway-storage/server/maintenance/schema"

export function migrateStorage(path: string, options: { apply?: boolean; writersStopped?: boolean; backup?: string } = {}) {
  if (!existsSync(path)) throw new Error("SQLite source must already exist.")
  if (options.apply && (!options.writersStopped || !options.backup || resolve(options.backup) === resolve(path))) throw new Error("Apply requires --writers-stopped and a new --backup file.")
  const database = new Database(path, options.apply ? { readwrite: true } : { readonly: true })
  try {
    const exists = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_schema'").get()
    if (exists) {
      if (database.query<{ version: number }, []>("SELECT version FROM storage_schema").get()?.version !== storageSchemaVersion) throw new Error("Unsupported existing Storage schema.")
      return { version: storageSchemaVersion, changed: false, applied: false }
    }
    if (!database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='rawroute_documents'").get()) throw new Error("Not a RawRoute SQLite database.")
    if (!options.apply) return { version: storageSchemaVersion, changed: true, applied: false }
    database.run("PRAGMA busy_timeout=5000")
    database.run("BEGIN EXCLUSIVE")
    try {
      prepareStorageSchema(database, () => writeFileSync(options.backup!, database.serialize(), { flag: "wx", mode: 0o600 }))
      database.run("COMMIT")
    } catch (error) { database.run("ROLLBACK"); throw error }
    return { version: storageSchemaVersion, changed: true, applied: true }
  } finally { database.close() }
}
if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const path = value("--sqlite")
  if (!path) throw new Error("Usage: storage.js --sqlite <file> [--apply --writers-stopped --backup <new-file>]")
  console.log(JSON.stringify(migrateStorage(path, { apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), backup: value("--backup") })))
}
