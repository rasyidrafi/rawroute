import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import * as lockfile from "proper-lockfile"
import { configMapping, getServicePaths, parseConfig, prepareVersion, readState, setCurrentVersion, validateLoopbackConfig, writeAtomic, writeState } from "@rawroute/gateway-ai/server/maintenance/cliproxy"

const VERSION = "8.0.43"
type Options = { apply?: boolean; writersStopped?: boolean; binary?: string }

/** One-time offline conversion of RawRoute-owned config; runtime accepts only V8. */
export function convertConfig(contents: string) {
  const config = parseConfig(contents)
  if (config["config-version"] === 8) {
    if (["host", "port", "auth-dir", "remote-management", "openai-compatibility", "claude-api-key"].some(key => key in config) || Array.isArray(config["api-keys"])) throw new Error("Mixed CLIProxy configuration is unsupported.")
    return config
  }
  if (config["config-version"] !== undefined || ["server", "access", "oauth", "management", "observability"].some(key => key in config)) throw new Error("Mixed or unsupported CLIProxy configuration.")
  const moves: Record<string, string> = {
    host: "server.host", port: "server.port", "remote-management": "management", "api-keys": "access.api-keys", "auth-dir": "oauth.auth-dir",
    debug: "observability.logs.debug", "logging-to-file": "observability.logs.logging-to-file", "logs-max-total-size-mb": "observability.logs.logs-max-total-size-mb", "usage-statistics-enabled": "observability.usage.usage-statistics-enabled",
    "request-retry": "routing.retry.request-retry", "max-retry-credentials": "routing.retry.max-retry-credentials", "max-retry-interval": "routing.retry.max-retry-interval",
    "disable-cooling": "routing.cooldown.disable-cooling", "transient-error-cooldown-seconds": "routing.cooldown.transient-error-cooldown-seconds",
    "credential-concurrency": "credentials.concurrency", "credential-in-flight": "credentials.in-flight", discovery: "server.discovery",
    "redis-usage-queue-retention-seconds": "observability.usage.redis-usage-queue-retention-seconds", "ws-auth": "oauth.providers.aistudio.ws-auth",
  }
  for (const [key, destination] of Object.entries(moves)) {
    if (!Object.hasOwn(config, key)) continue
    const value = config[key]
    delete config[key]
    const parts = destination.split(".")
    const leaf = parts.pop()!
    let parent = config
    for (const part of parts) parent = configMapping(parent[part] ??= {})
    if (Object.hasOwn(parent, leaf)) throw new Error("Mixed CLIProxy configuration is unsupported.")
    parent[leaf] = value
  }
  const families: Record<string, unknown> = {}
  for (const [key, family] of [["openai-compatibility", "openai-compatibility"], ["claude-api-key", "claude"]]) {
    if (!Object.hasOwn(config, key)) continue
    const entries = config[key]
    if (!Array.isArray(entries)) throw new Error(`Invalid ${key} configuration.`)
    families[family] = entries.map((value, index) => {
      const entry = { ...configMapping(value) }
      if (family === "openai-compatibility") {
        if (Object.hasOwn(entry, "api-key-entries")) entry.keys = entry["api-key-entries"]
        delete entry["api-key-entries"]
      } else {
        entry.keys = [{ "api-key": entry["api-key"] }]
        delete entry["api-key"]
        const owned = typeof entry.prefix === "string" ? /^rr-ws-([a-f0-9]{16})-p-([a-f0-9]{12})$/.exec(entry.prefix) : null
        if (owned && !entry.name) entry.name = `rr-managed-${owned[1]}-${owned[2]}-migrated-${index}`
      }
      return entry
    })
    delete config[key]
  }
  if (Object.keys(families).length) config["api-keys"] = families
  config["config-version"] = 8
  return config
}

function verifyBinary(binary: string) {
  const info = fs.lstatSync(binary)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Migration binary must be a regular file.")
  const result = Bun.spawnSync([path.resolve(binary), "-help"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 })
  const version = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
  const reported = /CLIProxyAPI Version: v?(\d+\.\d+\.\d+),/.exec(version)?.[1]
  if (result.exitCode !== 0 || reported !== VERSION) throw new Error(`Migration requires CLIProxyAPI ${VERSION}.`)
}

function stopped(root: string) {
  for (const name of ["manager.json", "child.json"]) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number }
    if (!Number.isSafeInteger(record.pid) || record.pid! <= 0) throw new Error(`Invalid ${name}; inspect the stopped installation.`)
    try { process.kill(record.pid!, 0) } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") continue
      throw error
    }
    throw new Error("Stop RawRoute and CLIProxy before migrating.")
  }
  if (fs.existsSync(path.join(root, "update-transaction.json"))) throw new Error("Recover the pending CLIProxy update before migrating.")
}

