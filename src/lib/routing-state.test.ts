import { describe, expect, test } from "bun:test"

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
    if (result.ok) expect(result.leaseId).toBeString()
    expect(redis.calls[0]?.keys).toContain("test:affinity:provider:model:session")
    expect(redis.calls[0]?.args.join(" ")).toContain("10")
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

  test("releases concurrency and cools down only the rate-limited credential", async () => {
    const redis = new FakeRedis()
    redis.responses.push(["ok"])
    const store = new RedisRoutingStateStore(redis)
    await store.release({ providerId: "provider", modelId: "model", credentialId: "a", leaseId: "lease-a", status: 429, retryAfterSeconds: 30, latencyMs: 100 })
    expect(redis.calls[0]?.keys.join(" ")).toContain("provider:model:a")
    expect(redis.calls[0]?.args).toContain(30)
    expect(redis.calls[0]?.script).toContain('ZREM", KEYS[1], ARGV[4]')
  })
})
