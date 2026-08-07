import { describe, expect, test } from "vitest"

import { RedisRoutingStateStore, type RoutingRedis } from "@/lib/routing-state"
import type { ProviderApiKey } from "@/lib/types"

type EvalCall = { script: string; keys: string[]; args: Array<string | number> }
type SetCall = { key: string; value: string; options?: { ex?: number } }

class FakePipeline {
  readonly calls: SetCall[] = []
  executions = 0

  set(key: string, value: string, options?: { ex?: number }) {
    this.calls.push({ key, value, options })
    return this
  }

  async exec() {
    this.executions += 1
    return this.calls.map(() => "OK")
  }
}

class FakeRedis implements RoutingRedis {
  readonly calls: EvalCall[] = []
  readonly setCalls: SetCall[] = []
  readonly pipelines: FakePipeline[] = []
  responses: unknown[] = []
  pipelineEnabled = true

  async eval(script: string, keys: string[], args: Array<string | number>) {
    this.calls.push({ script, keys, args })
    return this.responses.shift()
  }

  async get<T = string>() { return null as T | null }

  async set(key: string, value: string, options?: { ex?: number }) {
    this.setCalls.push({ key, value, options })
    return "OK"
  }

  pipeline() {
    if (!this.pipelineEnabled) return undefined as never
    const pipeline = new FakePipeline()
    this.pipelines.push(pipeline)
    return pipeline
  }
}

