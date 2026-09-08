import { afterAll, expect, test, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { acquireComboCircuit, retryTime, settleComboCircuit } from "@/lib/combo-circuit"
import { closeLocalRedis, getLocalRedis } from "@/lib/local-redis"

test("retry deadlines honor seconds and HTTP dates with bounded exponential fallback", () => {
  const now = 1_800_000_000_000
  expect(retryTime(new Response(null, { headers: { "retry-after": "60" } }), 0, now)).toBe(now + 60_000)
  expect(retryTime(new Response(null, { headers: { "retry-after": new Date(now + 120_000).toUTCString() } }), 0, now)).toBe(now + 120_000)
  expect(retryTime(new Response(), 0, now)).toBe(now + 30_000)
  expect(retryTime(new Response(), 10, now)).toBe(now + 300_000)
})

test.skipIf(!process.env.COMBO_TEST_REDIS_URL)("real Redis coordinates cooldown, concurrent probes, recovery, and stale completions", async () => {
  vi.stubEnv("REDIS_URL", process.env.COMBO_TEST_REDIS_URL!)
  const redis = getLocalRedis()
  if (redis.status !== "ready") await new Promise<void>((resolve, reject) => { redis.once("ready", resolve); redis.once("error", reject) })
  const model = `test-${randomUUID()}`
  const first = await acquireComboCircuit(model)
  const late = await acquireComboCircuit(model)
  try {
    await settleComboCircuit(first, new Response(null, { status: 429, headers: { "retry-after": "600" } }))
    expect((await acquireComboCircuit(model)).allowed).toBe(false)
    await settleComboCircuit(late, new Response())
    expect((await acquireComboCircuit(model)).allowed).toBe(false)
    const state = JSON.parse((await redis.get(first.key))!)
    await redis.set(first.key, JSON.stringify({ ...state, retryAt: Date.now() - 1 }), "PX", 60_000)
    const contenders = await Promise.all(Array.from({ length: 8 }, () => acquireComboCircuit(model)))
    expect(contenders.filter((ticket) => ticket.allowed)).toHaveLength(1)
    const probe = contenders.find((ticket) => ticket.allowed)!
    expect(probe.probe).toBe(true)
    await settleComboCircuit(probe, new Response())
    expect((await acquireComboCircuit(model)).allowed).toBe(true)
    await settleComboCircuit(await acquireComboCircuit(model), new Response(null, { status: 429, headers: { "x-rawroute-combo-terminal": "1" } }))
    expect(await redis.get(first.key)).toBeNull()
  } finally {
    await redis.del(first.key)
    vi.unstubAllEnvs()
  }
})

afterAll(closeLocalRedis)
