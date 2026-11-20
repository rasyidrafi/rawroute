import { expect, test } from "bun:test"
import { classifyUpstreamFailure, GatewayRetry } from "../src/server/gateway/retry"

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

test("classifies broad 4xx and 5xx errors as retryable except explicit quota and payment failures", () => {
  expect(classifyUpstreamFailure(400, json({ error: { code: "invalid_request_error", message: "Bad input" } }))).toBe("retryable")
  expect(classifyUpstreamFailure(418, new Uint8Array())).toBe("retryable")
  expect(classifyUpstreamFailure(503, json({ error: { message: "Unavailable" } }))).toBe("retryable")
  expect(classifyUpstreamFailure(402, new Uint8Array())).toBe("quota")
  expect(classifyUpstreamFailure(429, json({ error: { code: "insufficient-quota" } }))).toBe("quota")
  expect(classifyUpstreamFailure(429, json({ error: { message: "Your quota has been exhausted" } }))).toBe("quota")
  expect(classifyUpstreamFailure(429, json({ error: { code: "rate_limit_exceeded", message: "Per-minute usage limit reached. Retry in 1 second." } }))).toBe("retryable")
  expect(classifyUpstreamFailure(429, json({ error: { code: "rate_limit_exceeded", message: "Per-minute quota exceeded. Retry in 1 second." } }))).toBe("retryable")
  expect(classifyUpstreamFailure(429, json({ error: { code: "rate_limit_exceeded", message: "Per-minute quota exceeded. Retry in 1 second." } }))).toBe("retryable")
  expect(classifyUpstreamFailure(429, json({ error: { type: "insufficient_quota" } }))).toBe("quota")
  expect(classifyUpstreamFailure(200, new Uint8Array())).toBe("non-retryable")
})

test("admission delays previously dispatched targets without spinning or blocking other targets", async () => {
  let now = 0
  const retry = new GatewayRetry({ deadlineAt: 10_000, now: () => now, random: () => 0, wait: async ms => { now += ms } })
  retry.dispatched("a")
  retry.failed("a", 503, new Headers())
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  for (const expected of [750, 1250, 2250]) {
    retry.scheduleAdmission("concurrency_limit", undefined, ["a"])
    expect(await retry.nextRound(new AbortController().signal)).toBe(true)
    expect(now).toBe(expected)
  }
  retry.scheduleAdmission("concurrency_limit", undefined, ["a"])
  expect(await retry.nextRound(new AbortController().signal)).toBe(false)
})

test("quota on one target does not suppress a deferred RPM alternative", async () => {
  let now = 0
  const retry = new GatewayRetry({ deadlineAt: 10_000, now: () => now, wait: async ms => { now += ms } })
  retry.dispatched("a")
  retry.failed("a", 402, new Headers(), "quota")
  retry.scheduleAdmission("rpm_limit", 2000, ["b"])
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(now).toBe(2000)
  expect(retry.canDispatch("a")).toBe(false)
  expect(retry.canDispatch("b")).toBe(true)
})

test("defers previously dispatched capacity-blocked targets and preserves independent RPM wakes", async () => {
  let now = 0
  const retry = new GatewayRetry({ deadlineAt: 10_000, now: () => now, random: () => 0, wait: async ms => { now += ms } })
  retry.dispatched("a")
  retry.failed("a", 503, new Headers())
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  for (const elapsed of [750, 1_250, 2_250]) {
    retry.scheduleAdmission("concurrency_limit", undefined, ["a"])
    expect(await retry.nextRound(new AbortController().signal)).toBe(true)
    expect(now).toBe(elapsed)
  }
  retry.scheduleAdmission("concurrency_limit", undefined, ["a"])
  expect(await retry.nextRound(new AbortController().signal)).toBe(false)

  const quota = new GatewayRetry({ deadlineAt: 10_000, now: () => now, wait: async ms => { now += ms } })
  quota.dispatched("a")
  quota.failed("a", 402, new Headers(), "quota")
  quota.scheduleAdmission("rpm_limit", 2_000, ["b"])
  expect(await quota.nextRound(new AbortController().signal)).toBe(true)
  expect(now).toBe(4_250)
  expect(quota.canDispatch("a")).toBe(false)
  expect(quota.canDispatch("b")).toBe(true)
})

test("recognizes Anthropic nested details.error_code and bounds parsing", () => {
  expect(classifyUpstreamFailure(400, json({
    type: "error",
    error: { type: "billing_error", details: { error_code: "usage_limit_reached" } },
  }))).toBe("quota")
  expect(classifyUpstreamFailure(400, "{".repeat(8_193))).toBe("retryable")
  expect(classifyUpstreamFailure(400, new TextEncoder().encode("{".repeat(9_000)))).toBe("retryable")
})

test("coordinator retires classified quota failures but retries other completed 4xx responses", async () => {
  let now = 0
  const retry = new GatewayRetry({ deadlineAt: 10_000, now: () => now, random: () => 0, wait: async (milliseconds) => { now += milliseconds } })
  const quota = retry.key("workspace", "provider", "model", "quota-key")
  retry.dispatched(quota)
  expect(retry.failed(quota, 429, new Headers(), classifyUpstreamFailure(429, json({ error: { code: "insufficient_quota" } })))).toBe(false)
  expect(await retry.nextRound(new AbortController().signal)).toBe(false)

  const ordinary = retry.key("workspace", "provider", "model", "ordinary-key")
  retry.dispatched(ordinary)
  expect(retry.failed(ordinary, 400, new Headers(), classifyUpstreamFailure(400, json({ error: { code: "invalid_request_error" } })))).toBe(true)
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(retry.canDispatch(ordinary)).toBe(true)
})

