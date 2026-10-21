import { readFileSync, realpathSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

export function storageEnabled() {
  if (process.env.STORAGE_ENABLED !== undefined) {
    if (!["true", "false"].includes(process.env.STORAGE_ENABLED)) throw new Error("STORAGE_ENABLED must be true or false.")
    return process.env.STORAGE_ENABLED === "true"
  }
  return false
}
export function storageDatabasePath() {
  const path = process.env.SQLITE_PATH || join(process.env.RAWROUTE_DATA_DIR || "data", "rawroute.sqlite")
  if (path === ":memory:" || process.env.NODE_ENV === "test" && process.env.STORAGE_BACKEND === "memory") throw new Error("Storage requires persistent SQLite.")
  return existsSync(path) ? realpathSync(path) : resolve(path)
}
export function storageKeyPath() { return `${storageDatabasePath()}.storage-key` }
export function storageEncryptionKey() {
  const value = readFileSync(storageKeyPath(), "utf8").trim()
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("Invalid Storage encryption key; restore the original key from backup.")
  if (process.env.NODE_ENV === "test" && process.env.STORAGE_BACKEND === "memory") throw new Error("Storage requires persistent SQLite.")
  return Buffer.from(value, "hex")
}
export function storageTrustedOrigins() {
  return (process.env.STORAGE_S3_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean)
}
export function storagePort() {
  const value = process.env.STORAGE_S3_PORT ? Number(process.env.STORAGE_S3_PORT) : 9000
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error("Invalid STORAGE_S3_PORT.")
  return value
}
