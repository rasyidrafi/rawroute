import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { convertConfig, migrateExternal, migrateManaged } from "../../scripts/migrations/cliproxy"
import { getServicePaths, ensureLayout, validateLoopbackConfig } from "../../packages/gateway-ai/src/server/cliproxy/store"
import { snapshotConfiguration, restoreConfiguration } from "../../packages/gateway-ai/src/server/cliproxy/backup"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cliproxy-migration-")); roots.push(root)
  const paths = getServicePaths(root)
  ensureLayout(paths)
  const original = { host: "127.0.0.1", port: 8317, "auth-dir": paths.auth, "api-keys": ["client-secret"], "remote-management": { "secret-key": "management-secret", "allow-remote": false }, "request-retry": 0, "disable-cooling": true, routing: { strategy: "fill-first" }, "custom-option": { keep: true }, "openai-compatibility": [{ name: "unmanaged", "base-url": "https://example.invalid/v1", "api-key-entries": [{ "api-key": "provider-secret", "proxy-url": "http://proxy.invalid" }], models: [{ name: "upstream", alias: "public" }] }], "claude-api-key": [{ "api-key": "claude-secret", prefix: "rr-ws-0123456789abcdef-p-0123456789ab", priority: 4 }] }
  fs.writeFileSync(paths.config, JSON.stringify(original))
  fs.writeFileSync(paths.apiKey, "client-secret")
  fs.writeFileSync(paths.managementKey, "management-secret")
  fs.writeFileSync(path.join(paths.auth, "existing.json"), '{"refresh_token":"unchanged","prefix":"rr-codex-workspace"}')
  fs.mkdirSync(path.join(paths.versions, "7.3.4"))
  fs.writeFileSync(path.join(paths.versions, "7.3.4", "cli-proxy-api"), "old binary")
  fs.symlinkSync("versions/7.3.4", paths.current)
  fs.writeFileSync(paths.state, JSON.stringify({ schemaVersion: 1, desiredRunning: true, installedVersion: "7.3.4", pinnedVersion: "7.3.4" }))
  const binary = path.join(root, "v8-binary")
  fs.writeFileSync(binary, '#!/bin/sh\necho "CLIProxyAPI Version: 8.0.43, Commit: fixture"\n', { mode: 0o700 })
  return { root, paths, original, binary }
}

test("offline conversion preserves credentials and provider options; mixed layouts are rejected", () => {
  const { original } = fixture()
  expect(() => convertConfig(JSON.stringify({ ...original, server: { host: "127.0.0.1", port: 8317 } }))).toThrow("Mixed")
  const config = convertConfig(JSON.stringify({ ...original, "credential-concurrency": { "cleanup-interval": "5s" }, "credential-in-flight": { "snapshot-interval": "2s" }, discovery: { "service-type": "_ai-gateway._tcp" }, "redis-usage-queue-retention-seconds": 60, "ws-auth": true }))
  expect(config).toMatchObject({ "config-version": 8, access: { "api-keys": ["client-secret"] }, routing: { retry: { "request-retry": 0 }, cooldown: { "disable-cooling": true } }, "custom-option": { keep: true }, management: { "secret-key": "management-secret" } })
  expect(config["api-keys"]).toMatchObject({ "openai-compatibility": [{ name: "unmanaged", keys: [{ "api-key": "provider-secret", "proxy-url": "http://proxy.invalid" }], models: [{ name: "upstream", alias: "public" }] }], claude: [{ name: "rr-managed-0123456789abcdef-0123456789ab-migrated-0", keys: [{ "api-key": "claude-secret" }], priority: 4 }] })
  expect(config).not.toHaveProperty("host")
  expect(config).not.toHaveProperty("openai-compatibility")
  expect(config).toMatchObject({ credentials: { concurrency: { "cleanup-interval": "5s" }, "in-flight": { "snapshot-interval": "2s" } }, server: { discovery: { "service-type": "_ai-gateway._tcp" } }, oauth: { providers: { aistudio: { "ws-auth": true } } }, observability: { usage: { "redis-usage-queue-retention-seconds": 60 } } })
  for (const key of ["credential-concurrency", "credential-in-flight", "discovery", "redis-usage-queue-retention-seconds", "ws-auth"]) expect(config).not.toHaveProperty(key)
  validateLoopbackConfig(JSON.stringify(config))
  expect(convertConfig(JSON.stringify(config))).toEqual(config)
})

