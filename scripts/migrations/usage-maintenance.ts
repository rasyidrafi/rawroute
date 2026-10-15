import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import type { UsageEvent } from "../../src/lib/types"
import { assertUsageProjection, usagePrefix, usageWorkspace } from "../../src/lib/usage-projection"
import { rebuildCanonicalUsageProjection } from "./usage-projection-store"

export interface MaintenanceOptions { timeZone: string; apply?: boolean; writersStopped?: boolean; backup?: string }
export interface CanonicalEventDocument { path: string; workspaceId: string; event: UsageEvent }
export interface UsageRepair { path: string; event: UsageEvent }
type SourceRow = Record<string, unknown> & { path: string; data: string }

function immutableMetadata(row: SourceRow) {
  const metadata: Record<string, unknown> = { ...row }
  delete metadata.data; delete metadata.updated_at
  return JSON.stringify(metadata)
}

/** Explicit-path offline maintenance: raw repairs and the validated rebuild share one commit. */
export function maintainCanonicalUsage(file: string, options: MaintenanceOptions, plan: (events: CanonicalEventDocument[]) => UsageRepair[]) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing --sqlite path is required")
  if (!options.timeZone) throw new Error("An explicit --timezone is required")
  if (options.apply && !options.writersStopped) throw new Error("Stop all writers and pass --writers-stopped before --apply")
  new Intl.DateTimeFormat("en", { timeZone: options.timeZone }).format()
  const previousTimeZone = process.env.TIMEZONE
  const db = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  process.env.TIMEZONE = options.timeZone
  try {
    if (options.apply) {
      db.run("PRAGMA busy_timeout = 0")
      db.run("PRAGMA locking_mode = EXCLUSIVE")
      db.run("BEGIN EXCLUSIVE"); db.run("COMMIT")
    }
    assertUsageProjection(db)
    const documents = db.query<{ path: string; collection_path: string; data: string }, [string]>("SELECT path,collection_path,data FROM usage_projection_raw_events WHERE substr(collection_path,1,length(?1)) = ?1 AND substr(collection_path,-12) = '/usageEvents' ORDER BY path").all(`${usagePrefix()}_workspaces/`)
    const events = documents.flatMap(row => {
      const workspaceId = usageWorkspace(row.collection_path, "usageEvents")
      return workspaceId === undefined ? [] : [{ path: row.path, workspaceId, event: JSON.parse(row.data) as UsageEvent }]
    })
    const repairs = plan(events)
    const allowed = new Set(events.map(event => event.path))
    if (repairs.some(repair => !allowed.has(repair.path)) || new Set(repairs.map(repair => repair.path)).size !== repairs.length) throw new Error("Repairs must target distinct existing canonical events")
    const report = { applied: Boolean(options.apply && repairs.length), candidates: repairs.length }
    if (!options.apply || !repairs.length) return report
    const backup = resolve(options.backup || `${file}.before-usage-repair`)
    if (backup === resolve(file) || existsSync(backup)) throw new Error("Refusing to overwrite source or backup; choose a new --backup path")
    const sourceRows = () => db.query<SourceRow, []>("SELECT * FROM rawroute_documents ORDER BY path").all()
    const originals = sourceRows()
    const sourceHash = createHash("sha256").update(JSON.stringify(originals)).digest("hex")
    db.run("VACUUM INTO ?", [backup]); chmodSync(backup, 0o600)
    const copy = new Database(backup, { readonly: true })
    try {
      if (copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok" || createHash("sha256").update(JSON.stringify(copy.query("SELECT * FROM rawroute_documents ORDER BY path").all())).digest("hex") !== sourceHash) throw new Error("Repair backup validation failed")
    } finally { copy.close() }
    const projection = db.transaction(() => {
      for (const repair of repairs) db.run("UPDATE rawroute_documents SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?", [JSON.stringify(repair.event), repair.path])
      const after = sourceRows()
      const byPath = new Map(originals.map(row => [row.path, row]))
      const planned = new Map(repairs.map(repair => [repair.path, JSON.stringify(repair.event)]))
      if (after.length !== originals.length) throw new Error("Unexpected raw document mutation")
      for (const row of after) {
        const previous = byPath.get(row.path)
        if (!previous || (planned.has(row.path) ? row.data !== planned.get(row.path) || immutableMetadata(row) !== immutableMetadata(previous) : JSON.stringify(row) !== JSON.stringify(previous))) throw new Error("Unexpected raw document mutation")
      }
      return rebuildCanonicalUsageProjection(db)
    }).exclusive()
    return { ...report, backup, projection }
  } finally {
    db.close()
    if (previousTimeZone === undefined) delete process.env.TIMEZONE
    else process.env.TIMEZONE = previousTimeZone
  }
}

export function maintenanceArguments(args: string[]) {
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes("--sqlite") || !args.includes("--timezone")) throw new Error("Required: --sqlite <stopped database> --timezone <IANA zone>; optional --apply --writers-stopped --backup <new file>")
  return { file: value("--sqlite")!, options: { timeZone: value("--timezone")!, apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), backup: args.includes("--backup") ? value("--backup") : undefined } }
}
