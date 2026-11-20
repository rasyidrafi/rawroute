import { expect, test } from "bun:test"
import { classifyUpstreamFailure, GatewayRetry } from "../src/server/gateway/retry"

function clock(inputTokens = 0, random = 0) {
  let now = 0
  const waits: number[] = []
  const retry = new GatewayRetry({ inputTokens, now: () => now, random: () => random, wait: async ms => { waits.push(ms); now += ms } })
  return { retry, waits, time: () => now }
}
const signal = () => new AbortController().signal
const fail = (retry: GatewayRetry, key: string, hint?: string) => {
  retry.dispatched(key)
  expect(retry.failed(key, 402, new Headers(hint === undefined ? {} : { "retry-after": hint }), "quota")).toBe(true)
}

test("classification remains available for response shaping", () => {
  expect(classifyUpstreamFailure(402, "")).toBe("quota")
  expect(classifyUpstreamFailure(400, "{}")).toBe("retryable")
  expect(classifyUpstreamFailure(307, "")).toBe("non-retryable")
})

test("first failure probes on normal backoff, second respects seconds and HTTP dates", async () => {
  const { retry, waits } = clock()
  fail(retry, "a", "10")
  expect(await retry.nextRound(signal())).toBe(true)
  fail(retry, "a", new Date(10_500).toUTCString())
  expect(await retry.nextRound(signal())).toBe(true)
  expect(waits).toEqual([500, 9_500])
  fail(retry, "a", "3")
  await retry.nextRound(signal())
  expect(waits.at(-1)).toBe(3_000)
})

test.each([undefined, "0", "nonsense", "2099.5", new Date(0).toUTCString()])("invalid or elapsed hint %s retains backoff floor", async hint => {
  const { retry, waits } = clock(0, 0.5)
  fail(retry, "a", hint)
  await retry.nextRound(signal())
  fail(retry, "a", hint)
  await retry.nextRound(signal())
  expect(waits).toEqual([550, 1_050])
})

test("context threshold selects preferential probe and patience", async () => {
  for (const [tokens, preferred, secondWait] of [[79_999, undefined, 15_000], [80_000, "a", 30_000]] as const) {
    const { retry, waits } = clock(tokens)
    fail(retry, "a", "30")
    expect(retry.preferredProbe(["a", "b"])).toBe(preferred)
    await retry.nextRound(signal())
    fail(retry, "a", "30")
    await retry.nextRound(signal())
    expect(waits).toEqual([500, secondWait])
  }
})

test("inverted jitter does not invert actual dispatch order", async () => {
  let now = 0
  let calls = 0
  const retry = new GatewayRetry({ now: () => now, random: () => calls++ % 2 === 0 ? 0.99 : 0, wait: async ms => { now += ms } })
  const wire: string[] = []
  for (let i = 0; i < 8; i++) {
    let key = retry.orderedTargets(["a", "b"]).find(candidate => retry.canDispatch(candidate))
    if (!key) {
      expect(await retry.nextRound(signal())).toBe(true)
      key = retry.orderedTargets(["a", "b"]).find(candidate => retry.canDispatch(candidate))
    }
    expect(key).toBeDefined()
    wire.push(key!)
    fail(retry, key!)
  }
  expect(wire).toEqual(["a", "b", "a", "b", "a", "b", "a", "b"])
})

test("preference waits permit dispatch, yield to admission, and distinguish hint patience", async () => {
  const { retry, waits } = clock(80_000)
  fail(retry, "a", "30")
  expect(retry.preferredProbe(["a", "b"])).toBe("a")
  expect(await retry.waitForProbe("a", signal(), ["a", "b"])).toBe(true)
  expect(retry.canDispatch("a")).toBe(true)
  fail(retry, "a", "30")
  expect(retry.preferredProbe(["a", "b"])).toBe("a")
  expect(await retry.waitForProbe("a", signal(), ["a", "b"])).toBe(true)
  expect(retry.canDispatch("a")).toBe(true)
  expect(waits).toEqual([500, 30_000])
  fail(retry, "a", "61")
  expect(retry.preferredProbe(["a", "b"])).toBeUndefined()
  expect(retry.canDispatch("b")).toBe(true)
  retry.scheduleAdmission("rpm_limit", 1_000, ["a"])
  expect(retry.preferredProbe(["a", "b"])).toBeUndefined()
})

test("same over-patience hint waits for sole target but yields to an alternate", async () => {
  const { retry, waits } = clock(79_999)
  fail(retry, "a", "30"); await retry.nextRound(signal())
  fail(retry, "a", "30")
  expect(retry.preferredProbe(["a", "b"])).toBeUndefined()
  expect(retry.canDispatch("b")).toBe(true)
  await retry.nextRound(signal())
  expect(waits).toEqual([500, 15_000])
})

test("short context does not prefer a cheap second hint over a ready alternate", async () => {
  const { retry, waits } = clock(79_999)
  fail(retry, "a", "5")
  await retry.nextRound(signal())
  fail(retry, "a", "5")
  expect(retry.preferredProbe(["a", "b"])).toBeUndefined()
  expect(retry.canDispatch("b")).toBe(true)
  fail(retry, "b")
  expect(waits).toEqual([500])
})

