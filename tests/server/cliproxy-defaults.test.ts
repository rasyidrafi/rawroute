import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderConfig } from "../../src/server/cliproxy/store"
import { convertCliProxyDefaults } from "../../scripts/migrations/cliproxy-defaults"

const defaults = { debug: false, "logging-to-file": true, "logs-max-total-size-mb": 100, "usage-statistics-enabled": true, "request-retry": 0, "max-retry-interval": 0, routing: { strategy: "fill-first" } }
test("fresh managed engines use fixed internal defaults", () => {
  expect(Bun.YAML.parse(renderConfig("transport", "management", "/private/auth"))).toMatchObject(defaults)
})
test("offline conversion preserves credentials and custom provider settings with a backup", () => {
  const root = mkdtempSync(join(tmpdir(), "rawroute-defaults-"))
  try {
    const file = join(root, "config.yaml")
    const original = { host: "127.0.0.1", port: 8317, debug: true, "api-keys": ["private"], "openai-compatibility": [{ name: "workspace-provider" }], routing: { strategy: "round-robin" } }
    writeFileSync(file, JSON.stringify(original))
    expect(convertCliProxyDefaults(file)).toEqual({ changed: true, applied: false })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original)
    expect(convertCliProxyDefaults(file, true).applied).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...original, ...defaults })
    expect(JSON.parse(readFileSync(`${file}.before-managed-defaults`, "utf8"))).toEqual(original)
    expect(convertCliProxyDefaults(file, true).changed).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
