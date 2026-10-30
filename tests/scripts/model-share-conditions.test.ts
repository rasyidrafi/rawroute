import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { migrateModelShareConditions } from "../../scripts/migrations/model-share-conditions"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  directory = mkdtempSync(join(tmpdir(), "model-share-conditions-"))
  const file = join(directory, "test.sqlite")
  const database = new Database(file)
  database.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY, collection_path TEXT, document_id TEXT, data TEXT)")
  for (const [id, data] of [["legacy", { status: "active", createdAt: "2026-01-01" }], ["revoked", { status: "revoked" }], ["conditional", { status: "active", onlyDuringUnlimited: true }]] as const) {
    database.run("INSERT INTO rawroute_documents VALUES (?, ?, ?, ?)", [`rawroute_model_shares/${id}`, "rawroute_model_shares", id, JSON.stringify(data)])
  }
  database.run("INSERT INTO rawroute_documents VALUES ('other', 'rawroute_workspaces/default/events', 'other', '{\"costMicros\":123}')")
  return { database, file }
}

test("offline migration preserves existing grants as unconditional, backs up and is idempotent", () => {
  const { database, file } = fixture()
  const beforeRows = database.query("SELECT * FROM rawroute_documents ORDER BY path").all()
  database.close()
  const before = readFileSync(file)
  expect(migrateModelShareConditions(file)).toEqual({ applied: false, required: true, updated: 2 })
  expect(readFileSync(file)).toEqual(before)
  expect(() => migrateModelShareConditions(file, { apply: true })).toThrow("Stop all writers")
  const backup = join(directory!, "backup.sqlite")
  expect(migrateModelShareConditions(file, { apply: true, writersStopped: true, backup })).toEqual({ applied: true, required: false, updated: 2, backup })
  expect(statSync(backup).mode & 0o777).toBe(0o600)
  const converted = new Database(file, { readonly: true })
  const copy = new Database(backup, { readonly: true })
  try {
    expect(copy.query("SELECT * FROM rawroute_documents ORDER BY path").all()).toEqual(beforeRows)
    const rows = converted.query<{ document_id: string; data: string }, []>("SELECT document_id, data FROM rawroute_documents ORDER BY path").all()
    for (const row of rows) {
      if (["legacy", "revoked"].includes(row.document_id)) expect(JSON.parse(row.data).onlyDuringUnlimited).toBe(false)
      if (row.document_id === "conditional") expect(JSON.parse(row.data).onlyDuringUnlimited).toBe(true)
      if (row.document_id === "other") expect(JSON.parse(row.data)).toEqual({ costMicros: 123 })
    }
  } finally { converted.close(); copy.close() }
  expect(migrateModelShareConditions(file, { apply: true, writersStopped: true })).toEqual({ applied: false, required: false, updated: 0 })
})

test("migration refuses overwrites, active writers and invalid stored conditions", () => {
  const { database, file } = fixture()
  expect(() => migrateModelShareConditions(file, { apply: true, writersStopped: true, backup: file })).toThrow("overwrite")
  database.run("BEGIN EXCLUSIVE")
  try { expect(() => migrateModelShareConditions(file, { apply: true, writersStopped: true })).toThrow() }
  finally { database.run("ROLLBACK") }
  database.run("UPDATE rawroute_documents SET data = '{\"onlyDuringUnlimited\":\"true\"}' WHERE document_id = 'legacy'")
  database.close()
  expect(() => migrateModelShareConditions(file, { apply: true, writersStopped: true })).toThrow("Invalid model-share condition")
})
