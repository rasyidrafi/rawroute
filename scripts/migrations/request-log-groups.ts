import { Database } from "bun:sqlite"
import { chmodSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createRequestLogSchema, hasRequestLogSchema } from "@rawroute/gateway-ai/server/maintenance/request-logs"

/** Replace the grouping index offline; never invent historical routing snapshots or rewrite usage. */
export function migrateRequestLogGroups(file: string, options: { apply?: boolean; writersStopped?: boolean; backup?: string } = {}) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing --sqlite path is required")
  if (options.apply && !options.writersStopped) throw new Error("Stop all writers and pass --writers-stopped before --apply")
  const database = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  try {
    if (!database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rawroute_documents'").get()) throw new Error("RawRoute document table is missing")
    const migrated = hasRequestLogSchema(database)
    if (migrated || !options.apply) return { applied: false, required: !migrated }
    database.run("PRAGMA busy_timeout = 0")
    database.run("PRAGMA locking_mode = EXCLUSIVE")
    database.run("BEGIN EXCLUSIVE")
    database.run("COMMIT")
    const backup = resolve(options.backup || `${file}.before-request-log-groups`)
    if (backup === resolve(file) || existsSync(backup)) throw new Error("Refusing to overwrite source or backup")
    database.run("VACUUM INTO ?", [backup])
    chmodSync(backup, 0o600)
    const copy = new Database(backup, { readonly: true })
    try {
      if (copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Backup integrity check failed")
    } finally { copy.close() }
    database.transaction(() => createRequestLogSchema(database)).exclusive()
    return { applied: true, required: false, backup }
  } finally { database.close() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes("--sqlite")) throw new Error("Required: --sqlite <stopped database>; optional --apply --writers-stopped --backup <new file>")
  console.log(JSON.stringify(migrateRequestLogGroups(value("--sqlite")!, { apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), backup: args.includes("--backup") ? value("--backup") : undefined }), null, 2))
}
