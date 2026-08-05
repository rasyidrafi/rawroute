import { describe, expect, test } from "vitest"

import { RedisRoutingStateStore, type RoutingRedis } from "@/lib/routing-state"
import type { ProviderApiKey } from "@/lib/types"

class FakeRedis implements RoutingRedis {
  readonly calls: Array<{ script: string; keys: string[]; args: Array<string | number> }> = []
  responses: unknown[] = []

  async eval(script: string, keys: string[], args: Array<string | number>) {
    this.calls.push({ script, keys, args })
    return this.responses.shift()
  }

  async get() { return null }
  async set() { return "OK" }
}

const keys: ProviderApiKey[] = [
  { id: "a", providerId: "provider", name: "A", key: "a", enabled: true, rpmLimit: 10, maxConcurrency: 2, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", providerId: "provider", name: "B", key: "b", enabled: true, rpmLimit: 10, maxConcurrency: 2, createdAt: "2026-01-01T00:00:00.000Z" },
]

describe("Redis routing state", () => {
  test("atomically reserves and pins the least-loaded credential", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "b", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test", affinityTtlSeconds: 3600 })

    const result = await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, sessionKey: "session", hardAffinity: false })

    expect(result).toMatchObject({ ok: true, credentialId: "b", affinity: "new" })
    if (result.ok) expect(typeof result.leaseId).toBe("string")
    expect(redis.calls[0]?.keys).toContain("test:affinity:provider:model:session")
    expect(redis.calls[0]?.args.join(" ")).toContain("10")
  })

  test("looks up response affinity inside the reservation script", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["hard-missing"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })

    expect(await store.reserve({
      providerId: "provider",
      modelId: "model",
      credentials: keys,
      sessionKey: "response-session",
      responseId: "resp-1",
      hardAffinity: true,
    })).toEqual({ ok: false, reason: "hard-response-missing", retryAfterSeconds: 1 })
    expect(redis.calls[0]?.keys[1]).toBe("test:response:provider:resp-1")
    expect(redis.calls[0]?.script).toContain('redis.call("TIME")')
  })

  test("tracks concurrency as independently expiring leases", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis)
    await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, sessionKey: "lease-test", hardAffinity: false })

    const script = redis.calls[0]?.script || ""
    expect(script).toContain('ZREMRANGEBYSCORE", KEYS[keyOffset + 1]')
    expect(script).toContain('ZADD", KEYS[keyOffset + 1]')
    expect(script).not.toContain('INCR", KEYS[keyOffset + 1]')
  })

  test("returns a retryable capacity error instead of using process-local fallback", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["capacity", "12"])
    const store = new RedisRoutingStateStore(redis)
    expect(await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, sessionKey: "new", hardAffinity: false }))
      .toEqual({ ok: false, reason: "capacity", retryAfterSeconds: 12 })
  })

  test("protects hard affinity when its credential is unavailable", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["hard-unavailable", "a", "8"])
    const store = new RedisRoutingStateStore(redis)
    expect(await store.reserve({ providerId: "provider", modelId: "model", credentials: keys, sessionKey: "hard", hardAffinity: true, requiredCredentialId: "a" }))
      .toEqual({ ok: false, reason: "hard-affinity-unavailable", credentialId: "a", retryAfterSeconds: 8 })
  })

  test("includes budget admission in the atomic routing script", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok", "a", "new"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    const result = await store.reserve({
      providerId: "provider", modelId: "model", credentials: keys, hardAffinity: false,
      budget: { key: "test:budget:key", limitMicros: 100, spentMicros: 10, reservationMicros: 20, ttlSeconds: 60 },
    })
    expect(result).toMatchObject({ ok: true, budget: { reservationMicros: 20 } })
    expect(redis.calls[0]?.keys).toContain("test:budget:key")
    expect(redis.calls[0]?.script).toContain("current + reservation > limit")
  })

  test("releases concurrency and cools down only the rate-limited credential", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis)
    await store.release({ providerId: "provider", modelId: "model", credentialId: "a", leaseId: "lease-a", status: 429, retryAfterSeconds: 30 })
    expect(redis.calls[0]?.keys.join(" ")).toContain("provider:model:a")
    expect(redis.calls[0]?.args).toContain(30)
    expect(redis.calls[0]?.script).toContain('ZREM", KEYS[1], ARGV[4]')
  })

  test("uses upstream retry timing for server failures too", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis)
    await store.release({ providerId: "provider", modelId: "model", credentialId: "a", leaseId: "lease-a", status: 503, retryAfterSeconds: 27 })
    expect(redis.calls[0]?.args).toContain(27)
    expect(redis.calls[0]?.script).toContain('tostring(status), "EX", tonumber(ARGV[2])')
  })

  test("settles an atomic budget reservation with exact cost", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.settleBudget({ key: "test:budget:key", leaseId: "lease-a", actualMicros: 7, ttlSeconds: 60 })
    expect(redis.calls[0]?.keys).toEqual(["test:budget:key", "test:budget:key:lease:lease-a"])
    expect(redis.calls[0]?.args).toEqual([7, 60])
  })

  test("uses the budget window TTL when releasing an authenticated route", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    await store.release({
      providerId: "provider",
      modelId: "model",
      credentialId: "a",
      leaseId: "lease-a",
      status: 200,
      budget: { key: "test:budget:key", reservationMicros: 1, actualMicros: 7, ttlSeconds: 4_321 },
    })
    expect(redis.calls[0]?.keys).toEqual([
      "test:inflight:provider:model:a",
      "test:rpm:provider:model:a",
      "test:cooldown:provider:model:a",
      "test:budget:key",
      "test:budget:key:lease:lease-a",
    ])
    expect(redis.calls[0]?.args.slice(-2)).toEqual([7, 4_321])
  })

  test("maps multiple response IDs in one Redis script", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test", responseTtlSeconds: 120 })
    await store.mapResponses(["resp-1", "resp-2", "resp-1"], "provider", "a")
    expect(redis.calls[0]?.keys).toEqual(["test:response:provider:resp-1", "test:response:provider:resp-2"])
    expect(redis.calls[0]?.args).toEqual([120, "a"])
    expect(redis.calls[0]?.script).toContain('for index = 1, #KEYS do')
  })

  test("bounds response affinity keys before sending them to Redis", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis, { prefix: "test" })
    const responseIds = Array.from({ length: 70 }, (_, index) => `resp-${index}`)
    responseIds.splice(3, 0, responseIds[0], "x".repeat(513), "")

    await store.mapResponses(responseIds, "provider", "a")

    expect(redis.calls[0]?.keys).toHaveLength(64)
    expect(redis.calls[0]?.keys).not.toContain(`test:response:provider:${"x".repeat(513)}`)
    expect(new Set(redis.calls[0]?.keys).size).toBe(64)
  })
})