const keys: ProviderApiKey[] = [
  { id: "a", providerId: "provider", name: "A", key: "a", enabled: true, rpmLimit: 10, maxConcurrency: 2, priority: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", providerId: "provider", name: "B", key: "b", enabled: true, rpmLimit: 20, maxConcurrency: 3, priority: 2, createdAt: "2026-01-01T00:00:00.000Z" },
]

function firstCall(redis: FakeRedis) {
  const call = redis.calls[0]
  expect(call).toBeDefined()
  return call!
}

describe("Redis routing state", () => {
  test("atomically reserves and pins the least-loaded credential", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "b", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test", affinityTtlSeconds: 3600 })

    const result = await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, sessionKey: "session", hardAffinity: false })

    expect(result).toMatchObject({ ok: true, credentialId: "b", affinity: "new" })
    if (result.ok) expect(typeof result.leaseId).toBe("string")
    expect(firstCall(redis).keys).toEqual([
      "test:state:default:provider",
      "test:affinity:default:provider:model:session",
    ])
    expect(firstCall(redis).args).toContain(20)
    expect(firstCall(redis).script).toContain("local shouldReadSession")
    expect(firstCall(redis).script).not.toContain("and not refreshAffinity and redis.call")
  })

  test("keeps core Redis keys and commands constant as credential count grows", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"], ["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.reserve({ providerId: "provider", modelId: "model", credentials: keys.slice(0, 1), hardAffinity: false })
    await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, hardAffinity: false })

    expect(redis.calls[0]?.keys).toEqual(["test:state:default:provider"])
    expect(redis.calls[1]?.keys).toEqual(["test:state:default:provider"])
    const script = redis.calls[0]?.script || ""
    expect(script).toContain('redis.call("HMGET", KEYS[1]')
    expect(script).toContain('redis.call("HSET", KEYS[1]')
    expect(script).not.toContain('redis.call("TIME")')
    expect(script).not.toContain("ZREMRANGEBYSCORE")
    expect(script).not.toContain("ZCARD")
  })

  test("uses a conservative one-second RPM ring and amortized stale-field cleanup", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, hardAffinity: false })

    const script = firstCall(redis).script
    expect(script).toContain("local rpmRetentionMs = 61000")
    expect(script).toContain('redis.call("HKEYS", KEYS[1])')
    expect(script).toContain('redis.call("HDEL", KEYS[1]')
    expect(script).toContain("if shouldTouchState then")
  })

  test("keeps the provider hash alive for every newly admitted lease", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis, {
      prefix: "test",
      inflightLeaseTtlSeconds: 900,
      stateTtlSeconds: 1_020,
      stateTouchIntervalSeconds: 500,
    })

    await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, hardAffinity: false })

    expect(firstCall(redis).args[10]).toBe(1_020)
    expect(firstCall(redis).args[11]).toBe(60_000)
  })

  test("does not call Redis when no credential is enabled", async () => {
    const redis = new FakeRedis()
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    const disabled = keys.map((credential) => ({ ...credential, enabled: false }))

    await expect(store.reserve({ providerId: "provider", modelId: "model", credentials: disabled, hardAffinity: false }))
      .resolves.toEqual({ ok: false, reason: "capacity", retryAfterSeconds: 1 })
    expect(redis.calls).toHaveLength(0)
  })

  test("looks up response affinity inside the atomic reservation", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["hard-missing"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })

    await expect(store.reserve({
      providerId: "provider",
      modelId: "model",
      credentials: keys,
      sessionKey: "response-session",
      responseId: "resp-1",
      hardAffinity: true,
    })).resolves.toEqual({ ok: false, reason: "hard-response-missing", retryAfterSeconds: 1 })
    expect(firstCall(redis).keys).toContain("test:response:default:provider:resp-1")
    expect(firstCall(redis).script).toContain('redis.call("GET", KEYS[responseIndex])')
  })

  test("shares provider capacity across models while affinity remains model-scoped", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"], ["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.reserve({ providerId: "provider", modelId: "model-a", credentials: keys, sessionKey: "session", hardAffinity: false })
    await store.reserve({ providerId: "provider", modelId: "model-b", credentials: keys, sessionKey: "session", hardAffinity: false })

    expect(redis.calls[0]?.keys[0]).toBe("test:state:default:provider")
    expect(redis.calls[1]?.keys[0]).toBe("test:state:default:provider")
    expect(redis.calls[0]?.keys[1]).toBe("test:affinity:default:provider:model-a:session")
    expect(redis.calls[1]?.keys[1]).toBe("test:affinity:default:provider:model-b:session")
  })

  test("returns retryable capacity and hard-affinity errors", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["capacity", "12"], ["hard-unavailable", "a", "8"])
    const store = new RedisRoutingStateStore(redis)

    await expect(store.reserve({ providerId: "provider", modelId: "model", credentials: keys, hardAffinity: false }))
      .resolves.toEqual({ ok: false, reason: "capacity", retryAfterSeconds: 12 })
    await expect(store.reserve({ providerId: "provider", modelId: "model", credentials: keys, hardAffinity: true, requiredCredentialId: "a" }))
      .resolves.toEqual({ ok: false, reason: "hard-affinity-unavailable", credentialId: "a", retryAfterSeconds: 8 })
  })

  test("includes a compact single-key budget reservation in the same script", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.reserve({
      providerId: "provider",
      modelId: "model",
      credentials: keys,
      hardAffinity: false,
      budget: { key: "test:budget:key", limitMicros: 100, spentMicros: 10, reservationMicros: 20, ttlSeconds: 60 },
    })

    expect(firstCall(redis).keys).toEqual(["test:state:default:provider", "test:budget:key"])
    expect(firstCall(redis).script).toContain("if committed + reservedTotal + reservation > limit")
    expect(firstCall(redis).script).toContain('redis.call("SET", budgetKey')
    expect(firstCall(redis).script).toContain("math.max(storedCommitted, initialSpent)")
  })

  test("releases the exact lease, refunds 429 RPM, and applies cooldown", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.release({ providerId: "provider", credentialId: "a", leaseId: "lease-a", status: 429, retryAfterSeconds: 30 })

    expect(firstCall(redis).keys).toEqual(["test:state:default:provider"])
    expect(firstCall(redis).args).toContain(30)
    expect(firstCall(redis).args).toContain("lease-a")
    expect(firstCall(redis).args).toContain("a")
    expect(firstCall(redis).script).toContain("if status == 429 and targetRpmBucket")
    expect(firstCall(redis).script).toContain("requestedCooldown")
  })

  test("keeps a provider hash alive while a long lease is renewed", async () => {
    const redis = new FakeRedis()
    redis.responses.push(1)
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })

    await expect(store.renew({ providerId: "provider", credentialId: "a", leaseId: "lease-a" })).resolves.toBe(true)

    expect(firstCall(redis).script).toContain('redis.call("HMGET", KEYS[1], credentialId, "_touch")')
    expect(firstCall(redis).script).toContain('redis.call("EXPIRE", KEYS[1], stateTtl)')
    expect(firstCall(redis).args).toHaveLength(6)
  })

  test("uses upstream retry timing for server failures", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis)
    await store.release({ providerId: "provider", credentialId: "a", leaseId: "lease-a", status: 503, retryAfterSeconds: 27 })
    expect(firstCall(redis).args).toContain(27)
  })

  test("settles a budget lease with one Redis key", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.settleBudget({ key: "test:budget:key", leaseId: "lease-a", actualMicros: 7, ttlSeconds: 60 })

    expect(firstCall(redis).keys).toEqual(["test:budget:key"])
    expect(firstCall(redis).script).toContain("committed = math.max(0, committed + actual)")
    expect(firstCall(redis).args.slice(0, 3)).toEqual([7, 60, "lease-a"])
    expect(firstCall(redis).script).toContain('if reserved == nil then return {"already-settled"} end')
  })

  test("settles routing and budget state in one release script", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.release({
      providerId: "provider",
      credentialId: "a",
      leaseId: "lease-a",
      status: 200,
      budget: { key: "test:budget:key", actualMicros: 7, ttlSeconds: 4_321 },
    })

    expect(firstCall(redis).keys).toEqual(["test:state:default:provider", "test:budget:key"])
    expect(firstCall(redis).args.slice(-3)).toEqual([1, 7, 4_321])
    expect(firstCall(redis).script).toContain("if hasBudget then")
  })

  test("maps one response directly and batches multiple mappings in a pipeline", async () => {
    const redis = new FakeRedis()
    const store = new RedisRoutingStateStore(redis, { prefix: "test", responseTtlSeconds: 120 })

    await store.mapResponse("provider", "resp-1", "a")
    await store.mapResponses(["resp-2", "resp-3", "resp-2"], "provider", "a")

    expect(redis.setCalls).toEqual([{ key: "test:response:default:provider:resp-1", value: "a", options: { ex: 120 } }])
    expect(redis.pipelines).toHaveLength(1)
    expect(redis.pipelines[0]?.calls).toEqual([
      { key: "test:response:default:provider:resp-2", value: "a", options: { ex: 120 } },
      { key: "test:response:default:provider:resp-3", value: "a", options: { ex: 120 } },
    ])
    expect(redis.pipelines[0]?.executions).toBe(1)
    expect(redis.calls).toHaveLength(0)
  })

  test("falls back to parallel SETs when a pipeline is unavailable", async () => {
    const redis = new FakeRedis()
    redis.pipelineEnabled = false
    const store = new RedisRoutingStateStore(redis, { prefix: "test", responseTtlSeconds: 120 })
    await store.mapResponses(["resp-1", "resp-2"], "provider", "a")
    expect(redis.setCalls).toHaveLength(2)
  })

  test("bounds response affinity keys before sending them to Redis", async () => {
    const redis = new FakeRedis()
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    const responseIds = Array.from({ length: 70 }, (_, index) => `resp-${index}`)
    responseIds.splice(3, 0, responseIds[0], "x".repeat(513), "")

    await store.mapResponses(responseIds, "provider", "a")

    expect(redis.pipelines[0]?.calls).toHaveLength(64)
    expect(redis.pipelines[0]?.calls.some((call) => call.key.endsWith("x".repeat(513)))).toBe(false)
    expect(new Set(redis.pipelines[0]?.calls.map((call) => call.key)).size).toBe(64)
  })
})
