import { afterEach, beforeEach, expect, test } from "bun:test"
import type { BunRequest } from "bun"
import { apiRoutes } from "../../../../../../../../../../apps/console/src/server/routes"
import { closeLocalDatabase } from "../../../../../../../../../platform/src/server/database"
import { recordUsageEvent, resetAnalyticsForTests } from "../../../../../../analytics"
import { runInWorkspace } from "../../../../../../../../../platform/src/server/workspace-context"
import { createApiKey, _resetMemoryBackend } from "../../../../../../store"
import { createWorkspace } from "../../../../../../../../../platform/src/server/runtime"
import type { UsageEvent } from "../../../../../../../contracts/domain"

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { SQLITE_PATH: ":memory:", STORAGE_BACKEND: "memory", NODE_ENV: "test", TIMEZONE: "UTC" })
  _resetMemoryBackend()
  resetAnalyticsForTests()
})
afterEach(async () => { await closeLocalDatabase() })

type RequestParams = Record<string, string>
type RegisteredRoute = (request: BunRequest<string>) => Promise<Response>

function callRoute(routePath: string, method: string, url: string, params: RequestParams = {}) {
  const route = apiRoutes[routePath as keyof typeof apiRoutes] as RegisteredRoute
  const request = Object.assign(new Request(url, { method }), { params }) as unknown as BunRequest<string>
  return route(request)
}

test("public usage detail reads are unauthenticated, key-scoped, and expose no management mutations", async () => {
  const workspace = await createWorkspace("Public usage detail")
  let publicId = ""
  let secret = ""
  let internalKeyId = ""
  await runInWorkspace(workspace, async () => {
    const key = await createApiKey("Visible key")
    secret = key.key
    internalKeyId = key.id
    const completedAt = new Date().toISOString()
    const event: UsageEvent & { requestPayload: { prompt: string } } = {
      id: "public-detail-event",
      gatewayKeyId: key.id,
      providerId: "private-provider-id",
      providerModelId: "private-provider-model-id",
      gatewayModelId: "public/model",
      protocol: "openai-chat",
      startedAt: completedAt,
      completedAt,
      status: 200,
      durationMs: 24,
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 16,
      costMicros: 456_740_000,
      pricingConfidence: "exact",
      usageAvailable: true,
      reasoningEffort: "high",
      toolCount: 0,
      requestPayload: { prompt: "private public-usage prompt" },
    }
    await recordUsageEvent(event, null)
    const otherKey = await createApiKey("Other visible key")
    const otherEvent = { ...event, id: "other-key-event", gatewayKeyId: otherKey.id, requestPayload: { prompt: "other private prompt" } }
    await recordUsageEvent(otherEvent, null)
    const malformedMetadata = {
      ...event,
      id: "malformed-public-metadata",
      completedAt: new Date(Date.now() + 1).toISOString(),
      reasoningEffort: "customer-private-value",
      toolCount: -1,
    } as unknown as UsageEvent
    await recordUsageEvent(malformedMetadata, null)
    const publicKeys = (await (await callRoute("/api/public/dashboard", "GET", `http://localhost/api/public/dashboard?workspace=${workspace.id}&preset=all`)).json() as { keys: Array<{ label: string; publicId: string }> }).keys
    publicId = publicKeys.find(key => key.label === "Visible key")!.publicId
  })

  const response = await callRoute("/api/public/usage/keys/:keyId", "GET", `http://localhost/api/public/usage/keys/${publicId}?workspace=${workspace.id}`, { keyId: publicId })
  expect(response.status).toBe(200)
  const detail = await response.json() as { usage: { range: { granularity: string }; summary: { tokens: number }; trend: Array<{ tokens: number }> } }
  const body = JSON.stringify(detail)
  expect(body).toContain("public-detail-event")
  expect(body).toContain("Visible key")
  expect(body).toContain('"reasoningEffort":"high"')
  expect(body).toContain('"toolCount":0')
  expect(body).not.toContain(secret)
  expect(body).not.toContain(internalKeyId)
  expect(body).not.toContain("private-provider-id")
  expect(body).not.toContain("private-provider-model-id")
  expect(body).not.toContain("private public-usage prompt")
  expect(body).not.toContain("customer-private-value")
  expect(body).not.toContain('"toolCount":-1')
  expect(body).not.toContain("other-key-event")
  expect(body).not.toContain("other private prompt")
  expect(detail.usage.range.granularity).toBe("daily")
  expect(detail.usage.summary.tokens).toBe(32)
  expect(detail.usage.trend.reduce((sum, point) => sum + point.tokens, 0)).toBe(32)

  const mutation = await callRoute("/api/public/usage/keys/:keyId", "POST", `http://localhost/api/public/usage/keys/${publicId}?workspace=${workspace.id}`, { keyId: publicId })
  expect(mutation.status).toBe(405)
  const protectedManagement = await callRoute("/api/admin/budgets", "POST", "http://localhost/api/admin/budgets")
  expect(protectedManagement.status).toBe(401)
})

test("public usage details cannot cross workspace boundaries", async () => {
  const first = await createWorkspace("First public workspace")
  const second = await createWorkspace("Second public workspace")
  let publicId = ""
  await runInWorkspace(first, async () => {
    const key = await createApiKey("First key")
    const now = new Date().toISOString()
    await recordUsageEvent({ id: "first-workspace-event", gatewayKeyId: key.id, gatewayModelId: "model", protocol: "openai-chat", startedAt: now, completedAt: now, status: 200, durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2, costMicros: 10, pricingConfidence: "exact", usageAvailable: true }, null)
    const payload = await (await callRoute("/api/public/dashboard", "GET", `http://localhost/api/public/dashboard?workspace=${first.id}&preset=all`)).json() as { keys: Array<{ publicId: string }> }
    publicId = payload.keys[0]!.publicId
  })
  const response = await callRoute("/api/public/usage/keys/:keyId", "GET", `http://localhost/api/public/usage/keys/${publicId}?workspace=${second.id}`, { keyId: publicId })
  expect(response.status).toBe(404)
})
