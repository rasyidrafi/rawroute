import { describe, expect, test } from "bun:test"
import { testsInWorkspace } from "../../helpers/workspace-test"
const workspaceTest = testsInWorkspace("default")

import {
  CODEX_USAGE_CACHE_TTL_SECONDS,
  getCodexUsageForAccount,
  invalidateCodexUsageCache,
  parseCodexUsagePayload,
  setCodexUsageClockForTests,
  setCodexUsageApiCallForTests,
  setCodexUsageCacheForTests,
  type UsageCache,
} from "../../../packages/gateway-ai/src/server/codex/usage"
import type { ProviderApiKey } from "../../../packages/gateway-ai/src/contracts/domain"

class FakeCache implements UsageCache {
  values = new Map<string, unknown>()

  async del(key: string) { return this.values.delete(key) }

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
  key: "",
  credentialKind: "codex-cli-proxy",
  cliProxyAuthIndex: "auth-index-1",
  enabled: true,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
}

describe("Codex usage", () => {
  workspaceTest("a pre-redemption request cannot repopulate the invalidated quota cache", async () => {
    const cache = new FakeCache()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let delayed = true
    setCodexUsageCacheForTests(cache)
    setCodexUsageApiCallForTests(async (_account, input) => {
      if (input.url.endsWith("/rate-limit-reset-credits")) return { status: 200, body: '{"credits":[]}' }
      if (delayed) { started.resolve(); await finish.promise }
      return { status: 200, body: JSON.stringify({ rate_limit: { secondary_window: { used_percent: delayed ? 100 : 0 } } }) }
    })
    try {
      const old = getCodexUsageForAccount(account)
      await started.promise
      await invalidateCodexUsageCache(account.id, true)
      finish.resolve()
      await old
      expect(cache.values.has("rawroute:codex-usage:v2:default:account-1")).toBe(false)
      delayed = false
      expect(await getCodexUsageForAccount(account)).toMatchObject({ weekly: { remainingPercent: 100 } })
    } finally {
      finish.resolve()
      setCodexUsageCacheForTests()
      setCodexUsageApiCallForTests()
    }
  })

  workspaceTest("polls through delayed quota propagation after redemption without retaining the exhausted snapshot", async () => {
    const cache = new FakeCache()
    let current = 1_000_000
    let usedPercent = 100
    let calls = 0
    let failing = false
    setCodexUsageCacheForTests(cache)
    setCodexUsageClockForTests(() => current)
    setCodexUsageApiCallForTests(async (_account, input) => {
      if (input.url.endsWith("/rate-limit-reset-credits")) return { status: 200, body: '{"credits":[]}' }
      calls++
      if (failing) throw new Error("temporarily unavailable")
      return { status: 200, body: JSON.stringify({ rate_limit: { secondary_window: { used_percent: usedPercent } } }) }
    })
    try {
      expect((await getCodexUsageForAccount(account)).weekly?.remainingPercent).toBe(0)
      await invalidateCodexUsageCache(account.id, true)
      expect(await getCodexUsageForAccount(account)).toMatchObject({ refreshPending: true, weekly: { remainingPercent: 0 } })
      expect(calls).toBe(2)
      current += 2001
      failing = true
      expect(await getCodexUsageForAccount(account)).toMatchObject({ refreshPending: true, stale: true })
      failing = false
      current += 2001
      usedPercent = 0
      const fresh = await getCodexUsageForAccount(account)
      expect(fresh.weekly?.remainingPercent).toBe(100)
      expect(fresh.refreshPending).toBeUndefined()
      expect(fresh.error).toBeUndefined()
      expect(calls).toBe(4)
      current += 2001
      await getCodexUsageForAccount(account)
      expect(calls).toBe(4)
    } finally {
      setCodexUsageCacheForTests()
      setCodexUsageClockForTests()
      setCodexUsageApiCallForTests()
    }
  })

  test("reads the current plan even without quota windows and ignores invalid plans", () => {
    expect(parseCodexUsagePayload({ plan_type: " Free " })).toEqual({ planType: "free", fiveHour: null, weekly: null })
    for (const plan_type of [undefined, null, "", "   ", 42]) {
      expect(parseCodexUsagePayload({ plan_type }).planType).toBeUndefined()
    }
  })

  workspaceTest("refreshes a Plus plan to Free despite old credential metadata", async () => {
    const cache = new FakeCache()
    let current = 1_000_000
    let plan = "plus"
    setCodexUsageCacheForTests(cache)
    setCodexUsageClockForTests(() => current)
    setCodexUsageApiCallForTests(async (_account, input) => ({ status: 200, body: JSON.stringify(input.url.endsWith("/rate-limit-reset-credits") ? { credits: [] } : { plan_type: plan }) }))
    try {
      const oldAccount = { ...account, planType: "plus" }
      expect((await getCodexUsageForAccount(oldAccount)).planType).toBe("plus")
      plan = "free"
      current += CODEX_USAGE_CACHE_TTL_SECONDS * 1000 + 1
      cache.values.delete("rawroute:codex-usage:v2:lock:default:account-1")
      expect(await getCodexUsageForAccount(oldAccount)).toMatchObject({ planType: "free", stale: false, fiveHour: null, weekly: null })
      expect((await getCodexUsageForAccount(oldAccount)).planType).toBe("free")
    } finally {
      setCodexUsageCacheForTests()
      setCodexUsageClockForTests()
      setCodexUsageApiCallForTests()
    }
  })
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

  test("counts reset credits from supported upstream response fields", () => {
    expect(parseCodexUsagePayload({ rate_limit_reset_credits: { available_count: 3, applicable_available_count: 2 } }).unusedResetCredits).toBe(3)
    expect(parseCodexUsagePayload({ rate_limit: { rate_limit_reset_credits: { remaining_count: "2" } } }).unusedResetCredits).toBe(2)
  })

  workspaceTest("bypasses old count-only Cache snapshots so reset-credit details refresh immediately", async () => {
    const cache = new FakeCache()
    const current = 2_000_000
    let usageCalls = 0
    let inventoryCalls = 0
    cache.values.set("rawroute:codex-usage:v1:default:account-1", {
      snapshot: { fiveHour: null, weekly: null, unusedResetCredits: 4 },
      fetchedAt: new Date(current).toISOString(),
      retryAt: current + CODEX_USAGE_CACHE_TTL_SECONDS * 1000,
    })
    setCodexUsageCacheForTests(cache)
    setCodexUsageClockForTests(() => current)
    setCodexUsageApiCallForTests(async (_account, input) => {
      if (input.url.endsWith("/rate-limit-reset-credits")) {
        inventoryCalls += 1
        return { status: 200, body: JSON.stringify({ credits: [{ id: "available-only", status: "available", expires_at: "2030-01-01T00:00:00Z" }] }) }
      }
      usageCalls += 1
      return { status: 200, body: JSON.stringify({ rate_limit_reset_credits: { available_count: 1 } }) }
    })

    const result = await getCodexUsageForAccount(account)

    expect(result.resetCredits).toEqual([{ id: "available-only", status: "available", grantedAt: undefined, expiresAt: "2030-01-01T00:00:00.000Z" }])
    expect(result.resetCreditsError).toBeUndefined()
    expect(result.unusedResetCredits).toBe(1)
    expect(usageCalls).toBe(1)
    expect(inventoryCalls).toBe(1)

    setCodexUsageCacheForTests()
    setCodexUsageClockForTests()
    setCodexUsageApiCallForTests()
  })

  workspaceTest("classifies an unauthorized usage response as requiring reauthorization", async () => {
    const cache = new FakeCache()
    setCodexUsageCacheForTests(cache)
    setCodexUsageApiCallForTests(async () => ({ status: 401, body: JSON.stringify({ error: "token expired" }) }))

    await expect(getCodexUsageForAccount(account)).resolves.toMatchObject({
      stale: false,
      reauthRequired: true,
      error: "Authentication token expired. Reauthorize this Codex account.",
    })

    setCodexUsageCacheForTests()
    setCodexUsageApiCallForTests()
  })

  workspaceTest("serves a cached result for five minutes and retains stale data on failure", async () => {
    const cache = new FakeCache()
    let current = 1_000_000
    let calls = 0
    setCodexUsageCacheForTests(cache)
    setCodexUsageClockForTests(() => current)

    setCodexUsageApiCallForTests(async (_account, input) => {
      if (input.url.endsWith("/rate-limit-reset-credits")) return { status: 200, body: JSON.stringify({ credits: [
        { id: "one", status: "available", expires_at: "2030-01-01T00:00:00.123Z" },
        { id: "two", status: "available", expires_at: null },
        { id: "old", status: "available", expires_at: "1970-01-01T00:00:01Z" },
        { id: "used", status: "redeemed", expires_at: null },
      ] }) }
      calls += 1
      if (calls > 1) throw new Error("upstream unavailable")
      return { status: 200, body: JSON.stringify({ plan_type: "free", rate_limit: { primary_window: { used_percent: 6 }, secondary_window: { used_percent: 20 } }, rate_limit_reset_credits: { available_count: 2 } }) }
    })

    const first = await getCodexUsageForAccount(account)
    const cached = await getCodexUsageForAccount(account)
    expect(first.fiveHour?.remainingPercent).toBe(94)
    expect(first.unusedResetCredits).toBe(2)
    expect(cached.stale).toBe(false)
    expect(cached.unusedResetCredits).toBe(2)
    expect(cached.resetCredits).toEqual(first.resetCredits)
    expect(first.resetCredits?.find((credit) => credit.id === "one")?.expiresAt).toBe("2030-01-01T00:00:00.123Z")
    expect(calls).toBe(1)

    current += CODEX_USAGE_CACHE_TTL_SECONDS * 1000 + 1
    cache.values.delete("rawroute:codex-usage:v2:lock:default:account-1")
    const stale = await getCodexUsageForAccount(account)
    const retained = await getCodexUsageForAccount(account)
    expect(stale).toMatchObject({ stale: true, planType: "free", fiveHour: { remainingPercent: 94 }, unusedResetCredits: 2 })
    expect(retained.stale).toBe(true)
    expect(retained.resetCredits).toEqual(first.resetCredits)
    expect(calls).toBe(2)

    setCodexUsageCacheForTests()
    setCodexUsageClockForTests()
    setCodexUsageApiCallForTests()
  })
})
