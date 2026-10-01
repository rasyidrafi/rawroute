import * as fs from "node:fs"
import * as path from "node:path"
import { getDataRoot, getServicePaths, readState, writeState } from "./store"
import { normalizeVersion } from "./release"
import { isInstalledVersion, setCurrentVersion } from "./version-store"

/** Container images carry a tested release; fresh boot never needs GitHub. */
export function seedBundledVersion() {
  const paths = getServicePaths(getDataRoot())
  if (fs.existsSync(paths.state) || fs.existsSync(paths.current)) return
  const source = process.env.CLIPROXY_BUNDLED_BINARY
  const rawVersion = process.env.CLIPROXY_BUNDLED_VERSION
  if (!source || !rawVersion) return
  const version = normalizeVersion(rawVersion)
  const directory = path.join(paths.versions, version)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!isInstalledVersion(paths, version)) {
    const temporary = path.join(directory, "seed.tmp")
    fs.copyFileSync(source, temporary)
    fs.chmodSync(temporary, 0o555)
    fs.renameSync(temporary, path.join(directory, "cli-proxy-api"))
  }
  setCurrentVersion(paths, version)
  writeState(paths, { ...readState(paths), installedVersion: version, pinnedVersion: version, desiredRunning: true })
}