test("injects time and jitter for deterministic exponential backoff and ignores malformed hints", async () => {
  let now = 0
  const waits: number[] = []
  const retry = new GatewayRetry({
    deadlineAt: 20_000,
    now: () => now,
    random: () => 0.5,
    wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds },
  })
  const key = retry.key("workspace", "provider", "model", "credential")
  retry.dispatched(key)
  expect(retry.failed(key, 503, new Headers({ "retry-after": "nonsense" }))).toBe(true)
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(waits).toEqual([550])

  retry.dispatched(key)
  retry.failed(key, 503, new Headers())
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(waits).toEqual([550, 1_050])
})

test("honors full Retry-After delays and HTTP dates", async () => {
  let now = 1_000
  const waits: number[] = []
  const retry = new GatewayRetry({
    deadlineAt: 250_000,
    now: () => now,
    random: () => 0,
    wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds },
  })
  const key = retry.key("workspace", "provider", "model", "credential")
  retry.dispatched(key)
  retry.failed(key, 503, new Headers({ "retry-after": "120" }))
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(waits).toEqual([120_000])

  retry.dispatched(key)
  retry.failed(key, 503, new Headers({ "retry-after": new Date(now + 10_000).toUTCString() }))
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(waits).toEqual([120_000, 10_000])
})

test("does not interpret fractional numeric Retry-After as an HTTP date", async () => {
  let now = 0
  const retry = new GatewayRetry({ deadlineAt: 10_000, now: () => now, random: () => 0, wait: async (milliseconds) => { now += milliseconds } })
  const key = retry.key("workspace", "provider", "model", "credential")
  retry.dispatched(key)
  retry.failed(key, 503, new Headers({ "retry-after": "2099.5" }))
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(now).toBe(500)
})

test("schedules RPM expiry and at most three concurrency admission polls", async () => {
  let now = 0
  const waits: number[] = []
  const retry = new GatewayRetry({ deadlineAt: 70_000, now: () => now, wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds } })
  retry.scheduleAdmission("rpm_limit", 60_000)
  expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  expect(waits).toEqual([60_000])

  now = 0
  const polls = new GatewayRetry({ deadlineAt: 10_000, now: () => now, wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds } })
  for (const wait of [250, 500, 1_000]) {
    polls.scheduleAdmission("concurrency_limit", undefined)
    expect(await polls.nextRound(new AbortController().signal)).toBe(true)
    expect(waits.at(-1)).toBe(wait)
  }
  polls.scheduleAdmission("concurrency_limit", undefined)
  expect(await polls.nextRound(new AbortController().signal)).toBe(false)

  now = 0
  const mixed = new GatewayRetry({ deadlineAt: 70_000, now: () => now, wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds } })
  for (const wait of [250, 500, 1_000]) {
    mixed.scheduleAdmission("mixed_limits", 60_000)
    expect(await mixed.nextRound(new AbortController().signal)).toBe(true)
    expect(waits.at(-1)).toBe(wait)
  }
  mixed.scheduleAdmission("mixed_limits", 60_000)
  expect(await mixed.nextRound(new AbortController().signal)).toBe(true)
  expect(waits.at(-1)).toBe(58_250)

  now = 0
  const mixedPolls = new GatewayRetry({ deadlineAt: 70_000, now: () => now, wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds } })
  for (const wait of [250, 500, 1_000]) {
    mixedPolls.scheduleAdmission("mixed_limits", 60_000)
    expect(await mixedPolls.nextRound(new AbortController().signal)).toBe(true)
    expect(waits.at(-1)).toBe(wait)
  }
})

test("cancels a scheduled retry wait", async () => {
  const retry = new GatewayRetry({
    deadlineAt: 10_000,
    now: () => 0,
    wait: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
  })
  const key = retry.key("workspace", "provider", "model", "credential")
  retry.dispatched(key)
  retry.failed(key, 503, new Headers())
  const controller = new AbortController()
  const waiting = retry.nextRound(controller.signal)
  controller.abort(new Error("cancel retry"))
  await expect(waiting).rejects.toThrow("cancel retry")
})

test("enforces five dispatches per target, 24 per request, and the deadline", async () => {
  let now = 0
  const retry = new GatewayRetry({
    deadlineAt: 100_000,
    now: () => now,
    random: () => 0,
    wait: async (milliseconds) => { now += milliseconds },
  })
  const key = retry.key("workspace", "provider", "model", "credential")
  for (let dispatch = 1; dispatch <= 5; dispatch++) {
    expect(retry.canDispatch(key)).toBe(true)
    retry.dispatched(key)
    retry.failed(key, 500, new Headers())
    if (dispatch < 5) expect(await retry.nextRound(new AbortController().signal)).toBe(true)
  }
  expect(retry.count).toBe(5)
  expect(await retry.nextRound(new AbortController().signal)).toBe(false)
  expect(retry.canDispatch(key)).toBe(false)

  const requestLimited = new GatewayRetry({ deadlineAt: 10_000, now: () => 0 })
  for (let dispatch = 0; dispatch < 24; dispatch++) {
    expect(requestLimited.canDispatch(`target-${dispatch}`)).toBe(true)
    requestLimited.dispatched(`target-${dispatch}`)
  }
  expect(requestLimited.count).toBe(24)
  expect(requestLimited.canDispatch("target-24")).toBe(false)
  expect(new GatewayRetry({ deadlineAt: 0, now: () => 0 }).canDispatch("first")).toBe(false)
})
