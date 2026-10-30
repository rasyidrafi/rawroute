import { expect, test } from "bun:test"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"
import { proxyToCliProxy, proxyToNativeResponses } from "../../../packages/gateway-ai/src/server/cliproxy/transport"
import { collectStreamUsage } from "../../../packages/gateway-ai/src/server/cliproxy/stream-usage"
import type { ResolvedGatewayModel } from "../../../packages/gateway-ai/src/server/cliproxy/model-resolution"

for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
  test(`forwards decoded ${encoding} streams without asking clients to decode twice`, async () => {
    const body = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n'
    const compressed = compress(body)
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(compressed, { headers: { "content-type": "text/event-stream", "content-encoding": encoding, "content-length": String(compressed.length), "x-request-id": "compressed-response" } }) })
    const previousUrl = process.env.CLIPROXY_URL
    const previousMode = process.env.CLIPROXY_MODE
    process.env.CLIPROXY_URL = upstream.url.toString()
    process.env.CLIPROXY_MODE = "external"
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => proxyToCliProxy(request, "/v1/responses", { admitted: true }) })
    try {
      const response = await fetch(proxy.url, { headers: { "accept-encoding": encoding } })
      expect(response.headers.get("content-encoding")).toBeNull()
      expect(response.headers.get("x-request-id")).toBe("compressed-response")
      const [client, accounting] = response.body!.tee()
      expect(await new Response(client).text()).toBe(body)
      expect(await collectStreamUsage(accounting)).toMatchObject({ terminalEventSeen: true, usage: { input: 1, output: 2 } })
    } finally {
      proxy.stop(true)
      upstream.stop(true)
      if (previousUrl === undefined) delete process.env.CLIPROXY_URL
      else process.env.CLIPROXY_URL = previousUrl
      if (previousMode === undefined) delete process.env.CLIPROXY_MODE
      else process.env.CLIPROXY_MODE = previousMode
    }
  })
}

test("native provider error responses retain status and retry headers after decompression", async () => {
  const body = JSON.stringify({ error: { message: "overloaded" } })
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(gzipSync(body), { status: 502, headers: { "content-type": "application/json", "content-encoding": "gzip", "retry-after": "3" } }) })
  try {
    const resolved: ResolvedGatewayModel = {
      forwardedModel: "test", upstreamModel: "test", upstreamProtocol: "openai-responses", pricingGatewayModelId: "test", modelName: "test", promptCacheKey: false,
      nativeResponses: { baseUrl: upstream.url.toString(), authType: "none", apiKeys: [], headers: {} },
    }
    const response = await proxyToNativeResponses(new Request("http://localhost/v1/responses"), resolved, new TextEncoder().encode("{}"))
    expect(response.status).toBe(502)
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(response.headers.get("retry-after")).toBe("3")
    expect(await response.text()).toBe(body)
  } finally { upstream.stop(true) }
})
