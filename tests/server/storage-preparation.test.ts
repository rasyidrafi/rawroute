import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { prepareStoragePersistence, publishStorageFile } from "../../packages/gateway-storage/src/server/preparation"
import { storageDatabasePath, storageEnabled, storageEncryptionKey, storageKeyPath } from "../../packages/gateway-storage/src/server/config"
import { decryptStorageSecret, encryptStorageSecret, type EncryptedStorageSecret } from "../../packages/gateway-storage/src/server/security"
import { closeLocalDatabase, getDatabase } from "../../packages/platform/src/server/database"

const names = ["STORAGE_ENABLED", "STORAGE_ENCRYPTION_KEY", "STORAGE_S3_PORT", "STORAGE_BACKEND", "SQLITE_PATH", "RAWROUTE_DATA_DIR"] as const
let saved: Partial<Record<typeof names[number], string>>
let directory: string
let path: string
beforeEach(() => {
  saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  directory = mkdtempSync("/tmp/opencode/storage-preparation-")
  path = join(directory, "source.sqlite")
  Object.assign(process.env, { STORAGE_ENABLED: "true", STORAGE_BACKEND: "sqlite", SQLITE_PATH: path })
})
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(directory, { recursive: true, force: true })
})
const backups = () => readdirSync(directory).filter(name => name.endsWith(".bak"))
function seedAiDatabase() {
  const database = new Database(path)
  database.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY,data TEXT)")
  database.run("INSERT INTO rawroute_documents VALUES('ai/document','{\"value\":42}')")
  database.close()
}

test("AI-only default does no Storage work, including existing DB and memory/test mode", () => {
  delete process.env.STORAGE_ENABLED
  expect(storageEnabled()).toBe(false)
  prepareStoragePersistence()
  expect(readdirSync(directory)).toEqual([])
  seedAiDatabase()
  const before = readFileSync(path)
  prepareStoragePersistence()
  expect(readFileSync(path)).toEqual(before)
  expect(readdirSync(directory)).toEqual(["source.sqlite"])
  process.env.STORAGE_BACKEND = "memory"
  process.env.SQLITE_PATH = ":memory:"
  prepareStoragePersistence()
  process.env.STORAGE_ENABLED = "true"
  expect(() => prepareStoragePersistence()).toThrow("persistent SQLite")
  expect(readdirSync(directory)).toEqual(["source.sqlite"])
})

test("fresh native opt-in prepares schema and durable 0600 identity without an environment secret", () => {
  prepareStoragePersistence()
  const key = storageEncryptionKey()
  expect(key.byteLength).toBe(32)
  expect(statSync(storageKeyPath()).mode & 0o777).toBe(0o600)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(backups()).toEqual([])
  prepareStoragePersistence()
  expect(storageEncryptionKey()).toEqual(key)
  expect(backups()).toEqual([])
  const database = new Database(path, { readonly: true })
  expect(database.query("SELECT version FROM storage_schema").get()).toEqual({ version: 1 })
  expect(database.query("SELECT name FROM sqlite_master WHERE name='rawroute_documents'").get()).toBeNull()
  database.close()
})

test("offline preparation refuses an already-open runtime connection", async () => {
  getDatabase()
  try {
    expect(() => prepareStoragePersistence()).toThrow("runtime database to be closed")
    expect(existsSync(storageKeyPath())).toBe(false)
  } finally { await closeLocalDatabase() }
  prepareStoragePersistence()
  expect(storageEncryptionKey().byteLength).toBe(32)
})

test("existing AI-only DB upgrades once with consistent standalone backup including uncheckpointed WAL", () => {
  seedAiDatabase()
  const writer = new Database(path)
  writer.run("PRAGMA journal_mode=WAL")
  writer.run("UPDATE rawroute_documents SET data='{\"value\":43}'")
  try {
    prepareStoragePersistence()
    expect(backups()).toHaveLength(1)
    const backupPath = join(directory, backups()[0]!)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    const backup = new Database(backupPath, { readonly: true })
    expect(backup.query("SELECT data FROM rawroute_documents").get()).toEqual({ data: '{"value":43}' })
    expect(backup.query("SELECT name FROM sqlite_master WHERE name='storage_records'").get()).toBeNull()
    expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    backup.close()
    expect(writer.query("SELECT data FROM rawroute_documents").get()).toEqual({ data: '{"value":43}' })
    prepareStoragePersistence()
    expect(backups()).toHaveLength(1)
  } finally { writer.close() }
})

test("encrypted connection/client secrets survive restart; missing/corrupt/wrong keys never rekey records", () => {
  prepareStoragePersistence()
  const original = readFileSync(storageKeyPath())
  const database = new Database(path)
  for (const kind of ["connection", "key"]) {
    const secret = encryptStorageSecret(`TEST-${kind}-secret`, storageEncryptionKey(), `workspace:${kind}:record`)
    database.run("INSERT INTO storage_records VALUES(?,?,?,?)", [kind, "record", "workspace", JSON.stringify({ id: "record", workspaceId: "workspace", [kind === "connection" ? "credentials" : "secret"]: secret })])
  }
  const records = database.query<{ kind: string; data: string }, []>("SELECT kind,data FROM storage_records").all()
  database.close()
  expect(JSON.stringify(records)).not.toContain("TEST-")
  prepareStoragePersistence()
  for (const record of records) {
    const data = JSON.parse(record.data) as { credentials: EncryptedStorageSecret; secret: EncryptedStorageSecret }
    expect(decryptStorageSecret(data.credentials || data.secret, storageEncryptionKey(), `workspace:${record.kind}:record`)).toBe(`TEST-${record.kind}-secret`)
  }
  unlinkSync(storageKeyPath())
  expect(() => prepareStoragePersistence()).toThrow("key is missing")
  expect(existsSync(storageKeyPath())).toBe(false)
  writeFileSync(storageKeyPath(), "partial", { mode: 0o600 })
  expect(() => prepareStoragePersistence()).toThrow("Invalid Storage encryption key")
  expect(readFileSync(storageKeyPath(), "utf8")).toBe("partial")
  writeFileSync(storageKeyPath(), "b".repeat(64))
  expect(() => prepareStoragePersistence()).toThrow("could not be decrypted")
  writeFileSync(storageKeyPath(), original)
  process.env.STORAGE_ENCRYPTION_KEY = "c".repeat(64)
  expect(() => prepareStoragePersistence()).not.toThrow()
  expect(readFileSync(storageKeyPath())).toEqual(original)
  delete process.env.STORAGE_ENCRYPTION_KEY
  prepareStoragePersistence()
  expect(backups()).toEqual([])
})

