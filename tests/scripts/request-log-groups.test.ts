import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { migrateRequestLogGroups } from "../../scripts/migrations/request-log-groups"
import { assertRequestLogSchema } from "../../packages/gateway-ai/src/server/request-log-schema"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

test("grouping migration is offline, backed up, idempotent, and preserves historical documents", () => {
  directory = mkdtempSync(join(tmpdir(), "request-log-groups-"))
  const file = join(directory, "test.sqlite")
  const database = new Database(file)
  database.run("CREATE TABLE rawroute_documents(collection_path TEXT, document_id TEXT, data TEXT)")
  database.run("INSERT INTO rawroute_documents VALUES (?, ?, ?)", ["workspace/events", "legacy", '{"model":"old"}'])
  database.run("CREATE INDEX rawroute_documents_request_chain_idx ON rawroute_documents (collection_path, COALESCE(json_extract(data, '$.requestId'), document_id), COALESCE(json_extract(data, '$.gatewayKeyId'), ''))")
  database.run("INSERT INTO rawroute_documents VALUES (?, ?, ?)", ["workspace/events", "owner", JSON.stringify({ requestId: "consumer-chain", attemptIndex: 1, requestFinal: false, costMicros: 2343, sharedUsage: { role: "owner" } })])
  expect(() => assertRequestLogSchema(database)).toThrow("offline migration")
  expect(() => assertRequestLogSchema(database, true)).toThrow("offline migration")
  expect(database.query("SELECT name FROM sqlite_master WHERE name = 'rawroute_documents_request_scope_idx'").get()).toBeNull()
  database.close()
  const before = readFileSync(file)
  expect(migrateRequestLogGroups(file)).toEqual({ applied: false, required: true })
  expect(readFileSync(file)).toEqual(before)
  expect(() => migrateRequestLogGroups(file, { apply: true })).toThrow("Stop all writers")
  const backup = join(directory, "backup.sqlite")
  expect(migrateRequestLogGroups(file, { apply: true, writersStopped: true, backup })).toMatchObject({ applied: true, backup })
  expect(existsSync(backup)).toBe(true)
  const converted = new Database(file)
  const copy = new Database(backup)
  try {
    expect(() => assertRequestLogSchema(converted)).not.toThrow()
    expect(converted.query("SELECT name FROM sqlite_master WHERE name = 'rawroute_documents_request_chain_idx'").get()).toBeNull()
    expect(converted.query("SELECT name FROM sqlite_master WHERE name = 'rawroute_documents_request_scope_idx'").get()).not.toBeNull()
    expect(() => assertRequestLogSchema(copy)).toThrow("offline migration")
    expect(converted.query("SELECT * FROM rawroute_documents").all()).toEqual(copy.query("SELECT * FROM rawroute_documents").all())
  } finally { converted.close(); copy.close() }
  expect(migrateRequestLogGroups(file, { apply: true, writersStopped: true })).toEqual({ applied: false, required: false })
})

test("grouping migration refuses an existing backup and an active writer", () => {
  directory = mkdtempSync(join(tmpdir(), "request-log-groups-"))
  const file = join(directory, "test.sqlite")
  const database = new Database(file)
  database.run("CREATE TABLE rawroute_documents(collection_path TEXT, document_id TEXT, data TEXT)")
  expect(() => migrateRequestLogGroups(file, { apply: true, writersStopped: true, backup: file })).toThrow("overwrite")
  database.run("BEGIN EXCLUSIVE")
  try { expect(() => migrateRequestLogGroups(file, { apply: true, writersStopped: true })).toThrow() }
  finally { database.run("ROLLBACK"); database.close() }
})
