import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { importLegacyInstance } from "../../scripts/migrations/cliproxy-instance"
import { getServicePaths, validateLoopbackConfig } from "../../src/server/cliproxy/store"
import { snapshotConfiguration, restoreConfiguration } from "../../src/server/cliproxy/backup"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-cliproxy-import-")); roots.push(root)
  const source = path.join(root, "legacy"), destination = path.join(root, "managed")
  fs.mkdirSync(path.join(source, "auths"), { recursive: true })
  fs.writeFileSync(path.join(source, "config.yaml"), 'host: ""\nport: 8317\nauth-dir: /root/.cli-proxy-api\napi-keys: [legacy-private-key]\nrouting: {strategy: fill-first}\nrequest-retry: 0\ndisable-cooling: true\ncustom-option: {keep: true}\n')
  fs.writeFileSync(path.join(source, "auths", "codex-existing.json"), JSON.stringify({ refresh_token: "private-token", prefix: "rr-codex-existing", priority: 5 }))
  return { root, source, destination }
}

test("offline migration preserves credentials, identity, custom options and source files", async () => {
  const { source, destination } = fixture()
  const before = fs.readFileSync(path.join(source, "config.yaml"), "utf8")
  await importLegacyInstance(source, destination)
  const paths = getServicePaths(destination)
  const content = fs.readFileSync(paths.config, "utf8")
  validateLoopbackConfig(content)
  const config = JSON.parse(content)
  expect(config).toMatchObject({ host: "127.0.0.1", port: 8317, "auth-dir": paths.auth, routing: { strategy: "fill-first" }, "disable-cooling": true, "custom-option": { keep: true } })
  expect(config["api-keys"]).toContain("legacy-private-key")
  expect(config["api-keys"]).toContain(fs.readFileSync(paths.apiKey, "utf8"))
  expect(config["remote-management"]["allow-remote"]).toBe(false)
  expect(fs.readFileSync(path.join(paths.auth, "codex-existing.json"), "utf8")).toBe(fs.readFileSync(path.join(source, "auths", "codex-existing.json"), "utf8"))
  expect(fs.readFileSync(path.join(source, "config.yaml"), "utf8")).toBe(before)
  await expect(importLegacyInstance(source, destination)).rejects.toThrow("already exists")
})

test("a failed import never publishes partial state or follows auth symlinks", async () => {
  const { source, destination } = fixture()
  fs.symlinkSync("/etc/passwd", path.join(source, "auths", "unsafe"))
  await expect(importLegacyInstance(source, destination)).rejects.toThrow("symbolic links")
  expect(fs.existsSync(getServicePaths(destination).root)).toBe(false)
})

test("rollback restores config and credential contents and removes files created by a failed release", async () => {
  const { source, destination } = fixture()
  await importLegacyInstance(source, destination)
  const paths = getServicePaths(destination)
  const before = fs.readFileSync(paths.config, "utf8")
  snapshotConfiguration(paths)
  fs.writeFileSync(paths.config, "changed")
  fs.writeFileSync(path.join(paths.auth, "codex-existing.json"), "changed token")
  fs.writeFileSync(path.join(paths.auth, "new.json"), "new token")
  restoreConfiguration(paths)
  expect(fs.readFileSync(paths.config, "utf8")).toBe(before)
  expect(JSON.parse(fs.readFileSync(path.join(paths.auth, "codex-existing.json"), "utf8")).refresh_token).toBe("private-token")
  expect(fs.existsSync(path.join(paths.auth, "new.json"))).toBe(false)
})
