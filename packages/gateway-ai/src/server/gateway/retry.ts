const RETRY_WINDOW_MS = 50_000
const MAX_DISPATCHES = 24
const MAX_TARGET_DISPATCHES = 5
const BACKOFF_MS = [500, 1_000, 2_000, 4_000] as const
const CONCURRENCY_POLL_MS = [250, 500, 1_000] as const
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

type Target = { count: number; readyAt: number; retryable: boolean }

export type UpstreamFailureClass = "quota" | "retryable" | "non-retryable"

export type GatewayRetryOptions = {
  /** Absolute deadline, normally captured at gateway HTTP entry. */
  deadlineAt?: number
  /** Injectable clock and jitter source for deterministic policy tests. */
  now?: () => number
  random?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

/** Classifies only bounded provider error bodies; opaque errors use their status. */
export function classifyUpstreamFailure(status: number, body: Uint8Array | string): UpstreamFailureClass {
  if (status === 402) return "quota"
  if (status < 400 || status > 599) return "non-retryable"

  let payload: unknown
  try {
    if (typeof body === "string" ? body.length > 8_192 : body.byteLength > 8_192) return "retryable"
    const text = typeof body === "string" ? body : new TextDecoder().decode(body)
    payload = JSON.parse(text) as unknown
  } catch { return "retryable" }

  const quotaCodes = new Set([
    "payment_required",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "enforced_spend_limit_reached",
    "insufficient_quota",
    "quota_exceeded",
    "usage_limit_reached",
    "billing_hard_limit_reached",
    "credit_balance_too_low",
    "billing_not_active",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "enforced_spend_limit_reached",
  ])
  const quotaMessages = [
    "payment required",
    "insufficient quota",
    "quota exhausted",
    "quota has been exhausted",
    "quota is exhausted",
    "quota is depleted",
    "exceeded your current quota",
    "billing hard limit reached",
    "billing hard limit has been reached",
    "credit balance too low",
    "credit balance is too low",
    "out of credits",
  ]
  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > 5 || !value || typeof value !== "object" || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    for (const field of ["code", "error_code", "type"]) {
      const code = record[field]
      if (typeof code === "string" && quotaCodes.has(code.trim().toLowerCase().replaceAll(/[-:]/g, "_"))) return true
    }
    const message = typeof record.message === "string" ? record.message.toLowerCase() : ""
    if (quotaMessages.some((phrase) => message.includes(phrase)) || /(?:^|[.!?]\s)(?:your )?usage limit reached(?:[.!?]|$)/.test(message)) return true
    return inspect(record.error, depth + 1) || inspect(record.details, depth + 1)
  }
  return inspect(payload, 0) ? "quota" : "retryable"
}

/** Request-local dispatch limits. The deadline limits retries, not a successful stream. */
export class GatewayRetry {
  private readonly deadline: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly targets = new Map<string, Target>()
  private dispatches = 0
  private pinned: string | undefined
  private pinnedMember: number | undefined
  private lastFailure: Response | undefined
  private rpmWakeAt: number | undefined
  private concurrencyPolls = 0
  private concurrencyBlocked = false
  private readonly admissionBlockedTargets = new Set<string>()
  private stopReasonValue = "no_retryable_targets"
  private failureWasQuota = false
  private admissionWakeAt: number | undefined
  round = 0
  private readonly blocked = new Set<string>()