test("managed upgrade requires stopped writers, backs up binary/auth/secrets and preserves identity and desired state", async () => {
  const { root, paths, original, binary } = fixture()
  expect(await migrateManaged(root)).toMatchObject({ changed: true, applied: false })
  expect(JSON.parse(fs.readFileSync(paths.config, "utf8"))).toEqual(original)
  await expect(migrateManaged(root, { apply: true, binary })).rejects.toThrow("writers-stopped")
  fs.writeFileSync(paths.manager, JSON.stringify({ pid: process.pid }))
  await expect(migrateManaged(root, { apply: true, writersStopped: true, binary })).rejects.toThrow("Stop RawRoute")
  fs.unlinkSync(paths.manager)
  const result = await migrateManaged(root, { apply: true, writersStopped: true, binary })
  expect(result.applied).toBe(true)
  expect(fs.readlinkSync(paths.current)).toBe("versions/8.0.43")
  expect(JSON.parse(fs.readFileSync(paths.state, "utf8"))).toMatchObject({ desiredRunning: true, installedVersion: "8.0.43", pinnedVersion: "8.0.43" })
  expect(JSON.parse(fs.readFileSync(paths.config, "utf8")).oauth["auth-dir"]).toBe(paths.auth)
  const backup = `${paths.root}.before-migration`
  expect(fs.readlinkSync(path.join(backup, "current"))).toBe("versions/7.3.4")
  expect(JSON.parse(fs.readFileSync(path.join(backup, "config.yaml"), "utf8"))).toEqual(original)
  for (const name of ["auth/existing.json", "secrets/api-key", "secrets/management-key"]) expect(fs.readFileSync(path.join(paths.root, name), "utf8")).toBe(fs.readFileSync(path.join(backup, name), "utf8"))
  expect(fs.statSync(path.join(backup, "config.yaml")).mode & 0o777).toBe(0o600)
  expect(await migrateManaged(root, { apply: true, writersStopped: true, binary })).toMatchObject({ changed: false, applied: false })
})

test("failed binary validation preserves original config/current/state and permanent backup", async () => {
  const { root, paths, original, binary } = fixture()
  fs.writeFileSync(binary, '#!/bin/sh\necho "CLIProxyAPI Version: 7.3.4, Commit: fixture"\n')
  await expect(migrateManaged(root, { apply: true, writersStopped: true, binary })).rejects.toThrow("requires CLIProxyAPI 8.0.43")
  expect(JSON.parse(fs.readFileSync(paths.config, "utf8"))).toEqual(original)
  expect(fs.readlinkSync(paths.current)).toBe("versions/7.3.4")
  expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).installedVersion).toBe("7.3.4")
  expect(fs.existsSync(`${paths.root}.before-migration`)).toBe(true)
})

test("migration rejects duplicate listener keys, unknown symlinks and interrupted lifecycle updates", async () => {
  expect(() => convertConfig("host: 127.0.0.1\nhost: 0.0.0.0\n")).toThrow()
  const { root, paths, binary } = fixture()
  fs.writeFileSync(paths.transaction, "{}")
  await expect(migrateManaged(root)).rejects.toThrow("pending")
  fs.unlinkSync(paths.transaction)
  fs.symlinkSync(paths.apiKey, path.join(paths.auth, "symlink"))
  await expect(migrateManaged(root, { apply: true, writersStopped: true, binary })).rejects.toThrow("Unexpected symlink")
  expect(fs.readlinkSync(paths.current)).toBe("versions/7.3.4")
})

test("external migration preserves deployment listener and only converts after explicit stopped-writer acknowledgement", () => {
  const { paths, original } = fixture()
  fs.writeFileSync(paths.config, JSON.stringify({ ...original, host: "", "remote-management": { "allow-remote": true } }))
  expect(() => migrateExternal(paths.config, { apply: true })).toThrow("writers-stopped")
  expect(migrateExternal(paths.config, { apply: true, writersStopped: true }).applied).toBe(true)
  expect(JSON.parse(fs.readFileSync(paths.config, "utf8"))).toMatchObject({ server: { host: "", port: 8317 }, management: { "allow-remote": true } })
  expect(migrateExternal(paths.config, { apply: true, writersStopped: true }).changed).toBe(false)
})

test("failed engine updates restore canonical config and credentials without retaining new auth files", () => {
  const { paths, original } = fixture()
  const config = JSON.stringify(convertConfig(JSON.stringify(original)))
  fs.writeFileSync(paths.config, config)
  const credential = fs.readFileSync(path.join(paths.auth, "existing.json"), "utf8")
  snapshotConfiguration(paths)
  fs.writeFileSync(paths.config, "corrupted")
  fs.writeFileSync(path.join(paths.auth, "existing.json"), "changed token")
  fs.writeFileSync(path.join(paths.auth, "new.json"), "new token")
  restoreConfiguration(paths)
  expect(fs.readFileSync(paths.config, "utf8")).toBe(config)
  expect(fs.readFileSync(path.join(paths.auth, "existing.json"), "utf8")).toBe(credential)
  expect(fs.existsSync(path.join(paths.auth, "new.json"))).toBe(false)
})
