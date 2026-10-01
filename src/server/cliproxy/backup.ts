import * as fs from "node:fs"
import * as path from "node:path"
import type { ServicePaths } from "./store"

/** Snapshot only after the child is stopped, so token refresh cannot race the copy. */
export function snapshotConfiguration(paths: ServicePaths) {
  const backup = path.join(paths.root, "update-backup")
  fs.rmSync(backup, { recursive: true, force: true })
  fs.mkdirSync(backup, { mode: 0o700 })
  fs.copyFileSync(paths.config, path.join(backup, "config.yaml"))
  fs.cpSync(paths.auth, path.join(backup, "auth"), { recursive: true })
  fs.writeFileSync(path.join(backup, "ready"), "1", { mode: 0o600 })
}

export function restoreConfiguration(paths: ServicePaths) {
  const backup = path.join(paths.root, "update-backup")
  if (!fs.existsSync(path.join(backup, "ready"))) return
  fs.copyFileSync(path.join(backup, "config.yaml"), paths.config)
  fs.rmSync(paths.auth, { recursive: true, force: true })
  fs.cpSync(path.join(backup, "auth"), paths.auth, { recursive: true })
}

export function discardConfigurationBackup(paths: ServicePaths) {
  fs.rmSync(path.join(paths.root, "update-backup"), { recursive: true, force: true })
}