test("partial files, unsafe permissions, symlinks and failed publication fail closed without schema changes", () => {
  seedAiDatabase()
  writeFileSync(`${storageKeyPath()}.interrupted.tmp`, "incomplete", { mode: 0o600 })
  mkdirSync(storageKeyPath())
  expect(() => prepareStoragePersistence()).toThrow()
  rmSync(storageKeyPath(), { recursive: true })
  writeFileSync(storageKeyPath(), "partial", { mode: 0o600 })
  expect(() => prepareStoragePersistence()).toThrow("Invalid Storage encryption key")
  writeFileSync(storageKeyPath(), "a".repeat(64))
  chmodSync(storageKeyPath(), 0o644)
  expect(() => prepareStoragePersistence()).toThrow("owner-only")
  unlinkSync(storageKeyPath())
  const target = join(directory, "target-key")
  writeFileSync(target, "a".repeat(64), { mode: 0o600 })
  symlinkSync(target, storageKeyPath())
  expect(() => prepareStoragePersistence()).toThrow()
  const database = new Database(path, { readonly: true })
  expect(database.query("SELECT name FROM sqlite_master WHERE name='storage_schema'").get()).toBeNull()
  database.close()
  expect(backups()).toEqual([])
  expect(() => publishStorageFile(target, "replacement")).toThrow()
  expect(readFileSync(target, "utf8")).toBe("a".repeat(64))
  unlinkSync(storageKeyPath())
  prepareStoragePersistence()
  expect(backups()).toHaveLength(1)
})

test("selected data-root/path with spaces and database symlink retain the same volume identity", () => {
  delete process.env.SQLITE_PATH
  process.env.RAWROUTE_DATA_DIR = join(directory, "data with spaces")
  prepareStoragePersistence()
  const actual = storageDatabasePath()
  const key = storageEncryptionKey()
  expect(actual).toBe(join(process.env.RAWROUTE_DATA_DIR, "rawroute.sqlite"))
  const alias = join(directory, "alias.sqlite")
  symlinkSync(actual, alias)
  process.env.SQLITE_PATH = alias
  prepareStoragePersistence()
  expect(storageDatabasePath()).toBe(actual)
  expect(storageEncryptionKey()).toEqual(key)
  expect(existsSync(`${alias}.storage-key`)).toBe(false)
})

test.each(["fresh", "existing"])("concurrent opt-in processes share one key/schema/backup, then restart (%s)", async scenario => {
  if (scenario === "existing") seedAiDatabase()
  const module = resolve("packages/gateway-storage/src/server/preparation.ts")
  const code = `import { prepareStoragePersistence } from ${JSON.stringify(module)}; prepareStoragePersistence()`
  const processes = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "--no-env-file", "-e", code], { env: process.env, stdout: "pipe", stderr: "pipe" }))
  for (const child of processes) {
    const error = await new Response(child.stderr).text()
    expect(error).toBe("")
    expect(await child.exited).toBe(0)
  }
  expect(backups()).toHaveLength(scenario === "existing" ? 1 : 0)
  const key = storageEncryptionKey()
  const restart = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { env: process.env, stderr: "pipe" })
  expect(await new Response(restart.stderr).text()).toBe("")
  expect(await restart.exited).toBe(0)
  expect(storageEncryptionKey()).toEqual(key)
  expect(backups()).toHaveLength(scenario === "existing" ? 1 : 0)
})

test("an existing writer transaction excludes key/schema/backup preparation until it releases", async () => {
  seedAiDatabase()
  const writer = new Database(path)
  writer.run("PRAGMA journal_mode=WAL")
  writer.run("BEGIN IMMEDIATE")
  writer.run("UPDATE rawroute_documents SET data='{\"value\":99}'")
  const module = resolve("packages/gateway-storage/src/server/preparation.ts")
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `import { prepareStoragePersistence } from ${JSON.stringify(module)}; console.log('ready'); prepareStoragePersistence()`], { env: process.env, stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
    reader.releaseLock()
    expect(existsSync(storageKeyPath())).toBe(false)
    expect(backups()).toEqual([])
    writer.run("COMMIT")
    expect(await new Response(child.stderr).text()).toBe("")
    expect(await child.exited).toBe(0)
    const backup = new Database(join(directory, backups()[0]!), { readonly: true })
    expect(backup.query("SELECT data FROM rawroute_documents").get()).toEqual({ data: '{"value":99}' })
    backup.close()
  } finally {
    child.kill()
    writer.close()
  }
})