function privateBackup(source: string, target: string, root = source) {
  const info = fs.lstatSync(source)
  if (info.isSymbolicLink()) {
    const link = fs.readlinkSync(source)
    if (source !== path.join(root, "current") || !/^versions\/\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(link)) throw new Error("Unexpected symlink in CLIProxy state.")
    fs.symlinkSync(link, target)
  } else if (info.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o700 })
    for (const name of fs.readdirSync(source)) {
      if (source === root && name === "lifecycle-lock") continue
      privateBackup(path.join(source, name), path.join(target, name), root)
    }
  } else if (info.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(target, info.mode & 0o111 ? 0o700 : 0o600)
  } else throw new Error("Unexpected non-regular file in CLIProxy state.")
}

/** Stopped managed upgrade: durable full backup includes the old binary and secrets. */
export async function migrateManaged(dataRoot: string, options: Options = {}) {
  const paths = getServicePaths(path.resolve(dataRoot))
  stopped(paths.root)
  const release = await lockfile.lock(paths.root, { lockfilePath: paths.lock, retries: 0 })
  try {
    stopped(paths.root)
    const original = fs.readFileSync(paths.config, "utf8")
    const next = JSON.stringify(convertConfig(original), null, 2) + "\n"
    validateLoopbackConfig(next)
    const state = readState(paths)
    const changed = JSON.stringify(parseConfig(original)) !== JSON.stringify(parseConfig(next)) || state.installedVersion !== VERSION || !fs.existsSync(paths.current) || fs.readlinkSync(paths.current) !== `versions/${VERSION}`
    if (!changed || !options.apply) return { changed, applied: false, version: VERSION }
    if (!options.writersStopped) throw new Error("--writers-stopped is required to apply this migration.")
    const backup = `${paths.root}.before-migration`
    if (fs.existsSync(backup)) throw new Error("Migration backup already exists; inspect or restore it before retrying.")
    privateBackup(paths.root, backup)
    try {
      const binary = options.binary || process.env.CLIPROXY_BUNDLED_BINARY
      if (binary) {
        verifyBinary(binary)
        const directory = path.join(paths.versions, VERSION)
        if (!fs.existsSync(directory)) {
          const staging = path.join(paths.versions, `.staging-${randomUUID()}`)
          fs.mkdirSync(staging, { mode: 0o700 })
          try {
            fs.copyFileSync(binary, path.join(staging, "cli-proxy-api"), fs.constants.COPYFILE_EXCL)
            fs.chmodSync(path.join(staging, "cli-proxy-api"), 0o555)
            fs.renameSync(staging, directory)
          } finally { fs.rmSync(staging, { recursive: true, force: true }) }
        }
      } else await prepareVersion(paths, VERSION)
      verifyBinary(path.join(paths.versions, VERSION, "cli-proxy-api"))
      writeAtomic(paths.config, next)
      setCurrentVersion(paths, VERSION)
      writeState(paths, { ...state, installedVersion: VERSION, pinnedVersion: VERSION })
    } catch (error) {
      // Restore the original pointers/config; the permanent backup is retained.
      writeAtomic(paths.config, original)
      for (const name of ["state.json", "current"]) {
        const target = path.join(paths.root, name), saved = path.join(backup, name)
        fs.rmSync(target, { force: true })
        if (fs.readdirSync(backup).includes(name)) privateBackup(saved, target, backup)
      }
      throw error
    }
    return { changed: true, applied: true, version: VERSION, backup }
  } finally { await release() }
}

/** External engines retain their deployment listener and auth-directory boundaries. */
export function migrateExternal(file: string, options: Options = {}) {
  const original = fs.readFileSync(file, "utf8")
  const config = convertConfig(original)
  const changed = JSON.stringify(parseConfig(original)) !== JSON.stringify(config)
  if (!changed || !options.apply) return { changed, applied: false }
  if (!options.writersStopped) throw new Error("--writers-stopped is required to apply this migration.")
  const backup = `${file}.before-migration`
  privateBackup(file, backup)
  writeAtomic(file, JSON.stringify(config, null, 2) + "\n")
  return { changed, applied: true, backup }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const dataRoot = value("--data-dir"), config = value("--config")
  if (Boolean(dataRoot) === Boolean(config)) throw new Error("Usage: bun --no-env-file scripts/migrations/cliproxy.ts (--data-dir <managed-data> | --config <external-yaml>) [--apply --writers-stopped] [--binary <8.0.43-binary>]")
  const options = { apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), binary: value("--binary") }
  console.log(JSON.stringify(dataRoot ? await migrateManaged(dataRoot, options) : migrateExternal(config!, options), null, 2))
}
