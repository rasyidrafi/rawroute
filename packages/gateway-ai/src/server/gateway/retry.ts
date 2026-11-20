const MAX_DISPATCHES = 24
const BACKOFF_MS = [500, 1_000, 2_000, 4_000] as const
const CONCURRENCY_POLL_MS = [250, 500, 1_000] as const
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

type Target = { count: number; normalAt: number; hintAt: number; hintDelay: number; patience: number; probePending: boolean }

export type UpstreamFailureClass = "quota" | "retryable" | "non-retryable"

export type GatewayRetryOptions = {
  inputTokens?: number
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

/** Request-local retry and admission pacing. */
export class GatewayRetry {
  private readonly now: () => number
  private readonly random: () => number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly targets = new Map<string, Target>()
  private dispatches = 0
  private cursor: string | undefined
  private wakeTarget: string | undefined
  private inputTokens: number
  private allowance = 120_000
  private pinned: string | undefined
  private pinnedMember: number | undefined
  private lastFailure: Response | undefined
  private rpmWakeAt: number | undefined
  private rpmWakeUsed = false
  private concurrencyPolls = 0
  private concurrencyBlocked = false
  private readonly admissionBlockedTargets = new Set<string>()
  private stopReasonValue = "no_retryable_targets"
  round = 0
  private readonly blocked = new Set<string>()

  constructor(options: GatewayRetryOptions = {}) {
    this.now = options.now || Date.now
    this.random = options.random || Math.random
    this.inputTokens = options.inputTokens ?? 0
    this.wait = options.wait || ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, milliseconds)
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    }))
  }

  get count() { return this.dispatches }
  rememberFailure(response: Response) { this.lastFailure = response }
  previousFailure() { return this.lastFailure?.clone() }
  setInputTokens(inputTokens: number) { this.inputTokens = inputTokens }
  key(owner: string, provider: string, model: string, credential: string) {
    return JSON.stringify([owner, provider, model, credential])
  }

  private readyAt(target: Target) {
    if (target.count < 2 || this.allowance <= 0) return target.normalAt
    return Math.max(target.normalAt, Math.min(target.hintAt, target.hintAt - target.hintDelay + target.patience))
  }

  canDispatch(key: string) {
    if (this.pinned && this.pinned !== key) return false
    if (this.dispatches >= MAX_DISPATCHES || this.blocked.has(key) || this.admissionBlockedTargets.has(key)) return false
    const target = this.targets.get(key)
    if (!target) return true
    if (this.round === 0 || target.normalAt > this.now()) return false
    if (this.wakeTarget === key) return true
    const successor = this.orderedTargets([...this.targets.keys()]).find(candidate => {
      const item = this.targets.get(candidate)!
      return (!this.pinned || this.pinned === candidate) && !this.blocked.has(candidate) && !this.admissionBlockedTargets.has(candidate)
        && (item.count < 2 || this.readyAt(item) <= item.normalAt || this.readyAt(item) <= this.now())
    })
    return (this.readyAt(target) <= this.now() || this.allowance <= 0) && (successor === undefined || successor === key || this.targets.get(successor)!.normalAt <= this.now())
  }

  hasDispatched(keys: string[]) { return keys.some(key => this.targets.has(key)) }

  /** Rotate a caller's stable scheduler order after the most recent dispatch. */
  orderedTargets(keys: string[]) {
    const index = this.cursor === undefined ? -1 : keys.indexOf(this.cursor)
    return index < 0 ? keys : [...keys.slice(index + 1), ...keys.slice(0, index + 1)]
  }

  /** Identify an affinity wait; callers must perform fresh admission afterwards. */
  preferredProbe(keys: string[]) {
    if (!this.cursor || !keys.includes(this.cursor) || this.blocked.has(this.cursor) || this.admissionBlockedTargets.has(this.cursor)) return undefined
    const target = this.targets.get(this.cursor)
    if (!target || target.patience !== 60_000 || (this.pinned && this.pinned !== this.cursor)) return undefined
    if (target.probePending) return this.cursor
    return target.count >= 2 && target.hintDelay > 0 && target.hintDelay <= target.patience && this.readyAt(target) - this.now() <= this.allowance ? this.cursor : undefined
  }

  async waitForProbe(key: string, signal: AbortSignal, keys: string[] = [key]) {
    const target = this.targets.get(key)
    if (!target || this.preferredProbe([key]) !== key || this.dispatches >= MAX_DISPATCHES) return false
    if (signal.aborted) throw signal.reason
    const now = this.now()
    const ordinaryAt = Math.min(...keys.filter(candidate => candidate !== key && (!this.pinned || this.pinned === candidate) && !this.blocked.has(candidate) && !this.admissionBlockedTargets.has(candidate)).map(candidate => this.targets.get(candidate)?.normalAt ?? now), target.normalAt)
    const preferredAt = target.count === 1 ? target.normalAt : this.readyAt(target)
    const extra = Math.max(0, preferredAt - Math.max(now, ordinaryAt))
    if (extra > this.allowance) return false
    const delay = Math.ceil(Math.max(0, preferredAt - now))
    if (delay) await this.wait(delay, signal)
    this.allowance -= extra
    this.wakeTarget = key
    this.round++
    return !signal.aborted
  }

  dispatched(key: string) {
    const target = this.targets.get(key)
    this.targets.set(key, { count: (target?.count || 0) + 1, normalAt: 0, hintAt: 0, hintDelay: 0, patience: target?.patience ?? (this.inputTokens >= 80_000 ? 60_000 : 15_000), probePending: false })
    this.cursor = key
    this.wakeTarget = undefined
    this.dispatches++
    this.rpmWakeUsed = false
    this.rpmWakeAt = undefined
  }

  block(key: string) { this.blocked.add(key) }
  pin(key: string) { this.pinned = key }
  get isPinned() { return this.pinned !== undefined }
  useMember(index: number) { return this.pinnedMember === undefined || this.pinnedMember === index }
  rememberMember(index: number) { if (this.isPinned && this.pinnedMember === undefined) this.pinnedMember = index }
  readyTargets() { return this.orderedTargets([...this.targets.keys()]).filter(key => this.canDispatch(key)) }
  retireReady(keys: string[]) { for (const key of keys) this.blocked.add(key) }
  retireUnadmittedReady(keys: string[]) { this.retireReady(keys.filter(key => !this.admissionBlockedTargets.has(key))) }
  stopReason() { return this.stopReasonValue }

  scheduleAdmission(reason: "rpm_limit" | "concurrency_limit" | "mixed_limits", retryAfterMs: number | undefined, targetKeys: string[] = []) {
    for (const key of targetKeys) this.admissionBlockedTargets.add(key)
    if (reason !== "concurrency_limit" && !this.rpmWakeUsed && retryAfterMs !== undefined && retryAfterMs >= 0) {
      this.rpmWakeAt = Math.min(this.rpmWakeAt ?? Number.POSITIVE_INFINITY, this.now() + retryAfterMs)
    }
    if (reason !== "rpm_limit") this.concurrencyBlocked = true
  }

  failed(key: string, status: number, headers: Headers, failureClass?: UpstreamFailureClass) {
    void status
    void failureClass
    const target = this.targets.get(key)
    if (!target) return false
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
    target.normalAt = this.now() + backoff
    target.hintAt = this.now() + delay
    target.hintDelay = delay
    target.probePending = target.count === 1 && delay > 0
    return true
  }

  async nextRound(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason
    if (this.dispatches >= MAX_DISPATCHES) { this.stopReasonValue = "dispatch_limit"; return false }
    const now = this.now()
    let pollAt: number | undefined
    if (this.concurrencyBlocked && this.concurrencyPolls < CONCURRENCY_POLL_MS.length) {
      pollAt = now + CONCURRENCY_POLL_MS[this.concurrencyPolls]!
    }
    const admissionAt = Math.min(pollAt ?? Infinity, this.rpmWakeAt ?? Infinity)
    const candidates = this.orderedTargets([...this.targets.keys()]).filter(key => (!this.pinned || this.pinned === key) && !this.blocked.has(key) && !this.admissionBlockedTargets.has(key))
    // Ordinary backoff follows the cursor, not whichever independent jitter is smallest.
    const normalKey = candidates.find(key => this.readyAt(this.targets.get(key)!) <= this.targets.get(key)!.normalAt)
    const ordinaryAt = Math.min(candidates.length ? this.targets.get(candidates[0]!)!.normalAt : Infinity, admissionAt)
    const hinted = candidates.map(key => ({ key, at: this.readyAt(this.targets.get(key)!) }))
    const normal = normalKey ? { key: normalKey, at: this.targets.get(normalKey)!.normalAt } : undefined
    const first = hinted.filter(item => item.at > this.targets.get(item.key)!.normalAt).reduce<{ key: string; at: number } | undefined>((best, item) => !best || item.at < best.at ? item : best, normal)
    const proposedAt = Math.min(first?.at ?? Infinity, admissionAt)
    const wakeAt = Math.min(proposedAt, Math.max(now, ordinaryAt) + this.allowance)
    this.concurrencyBlocked = false
    this.admissionBlockedTargets.clear()
    if (!Number.isFinite(wakeAt)) { this.stopReasonValue = "no_retryable_targets"; return false }
    const delay = Math.ceil(Math.max(0, wakeAt - now))
    const extra = Math.max(0, wakeAt - Math.max(now, ordinaryAt))
    if (delay) await this.wait(delay, signal)
    this.allowance -= extra
    this.wakeTarget = first && wakeAt < admissionAt ? first.key : undefined
    if (pollAt !== undefined && pollAt <= this.now()) this.concurrencyPolls++
    if (this.rpmWakeAt !== undefined && this.rpmWakeAt <= this.now()) { this.rpmWakeAt = undefined; this.rpmWakeUsed = true }
    this.round++
    return !signal.aborted
  }
}
