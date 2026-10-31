import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createCodexCredentialSchema } from "@rawroute/gateway-ai/server/maintenance/codex-credentials"
import { migrateCodexResetIdentity } from "../../scripts/migrations/codex-reset-identity"

const directories: string[] = []
const workspace = "migration-workspace"
const accountId = "upstream-account-private"
const localId = "local-credential-id"
const resetCollection = `rawroute_workspaces/${workspace}/codexResetAutomationAccounts`
const resetPath = `${resetCollection}/${localId}`
const status = { phase: "unknown", requestId: "request-private", lastMessage: "The redemption outcome is unknown." }

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function databaseFixture(withAccount = true) {
  const directory = mkdtempSync(join(tmpdir(), "rawroute-codex-reset-migration-"))
  directories.push(directory)
  const file = join(directory, "rawroute.sqlite")
  const database = new Database(file)
  database.run("PRAGMA journal_mode = WAL")
  database.run(`CREATE TABLE rawroute_documents (
    path TEXT PRIMARY KEY,
    collection_path TEXT NOT NULL,
    document_id TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  const insert = database.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)")
  insert.run(`rawroute_workspaces/${workspace}/providers/codex`, `rawroute_workspaces/${workspace}/providers`, "codex", JSON.stringify({ prefix: "codex" }))
  if (withAccount) insert.run(
    `rawroute_workspaces/${workspace}/providers/codex/apiKeys/${localId}`,
    `rawroute_workspaces/${workspace}/providers/codex/apiKeys`,
    localId,
    JSON.stringify({ credentialKind: "codex-oauth", accountId }),
  )
  insert.run(resetPath, resetCollection, localId, JSON.stringify(status))
  createCodexCredentialSchema(database)
  database.close()
  return { directory, file }
}

test("moves reset safety records to identity keys only with a stopped-writer backup", () => {
  const { file } = databaseFixture()
  const expectedId = `account-${createHash("sha256").update(accountId).digest("hex")}`

  expect(migrateCodexResetIdentity(file)).toEqual({ applied: false, required: true, records: 1 })
  expect(() => migrateCodexResetIdentity(file, { apply: true })).toThrow("--writers-stopped")
  const previousUmask = process.umask(0)
  let result: ReturnType<typeof migrateCodexResetIdentity>
  try { result = migrateCodexResetIdentity(file, { apply: true, writersStopped: true }) } finally { process.umask(previousUmask) }

  expect(result).toMatchObject({ applied: true, required: false, records: 1 })
  const backup = result.backup!
  expect(statSync(backup).mode & 0o777).toBe(0o600)
  const database = new Database(file, { readonly: true })
  try {
    expect(database.query("SELECT path FROM rawroute_documents WHERE path = ?").get(resetPath)).toBeNull()
    expect(database.query<{ data: string }, [string]>("SELECT data FROM rawroute_documents WHERE path = ?").get(`${resetCollection}/${expectedId}`)?.data).toBe(JSON.stringify(status))
  } finally { database.close() }
  const backupDatabase = new Database(backup, { readonly: true })
  try {
    expect(backupDatabase.query("SELECT path FROM rawroute_documents WHERE path = ?").get(resetPath)).toBeDefined()
  } finally { backupDatabase.close() }
  expect(migrateCodexResetIdentity(file)).toEqual({ applied: false, required: false, records: 0 })
})

test("reset-only conversion locks before planning and preserves a concurrent writer's checkpoint", () => {
  const { file } = databaseFixture()
  const writer = new Database(file)
  writer.run("BEGIN IMMEDIATE")
  writer.run("UPDATE rawroute_documents SET data = json_set(data, '$.lastMessage', 'writer committed this') WHERE path = ?", [resetPath])
  expect(() => migrateCodexResetIdentity(file, { apply: true, writersStopped: true })).toThrow(/locked/i)
  expect(existsSync(`${file}.before-codex-reset-identity`)).toBe(false)
  writer.run("COMMIT")
  writer.close()

  const result = migrateCodexResetIdentity(file, { apply: true, writersStopped: true })
  expect(result).toMatchObject({ applied: true, records: 1 })
  const expectedId = `account-${createHash("sha256").update(accountId).digest("hex")}`
  const database = new Database(file, { readonly: true })
  try {
    expect(database.query<{ data: string }, [string]>("SELECT data FROM rawroute_documents WHERE path = ?").get(`${resetCollection}/${expectedId}`)?.data)
      .toBe(JSON.stringify({ ...status, lastMessage: "writer committed this" }))
  } finally { database.close() }
})

test("refuses to discard reset state that cannot be mapped to a connected upstream identity", () => {
  const { file } = databaseFixture(false)

  expect(() => migrateCodexResetIdentity(file)).toThrow("no connected account identity")
  const database = new Database(file, { readonly: true })
  try {
    expect(database.query("SELECT path FROM rawroute_documents WHERE path = ?").get(resetPath)).toBeDefined()
  } finally { database.close() }
})

test("reset identity conversion requires the credential migration marker first", () => {
  const { file } = databaseFixture()
  const database = new Database(file)
  database.run("DROP TABLE ai_codex_credential_schema")
  database.close()

  expect(() => migrateCodexResetIdentity(file)).toThrow("codex-credentials.ts before")
})