test("mixed hinted and ordinary cooldowns debit against the hint-free cursor successor", async () => {
  let now = 0
  const waits: number[] = []
  const retry = new GatewayRetry({ inputTokens: 80_000, now: () => now, random: () => 0, wait: async ms => { waits.push(ms); now += ms } })
  fail(retry, "a", "60")
  fail(retry, "b")
  await retry.nextRound(signal())
  fail(retry, "a", "60")
  now += 1_000
  fail(retry, "b")
  await retry.nextRound(signal())
  expect(waits.at(-1)).toBe(1_000)
  // B's backoff is 1s while A was already normal-ready; expose the debit.
  retry.block("b")
  for (let i = 0; i < 3; i++) { fail(retry, "a", "60"); await retry.nextRound(signal()) }
  expect(waits.at(-1)).toBe(9_000)
})

test("probe wait charges only time holding a ready alternate", async () => {
  for (const [keys, expectedLast] of [[ ["a"], 7_000 ], [ ["a", "b"], 6_500 ]] as const) {
    const { retry, waits } = clock(80_000)
    fail(retry, "a", "60")
    expect(await retry.waitForProbe("a", signal(), [...keys])).toBe(true)
    for (let i = 0; i < 3; i++) { fail(retry, "a", "60"); await retry.nextRound(signal()) }
    expect(waits.at(-1)).toBe(expectedLast)
  }
})

test("elapsed local admission does not consume allowance or erase a hint", async () => {
  const { retry, waits } = clock(80_000)
  fail(retry, "a", "60"); await retry.nextRound(signal())
  fail(retry, "a", "60")
  retry.scheduleAdmission("rpm_limit", 30_000, ["a"])
  await retry.nextRound(signal())
  expect(retry.canDispatch("a")).toBe(false)
  await retry.nextRound(signal())
  expect(waits).toEqual([500, 30_000, 30_000])
  for (let i = 0; i < 2; i++) { fail(retry, "a", "60"); await retry.nextRound(signal()) }
  expect(waits.at(-1)).toBe(36_000)
})

test("elapsed dispatch time preserves allowance and remaining hint cooldown", async () => {
  let now = 0
  const waits: number[] = []
  const retry = new GatewayRetry({ inputTokens: 80_000, now: () => now, random: () => 0, wait: async ms => { waits.push(ms); now += ms } })
  fail(retry, "a", "60"); await retry.nextRound(signal())
  fail(retry, "a", "60")
  now += 30_000
  expect(retry.canDispatch("a")).toBe(false)
  await retry.nextRound(signal())
  expect(waits).toEqual([500, 30_000])
  for (let i = 0; i < 2; i++) { fail(retry, "a", "60"); await retry.nextRound(signal()) }
  expect(waits.at(-1)).toBe(36_000)
})

test("allowance is clamped before sleep and exhausted allowance falls back to normal pacing", async () => {
  const { retry, waits } = clock(80_000)
  fail(retry, "a", "60")
  await retry.nextRound(signal())
  for (let i = 0; i < 3; i++) { fail(retry, "a", "60"); await retry.nextRound(signal()) }
  expect(waits).toEqual([500, 60_000, 60_000, 7_000])
  fail(retry, "a", "60")
  await retry.nextRound(signal())
  expect(waits.at(-1)).toBe(4_000)
})

test("overlapping cooldowns debit one sleep and rotation follows dispatch order", async () => {
  const { retry, waits } = clock(80_000)
  fail(retry, "a", "10"); fail(retry, "b", "10")
  expect(retry.orderedTargets(["a", "b", "c"])).toEqual(["c", "a", "b"])
  await retry.nextRound(signal())
  fail(retry, "a", "10"); fail(retry, "b", "10")
  await retry.nextRound(signal())
  expect(waits).toEqual([500, 10_000])
})

test("RPM overlap does not spend extra hint allowance and wakes are bounded", async () => {
  const { retry, waits } = clock(80_000)
  fail(retry, "a", "10"); await retry.nextRound(signal())
  fail(retry, "a", "10")
  retry.scheduleAdmission("rpm_limit", 5_000, ["a"])
  expect(await retry.nextRound(signal())).toBe(true)
  expect(waits).toEqual([500, 5_000])
  retry.scheduleAdmission("rpm_limit", 5_000, ["a"])
  expect(await retry.nextRound(signal())).toBe(false)
  retry.dispatched("a")
  retry.scheduleAdmission("rpm_limit", 2_000, ["a"])
  expect(await retry.nextRound(signal())).toBe(true)
})

test("concurrency polls are request-wide and exhaust without progress", async () => {
  const { retry, waits } = clock()
  for (let i = 0; i < 3; i++) {
    retry.scheduleAdmission("concurrency_limit", undefined)
    expect(await retry.nextRound(signal())).toBe(true)
  }
  retry.scheduleAdmission("concurrency_limit", undefined)
  expect(await retry.nextRound(signal())).toBe(false)
  expect(waits).toEqual([250, 500, 1_000])
})

test("24 dispatches stop without another sleep or dispatch", async () => {
  const { retry, waits } = clock()
  for (let i = 0; i < 24; i++) {
    expect(retry.canDispatch("a")).toBe(true)
    fail(retry, "a")
    if (i < 23) expect(await retry.nextRound(signal())).toBe(true)
  }
  expect(await retry.nextRound(signal())).toBe(false)
  expect(retry.stopReason()).toBe("dispatch_limit")
  expect(retry.canDispatch("a")).toBe(false)
  expect(waits).toHaveLength(23)
})

test("abort cancels a scheduled wait", async () => {
  const retry = new GatewayRetry({ now: () => 0, wait: (_ms, s) => new Promise<void>((_resolve, reject) => { s.addEventListener("abort", () => reject(s.reason), { once: true }) }) })
  fail(retry, "a")
  const controller = new AbortController()
  const waiting = retry.nextRound(controller.signal)
  controller.abort(new Error("cancel retry"))
  await expect(waiting).rejects.toThrow("cancel retry")
})
