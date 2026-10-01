import { copyFileSync, chmodSync, readFileSync, existsSync } from "node:fs"
import { writeAtomic, validateLoopbackConfig } from "../../src/server/cliproxy/store"

/** Offline conversion; preserves credentials, account mappings, and provider configuration. */
export function convertCliProxyDefaults(file: string, apply = false) {
  const contents = readFileSync(file, "utf8")
  validateLoopbackConfig(contents)
  const config = Bun.YAML.parse(contents) as Record<string, unknown>
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Expected a configuration mapping.")
  const routing = config.routing && typeof config.routing === "object" ? config.routing : {}
  const next = { ...config, debug: false, "logging-to-file": true, "logs-max-total-size-mb": 100,
    "usage-statistics-enabled": true, "request-retry": 0, "max-retry-interval": 0,
    routing: { ...routing, strategy: "fill-first" } }
  const changed = JSON.stringify(config) !== JSON.stringify(next)
  if (changed && apply) {
    const backup = `${file}.before-managed-defaults`
    if (existsSync(backup)) throw new Error("Backup already exists; inspect it before applying again.")
    copyFileSync(file, backup)
    chmodSync(backup, 0o600)
    writeAtomic(file, JSON.stringify(next, null, 2) + "\n")
  }
  return { changed, applied: changed && apply }
}
