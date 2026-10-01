import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import * as lockfile from "proper-lockfile"
import { ensureLayout, getServicePaths, writeAtomic } from "../../src/server/cliproxy/store"

function copyPrivate(source: string, destination: string) {
  const info = fs.lstatSync(source)
  if (info.isSymbolicLink()) throw new Error("Migration source must not contain symbolic links.")
  if (info.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const item of fs.readdirSync(source)) copyPrivate(path.join(source, item), path.join(destination, item))
  } else if (info.isFile()) {
    fs.copyFileSync(source, destination)
    fs.chmodSync(destination, 0o600)
  } else throw new Error("Migration source contains a non-regular file.")
}

/** Offline, additive import. The original installation is never modified. */
export async function importLegacyInstance(source: string, dataRoot: string) {
  source = path.resolve(source)
  dataRoot = path.resolve(dataRoot)
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(dataRoot, { lockfilePath: path.join(dataRoot, "cliproxy-import.lock") })
  const temporaryRoot = path.join(dataRoot, `.cliproxy-import-${randomUUID()}`)
  try {
    const destination = getServicePaths(dataRoot)
    if (fs.existsSync(destination.root)) throw new Error("Target CLIProxy data already exists. Import into an unused data directory.")
    const config = Bun.YAML.parse(fs.readFileSync(path.join(source, "config.yaml"), "utf8"))
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Legacy config must be a YAML mapping.")
    const original = config as Record<string, unknown>
    if (!fs.existsSync(path.join(source, "auths"))) throw new Error("Provide the legacy auth directory as source/auths, alongside config.yaml.")
    const staged = getServicePaths(temporaryRoot)
    ensureLayout(staged)
    for (const [from, to] of [["auths", "auth"], ["logs", "logs"], ["plugins", "plugins"]]) {
      if (fs.existsSync(path.join(source, from))) copyPrivate(path.join(source, from), path.join(staged.root, to))
    }
    const apiKey = randomBytes(32).toString("base64url")
    const managementKey = randomBytes(32).toString("base64url")
    const remote = original["remote-management"]
    const updated = {
      ...original, host: "127.0.0.1", port: 8317,
      "auth-dir": destination.auth,
      "api-keys": [...new Set([...(Array.isArray(original["api-keys"]) ? original["api-keys"] : []), apiKey])],
      "remote-management": { ...(remote && typeof remote === "object" ? remote : {}), "allow-remote": false, "secret-key": managementKey, "disable-control-panel": true },
    }
    // JSON is valid YAML and preserves every parsed legacy option.
    writeAtomic(staged.config, JSON.stringify(updated, null, 2))
    writeAtomic(staged.apiKey, apiKey)
    writeAtomic(staged.managementKey, managementKey)
    writeAtomic(path.join(staged.root, "import.json"), JSON.stringify({ importedAt: new Date().toISOString() }))
    fs.renameSync(staged.root, destination.root)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
    await release()
  }
}
