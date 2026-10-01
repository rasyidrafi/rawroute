import { expect } from "bun:test"
import { initCliproxy, getStatus, restart, stop, start, shutdownCliproxy } from "@/server/cliproxy/service"
import { cliproxyBaseUrl, cliproxySecret } from "@/server/cliproxy/connection"
import { cliproxyManagement, cliproxyManagementJson } from "@/lib/cliproxy/management"

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
  expect((await fetch(`${cliproxyBaseUrl()}/v1/models`)).status).toBe(401)
  const projected = await cliproxyManagement("/v0/management/openai-compatibility", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify([{ name: "rawroute-real-fixture", prefix: "rr-fixture", "base-url": `${upstream.url}v1`, "api-key-entries": [{ "api-key": "fixture-provider-key" }], models: [{ name: "fixture-model", alias: "chat" }] }]) })
  expect(projected.status).toBe(200)
  await infer()
  await restart()
  expect((await getStatus()).healthy).toBe(true)
  const config = await cliproxyManagementJson<Record<string, unknown>>("/v0/management/config")
  expect(config.data?.routing).toMatchObject({ strategy: "fill-first" })
  await infer()
  await stop()
  expect((await getStatus()).desiredRunning).toBe(false)
  expect((await getStatus()).processRunning).toBe(false)
  await start()
  await infer()
  console.log("Real CLIProxy integration passed")
} finally { await shutdownCliproxy(); upstream.stop(true) }
