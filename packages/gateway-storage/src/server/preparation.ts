import { Database } from "bun:sqlite"
import { assertLocalDatabaseClosed } from "@rawroute/platform/server/database"
import { randomBytes, randomUUID } from "node:crypto"
import { constants, chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, fstatSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { storageDatabasePath, storageEnabled, storageEncryptionKey, storageKeyPath } from "./config"
import { prepareStorageSchema } from "./schema"
import { decryptStorageSecret, type EncryptedStorageSecret } from "./security"

// Publish only complete, fsynced files. A killed writer can leave an unused
// temporary file, never a partial authoritative key or backup.
export function publishStorageFile(path: string, data: string | Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(descriptor, data)
    fsyncSync(descriptor)
    linkSync(temporary, path)
    const directory = openSync(dirname(path), constants.O_RDONLY)
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally { closeSync(descriptor); unlinkSync(temporary) }
}

function prepareKey(database: Database) {
  const path = storageKeyPath()
  if (!existsSync(path)) {
    const table = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_records'").get()
    if (table && database.query("SELECT 1 FROM storage_records WHERE kind IN ('connection','key') LIMIT 1").get()) throw new Error("Storage encryption key is missing; restore the original key from backup.")
    publishStorageFile(path, randomBytes(32).toString("hex") + "\n")
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Storage key must be an owner-only regular file (0600).")
    if (!/^[a-fA-F0-9]{64}\n?$/.test(readFileSync(descriptor, "utf8"))) throw new Error("Invalid Storage encryption key; restore the original key from backup.")
  } finally { closeSync(descriptor) }
}

function validateExistingSecrets(database: Database) {
  if (!database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_records'").get()) return
  const key = storageEncryptionKey()
  for (const row of database.query<{ kind: string; data: string }, []>("SELECT kind,data FROM storage_records WHERE kind IN ('connection','key')").all()) {
    const record = JSON.parse(row.data) as { workspaceId: string; id: string; credentials: EncryptedStorageSecret; secret: EncryptedStorageSecret }
    decryptStorageSecret(row.kind === "connection" ? record.credentials : record.secret, key, `${record.workspaceId}:${row.kind}:${record.id}`)
  }
}

// Called before the shared runtime connection, gateways, deletion recovery, or
// requests. The exclusive transaction serializes preparers and excludes writers.
export function prepareStoragePersistence() {
  if (!storageEnabled()) return
  assertLocalDatabaseClosed()
  const path = storageDatabasePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const database = new Database(path, { create: true })
  try {
    chmodSync(path, 0o600)
    database.run("PRAGMA busy_timeout=30000")
    database.run("PRAGMA synchronous=FULL")
    database.run("BEGIN EXCLUSIVE")
    try {
      prepareKey(database)
      validateExistingSecrets(database)
      prepareStorageSchema(database, () => publishStorageFile(`${path}.before-storage-v1.${randomUUID()}.bak`, database.serialize()))
      database.run("COMMIT")
    } catch (error) { database.run("ROLLBACK"); throw error }
  } finally { database.close() }
}
