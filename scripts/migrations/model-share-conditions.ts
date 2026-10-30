import { Database } from "bun:sqlite"
import { chmodSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"

type Row = { path: string; data: string }

/** Existing grants remain unconditional; no grants, identities or history are removed. */
export function migrateModelShareConditions(file: string, options: { apply?: boolean; writersStopped?: boolean; backup?: string } = {}) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing --sqlite path is required")
  if (options.apply && !options.writersStopped) throw new Error("Stop all writers and pass --writers-stopped before --apply")
  const database = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  try {
    if (!database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rawroute_documents'").get()) throw new Error("RawRoute document table is missing")
    if (options.apply) {
      database.run("PRAGMA busy_timeout = 0")
      database.run("PRAGMA locking_mode = EXCLUSIVE")
      database.run("BEGIN EXCLUSIVE")
      database.run("COMMIT")
    }
    const rows = database.query<Row, [string]>("SELECT path, data FROM rawroute_documents WHERE collection_path = ? ORDER BY path").all(`${collectionPrefix(database)}_model_shares`)
    const writes = rows.flatMap(row => {
      const data = JSON.parse(row.data) as Record<string, unknown>
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid model-share document")
      if (typeof data.onlyDuringUnlimited === "boolean") return []
      if (Object.hasOwn(data, "onlyDuringUnlimited")) throw new Error("Invalid model-share condition")
      return [{ path: row.path, data: JSON.stringify({ ...data, onlyDuringUnlimited: false }) }]
    })
    if (!options.apply || !writes.length) return { applied: false, required: writes.length > 0, updated: writes.length }
    const backup = resolve(options.backup || `${file}.before-model-share-conditions`)
    if (backup === resolve(file) || existsSync(backup)) throw new Error("Refusing to overwrite source or backup")
    database.run("VACUUM INTO ?", [backup])
    chmodSync(backup, 0o600)
    const copy = new Database(backup, { readonly: true })
    try {
      if (copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Backup integrity check failed")
    } finally { copy.close() }
    database.transaction(() => {
      const update = database.query("UPDATE rawroute_documents SET data = ? WHERE path = ?")
      for (const write of writes) update.run(write.data, write.path)
    }).exclusive()
    return { applied: true, required: false, updated: writes.length, backup }
  } finally { database.close() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes("--sqlite") || !value("--sqlite") || value("--sqlite")!.startsWith("--")) throw new Error("Required: --sqlite <stopped database>; optional --apply --writers-stopped --backup <new file>")
  if (args.includes("--backup") && (!value("--backup") || value("--backup")!.startsWith("--"))) throw new Error("--backup requires a new file path")
  console.log(JSON.stringify(migrateModelShareConditions(value("--sqlite")!, { apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), backup: args.includes("--backup") ? value("--backup") : undefined }), null, 2))
}
