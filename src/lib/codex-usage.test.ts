import { describe, expect, test } from "bun:test"

import {
  CODEX_USAGE_CACHE_TTL_SECONDS,
  getCodexUsageForAccount,
  parseCodexUsagePayload,
  setCodexUsageClockForTests,
  setCodexUsageRedisForTests,
  type UsageRedis,
} from "@/lib/codex-usage"
import type { ProviderApiKey } from "@/lib/types"

class FakeRedis implements UsageRedis {
  values = new Map<string, unknown>()

  async get<T>(key: string) {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async set<T>(key: string, value: T, options?: { nx?: boolean }) {
    if (options?.nx && this.values.has(key)) return null
    this.values.set(key, value)
    return "OK"
  }
}

const account: ProviderApiKey = {
  id: "account-1",
  providerId: "codex",
  name: "Codex",
  key: "access-token",
  credentialKind: "codex-oauth",
  enabled: true,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
}

describe("Codex usage", () => {
  test("parses five-hour and weekly windows from the 9router response shape", () => {
    const result = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 6, reset_at: 1_800_000_000 },
        secondary_window: { percent_used: "6" },
      },
    })

    expect(result.fiveHour).toMatchObject({ usedPercent: 6, remainingPercent: 94 })
    expect(result.fiveHour?.resetAt).toBe("2027-01-15T08:00:00.000Z")
    expect(result.weekly).toMatchObject({ usedPercent: 6, remainingPercent: 94 })
  })

  test("returns unavailable windows instead of inventing zero usage", () => {
    expect(parseCodexUsagePayload({ rate_limit: { primary_window: null, secondary_window: {} } })).toEqual({ fiveHour: null, weekly: null })
  })

  test("shows the available weekly window when OpenAI omits the five-hour window", () => {
    expect(parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: null },
        secondary_window: { used_percent: 8, limit_window_seconds: 604800 },
      },
    })).toEqual({
      fiveHour: null,
      weekly: { usedPercent: 8, remainingPercent: 92 },
    })
  })

  test("uses the reported duration when OpenAI moves a window between fields", () => {
    expect(parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 8, limit_window_seconds: 604800 },
        secondary_window: null,
      },
    })).toEqual({
      fiveHour: null,
      weekly: { usedPercent: 8, remainingPercent: 92 },
    })
  })

  test("serves a cached result for five minutes and retains stale data on failure", async () => {
    const redis = new FakeRedis()
    let current = 1_000_000
    let calls = 0
    setCodexUsageRedisForTests(redis)
    setCodexUsageClockForTests(() => current)

    const fetchImpl = (async () => {
      calls += 1
      if (calls > 1) throw new Error("upstream unavailable")
      return Response.json({ rate_limit: { primary_window: { used_percent: 6 }, secondary_window: { used_percent: 20 } } })
    }) as unknown as typeof fetch

    const first = await getCodexUsageForAccount(account, fetchImpl)
    const cached = await getCodexUsageForAccount(account, fetchImpl)
    expect(first.fiveHour?.remainingPercent).toBe(94)
    expect(cached.stale).toBe(false)
    expect(calls).toBe(1)

    current += CODEX_USAGE_CACHE_TTL_SECONDS * 1000 + 1
    redis.values.delete("rawroute:codex-usage:v1:lock:account-1")
    const stale = await getCodexUsageForAccount(account, fetchImpl)
    const retained = await getCodexUsageForAccount(account, fetchImpl)
    expect(stale).toMatchObject({ stale: true, fiveHour: { remainingPercent: 94 } })
    expect(retained.stale).toBe(true)
    expect(calls).toBe(2)

    setCodexUsageRedisForTests()
    setCodexUsageClockForTests()
  })
})