  constructor(options: GatewayRetryOptions = {}) {
    this.now = options.now || Date.now
    this.random = options.random || Math.random
    this.wait = options.wait || ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, milliseconds)
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    }))
    this.deadline = options.deadlineAt ?? this.now() + RETRY_WINDOW_MS
  }

  static defaultDeadlineAt(startedAt = Date.now()) { return startedAt + RETRY_WINDOW_MS }

  get count() { return this.dispatches }
  rememberFailure(response: Response) { this.lastFailure = response }
  quotaFailure() { return this.failureWasQuota }
  previousFailure() { return this.lastFailure?.clone() }

  key(owner: string, provider: string, model: string, credential: string) {
    return JSON.stringify([owner, provider, model, credential])
  }

  canDispatch(key: string) {
    const target = this.targets.get(key)
    if (this.pinned && this.pinned !== key) return false
    if (this.dispatches >= MAX_DISPATCHES || this.now() >= this.deadline) return false
    if (!target) return true
    return this.round > 0 && target.retryable && !this.blocked.has(key) && target.count < MAX_TARGET_DISPATCHES && target.readyAt <= this.now()
  }

  dispatched(key: string) {
    const target = this.targets.get(key)
    this.targets.set(key, { count: (target?.count || 0) + 1, readyAt: 0, retryable: false })
    this.dispatches++
  }

  block(key: string) { this.blocked.add(key) }

  pin(key: string) { this.pinned = key }

  get isPinned() { return this.pinned !== undefined }
  useMember(index: number) { return this.pinnedMember === undefined || this.pinnedMember === index }
  rememberMember(index: number) { if (this.isPinned && this.pinnedMember === undefined) this.pinnedMember = index }

  readyTargets() {
    return [...this.targets.entries()].filter(([key, target]) => !this.blocked.has(key) && target.retryable && target.readyAt <= this.now()).map(([key]) => key)
  }

  retireReady(keys: string[]) {
    for (const key of keys) this.blocked.add(key)
  }

  withinDeadline() { return this.now() < this.deadline }

  stopReason() { return this.stopReasonValue }

  scheduleAdmission(reason: "rpm_limit" | "concurrency_limit" | "mixed_limits", retryAfterMs: number | undefined, targetKeys: string[] = []) {
    const now = this.now()
    for (const key of targetKeys) this.admissionBlockedTargets.add(key)
    if ((reason === "rpm_limit" || reason === "mixed_limits") && retryAfterMs !== undefined && retryAfterMs >= 0) {
      const wakeAt = now + retryAfterMs
      this.rpmWakeAt = Math.min(this.rpmWakeAt ?? Number.POSITIVE_INFINITY, wakeAt)
    }
    if (reason === "rpm_limit") for (const key of targetKeys) {
      const target = this.targets.get(key)
      if (target) target.readyAt = Math.max(target.readyAt, this.rpmWakeAt ?? now)
    }
    else this.concurrencyBlocked = true
  }

  failed(key: string, status: number, headers: Headers, failureClass?: UpstreamFailureClass) {
    const target = this.targets.get(key)
    if (!target) return false
    target.retryable = failureClass
      ? failureClass === "retryable"
      : status !== 402 && status >= 400 && status <= 599
    if (!target.retryable && failureClass === "quota") { this.stopReasonValue = "quota_exhausted"; this.failureWasQuota = true }
    if (target.retryable) this.failureWasQuota = false
    if (!target.retryable && failureClass === "non-retryable") this.stopReasonValue = "non_retryable_failure"
    const raw = headers.get("retry-after")?.trim()
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : undefined
    const httpDate = raw && seconds === undefined && (
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)
      || /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(raw)
      || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(raw)
    )
    const parsedDate = httpDate ? Date.parse(raw!) : NaN
    const weekday = raw?.match(/^([A-Za-z]+)[, ]/)?.[1]
    const parsedWeekday = Number.isFinite(parsedDate) ? new Date(parsedDate).getUTCDay() : -1
    const date = Number.isFinite(parsedDate) && (weekday === WEEKDAYS[parsedWeekday] || weekday === LONG_WEEKDAYS[parsedWeekday]) ? parsedDate : NaN
    const requestedDelay = seconds !== undefined && !Number.isNaN(seconds)
      ? Math.min(Number.MAX_VALUE - this.now(), seconds * 1_000)
      : Number.isFinite(date) ? Math.max(0, date - this.now()) : 0
    const delay = Number.isFinite(requestedDelay) ? requestedDelay : Number.MAX_VALUE - this.now()
    const backoff = BACKOFF_MS[Math.min(target.count - 1, BACKOFF_MS.length - 1)]! + this.random() * 100
    target.readyAt = this.now() + Math.max(delay, backoff)
    return target.retryable
  }

  async nextRound(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason
    if (!this.withinDeadline()) { this.stopReasonValue = "deadline"; return false }
    if (this.dispatches >= MAX_DISPATCHES) { this.stopReasonValue = "dispatch_limit"; return false }
    if (this.failureWasQuota && ![...this.targets.values()].some((target) => target.retryable) && !this.concurrencyBlocked && this.rpmWakeAt === undefined) { this.stopReasonValue = "quota_exhausted"; return false }
    let pollAt: number | undefined
    if (this.concurrencyBlocked) {
      if (this.concurrencyPolls < CONCURRENCY_POLL_MS.length) {
        this.concurrencyPolls++
        pollAt = this.now() + CONCURRENCY_POLL_MS[this.concurrencyPolls - 1]!
        const deferUntil = Math.min(pollAt, this.rpmWakeAt ?? Number.POSITIVE_INFINITY)
        for (const key of this.admissionBlockedTargets) {
          const target = this.targets.get(key)
          if (target) target.readyAt = Math.max(target.readyAt, deferUntil)
        }
      } else if (this.rpmWakeAt !== undefined && this.rpmWakeAt > this.now()) {
        for (const key of this.admissionBlockedTargets) {
          const target = this.targets.get(key)
          if (target) target.readyAt = Math.max(target.readyAt, this.rpmWakeAt)
        }
      } else {
        for (const key of this.admissionBlockedTargets) {
          const target = this.targets.get(key)
          if (target) target.retryable = false
          this.blocked.add(key)
        }
      }
    }
    this.concurrencyBlocked = false
    this.admissionBlockedTargets.clear()
    const candidates = [...this.targets.entries()].filter(([key, target]) => (!this.pinned || this.pinned === key) && !this.blocked.has(key) && target.retryable && target.count < MAX_TARGET_DISPATCHES).map(([, target]) => target.readyAt)
    if (pollAt !== undefined) candidates.push(pollAt)
    if (this.rpmWakeAt !== undefined) candidates.push(this.rpmWakeAt)
    if (!candidates.length) {
      this.stopReasonValue = "no_retryable_targets"
      return false
    }
    const wakeAt = Math.min(...candidates)
    const wait = Math.ceil(Math.max(0, wakeAt - this.now()))
    if (this.now() + wait >= this.deadline) { this.stopReasonValue = "deadline"; return false }
    if (wait) await this.wait(wait, signal)
    if (this.rpmWakeAt !== undefined && this.rpmWakeAt <= this.now()) this.rpmWakeAt = undefined
    this.round++
    if (this.now() >= this.deadline) { this.stopReasonValue = "deadline"; return false }
    return !signal.aborted
  }

}
