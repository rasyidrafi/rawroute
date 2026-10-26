import { expect } from "bun:test"
import { initCliproxy, getStatus, restart, stop, start, shutdownCliproxy } from "../../packages/gateway-ai/src/server/cliproxy/service"
import { cliproxyBaseUrl, cliproxySecret } from "../../packages/gateway-ai/src/server/cliproxy/connection"
import { cliproxyManagement, cliproxyManagementJson } from "../../packages/gateway-ai/src/server/cliproxy/management"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { upsertProvider, upsertProviderApiKey, upsertModel } from "../../packages/gateway-ai/src/server/store"
import { nonCodexProviderPrefix, syncNonCodexProviderProjection } from "../../packages/gateway-ai/src/server/cliproxy/provider-sync"
import * as fs from "node:fs"
import * as path from "node:path"
import { getDataRoot, getServicePaths, ensureLayout, CLIPROXY_PORT } from "../../packages/gateway-ai/src/server/cliproxy/store"
import { migrateManaged } from "../../scripts/migrations/cliproxy"

if (process.argv.includes("--migrate")) {
  const paths = getServicePaths(getDataRoot())
  ensureLayout(paths)
  const apiKey = "fixture-internal-api-key-12345678901234567890"
  const managementKey = "fixture-internal-management-key-12345678901234567890"
  fs.writeFileSync(paths.apiKey, apiKey)
  fs.writeFileSync(paths.managementKey, managementKey)
  fs.writeFileSync(paths.config, JSON.stringify({ host: "127.0.0.1", port: CLIPROXY_PORT, "auth-dir": paths.auth, "api-keys": [apiKey], "remote-management": { "allow-remote": false, "secret-key": managementKey, "disable-control-panel": true }, plugins: { enabled: false }, routing: { strategy: "fill-first" }, "request-retry": 0, "disable-cooling": true, "claude-api-key": [{ "api-key": "preserved-claude-key", prefix: "external", "base-url": "https://example.invalid" }] }))
  fs.writeFileSync(path.join(paths.auth, "preserved.json"), JSON.stringify({ type: "codex", access_token: "synthetic", disabled: true, prefix: "rr-codex-preserved" }))
  fs.mkdirSync(path.join(paths.versions, "7.3.4"))
  fs.writeFileSync(path.join(paths.versions, "7.3.4", "cli-proxy-api"), "old installation backup fixture")
  fs.symlinkSync("versions/7.3.4", paths.current)
  fs.writeFileSync(paths.state, JSON.stringify({ schemaVersion: 1, installedVersion: "7.3.4", pinnedVersion: "7.3.4", desiredRunning: true }))
  const result = await migrateManaged(getDataRoot(), { apply: true, writersStopped: true, binary: process.env.CLIPROXY_BUNDLED_BINARY })
  expect(result.applied).toBe(true)
  expect(fs.readFileSync(path.join(paths.auth, "preserved.json"), "utf8")).toBe(fs.readFileSync(path.join(`${paths.root}.before-migration`, "auth/preserved.json"), "utf8"))
}

const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  expect(request.headers.get("authorization")).toBe("Bearer fixture-provider-key")
  const body = await request.json() as { model: string }
  expect(body.model).toBe("fixture-model")
  return Response.json({ id: "fixture", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })
} })
async function infer() {
  let catalog: { data?: Array<{ id: string }> } = {}
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${cliproxyBaseUrl()}/v1/models`, { headers: { authorization: `Bearer ${cliproxySecret("apiKey")}` } })
    catalog = await response.json()
    if (catalog.data?.some(model => model.id === "rr-fixture/chat")) break
    await Bun.sleep(50)
  }
  expect(catalog.data?.some(model => model.id === "rr-fixture/chat"), JSON.stringify(catalog)).toBe(true)
  const response = await fetch(`${cliproxyBaseUrl()}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${cliproxySecret("apiKey")}`, "content-type": "application/json" }, body: JSON.stringify({ model: "rr-fixture/chat", messages: [{ role: "user", content: "test" }] }) })
  expect(response.status, await response.clone().text()).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("OK")
}
try {
  await initCliproxy()
  expect((await getStatus()).healthy).toBe(true)
  expect((await getStatus()).version).toBe("8.0.43")
  if (process.argv.includes("--migrate")) {
    const migrated = await cliproxyManagementJson<unknown>("/v8/management/config/api-keys/claude")
    expect(migrated.data).toMatchObject([{ prefix: "external", keys: [{ "api-key": "preserved-claude-key" }] }])
  }
  expect((await fetch(`${cliproxyBaseUrl()}/v1/models`)).status).toBe(401)
  const projected = await cliproxyManagement("/v8/management/config/api-keys/openai-compatibility", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify([{ name: "rawroute-real-fixture", prefix: "rr-fixture", "base-url": `${upstream.url}v1`, keys: [{ "api-key": "fixture-provider-key" }], models: [{ name: "fixture-model", alias: "chat" }] }]) })
  expect(projected.status).toBe(200)
  await infer()
  await runInWorkspace({ id: "integration" }, async () => {
    const provider = await upsertProvider({ name: "Projected", prefix: "projected", protocol: "openai-chat", authType: "bearer", baseUrl: `${upstream.url}v1`, enabled: true })
    await upsertProviderApiKey(provider.id, { name: "Fixture", key: "fixture-provider-key", enabled: true })
    await upsertModel(provider.id, { gatewayModelId: "projected/chat", name: "Fixture", upstreamModel: "fixture-model", enabled: true })
    await syncNonCodexProviderProjection(provider.id)
    await syncNonCodexProviderProjection(provider.id)
    const config = await cliproxyManagementJson<Array<{ name: string; prefix: string; keys: unknown[] }>>("/v8/management/config/api-keys/openai-compatibility")
    expect(config.data?.some(entry => entry.name === "rawroute-real-fixture")).toBe(true)
    expect(config.data?.filter(entry => entry.prefix === nonCodexProviderPrefix("integration", provider.id))).toHaveLength(1)
  })
  await restart()
  expect((await getStatus()).healthy).toBe(true)
  const config = await cliproxyManagementJson<Record<string, unknown>>("/v8/management/config")
  expect(config.data?.routing).toMatchObject({ strategy: "fill-first" })
  await infer()
  await stop()
  expect((await getStatus()).desiredRunning).toBe(false)
  expect((await getStatus()).processRunning).toBe(false)
  await start()
  await infer()
  console.log("Real CLIProxy integration passed")
} finally { await shutdownCliproxy(); upstream.stop(true) }
