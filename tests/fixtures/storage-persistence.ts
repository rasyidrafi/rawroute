import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { prepareStoragePersistence } from "../../packages/gateway-storage/src/server/preparation"

export function storagePersistenceFixture() {
  const directory = mkdtempSync("/tmp/opencode/storage-fixture-")
  let prepared = false
  return {
    configure() {
      process.env.SQLITE_PATH = join(directory, "rawroute.sqlite")
      process.env.STORAGE_BACKEND = "sqlite"
      process.env.STORAGE_ENABLED = "true"
      if (!prepared) { prepareStoragePersistence(); prepared = true }
    },
    cleanup() { rmSync(directory, { recursive: true, force: true }) },
  }
}
