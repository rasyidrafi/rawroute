import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { migrateStorage } from "../../scripts/migrations/storage"

test("Storage stopped-writer migration dry-run, backup, apply and idempotency preserve existing documents", () => {
  const directory = mkdtempSync("/tmp/opencode/storage-migration-")
  const path = join(directory, "source.sqlite")
  const backup = join(directory, "backup.sqlite")
  const source = new Database(path)
  source.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY,data TEXT)")
  source.run("INSERT INTO rawroute_documents VALUES('owned/document','{\"value\":42}')")
  source.close()
  try {
    const before = readFileSync(path)
    expect(migrateStorage(path)).toEqual({ version: 1, changed: true, applied: false })
    expect(readFileSync(path)).toEqual(before)
    expect(() => migrateStorage(path, { apply: true, backup })).toThrow("writers-stopped")
    expect(existsSync(backup)).toBe(false)
    expect(migrateStorage(path, { apply: true, writersStopped: true, backup })).toEqual({ version: 1, changed: true, applied: true })
    const old = new Database(backup, { readonly: true })
    expect(old.query("SELECT data FROM rawroute_documents").get()).toEqual({ data: '{"value":42}' })
    expect(old.query("SELECT name FROM sqlite_master WHERE name='storage_records'").get()).toBeNull()
    old.close()
    const upgraded = new Database(path, { readonly: true })
    expect(upgraded.query("SELECT version FROM storage_schema").get()).toEqual({ version: 1 })
    expect(upgraded.query("SELECT data FROM rawroute_documents").get()).toEqual({ data: '{"value":42}' })
    upgraded.close()
    expect(migrateStorage(path)).toEqual({ version: 1, changed: false, applied: false })
  } finally { rmSync(directory, { recursive: true }) }
})
