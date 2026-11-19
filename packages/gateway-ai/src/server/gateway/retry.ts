const RETRY_WINDOW_MS = 30_000
const MAX_DISPATCHES = 24
const MAX_TARGET_DISPATCHES = 3

type Target = { count: number; readyAt: number; retryable: boolean }

/** Request-local dispatch limits. The deadline limits retries, not a successful stream. */
export class GatewayRetry {
  private readonly deadline = Date.now() + RETRY_WINDOW_MS
  private readonly targets = new Map<string, Target>()
  private dispatches = 0
  private pinned: string | undefined
  private pinnedMember: number | undefined
  private lastFailure: Response | undefined
  round = 0
  private readonly blocked = new Set<string>()

  get count() { return this.dispatches }
  rememberFailure(response: Response) { this.lastFailure = response }
  previousFailure() { return this.lastFailure?.clone() }

  key(owner: string, provider: string, model: string, credential: string) {
    return JSON.stringify([owner, provider, model, credential])
  }

  canDispatch(key: string) {
    const target = this.targets.get(key)
    if (this.pinned && this.pinned !== key) return false
    if (this.dispatches >= MAX_DISPATCHES || (this.dispatches > 0 && Date.now() >= this.deadline)) return false
    if (!target) return this.round === 0
    return this.round > 0 && target.retryable && !this.blocked.has(key) && target.count < MAX_TARGET_DISPATCHES && target.readyAt <= Date.now()
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
    return [...this.targets.entries()].filter(([key, target]) => !this.blocked.has(key) && target.retryable && target.readyAt <= Date.now()).map(([key]) => key)
  }

  retireReady(keys: string[]) {
    for (const key of keys) this.blocked.add(key)
  }

  withinDeadline() { return this.dispatches === 0 || Date.now() < this.deadline }

  failed(key: string, status: number, headers: Headers) {
    const target = this.targets.get(key)
    if (!target) return false
    target.retryable = status === 401 || status === 403 || status === 429 || status >= 500 && status <= 599
    const raw = headers.get("retry-after")?.trim()
    const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : undefined
    const date = raw && seconds === undefined ? Date.parse(raw) : NaN
    const delay = seconds !== undefined ? seconds * 1_000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
    const backoff = Math.random() * 100 + 100 * 2 ** (target.count - 1)
    target.readyAt = Date.now() + Math.max(delay, backoff)
    return target.retryable
  }

  async nextRound(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason
    if (this.dispatches >= MAX_DISPATCHES) return false
    const candidates = [...this.targets.entries()].filter(([key, target]) => (!this.pinned || this.pinned === key) && !this.blocked.has(key) && target.retryable && target.count < MAX_TARGET_DISPATCHES).map(([, target]) => target)
    if (!candidates.length) return false
    const wait = Math.ceil(Math.max(0, Math.min(...candidates.map(target => target.readyAt)) - Date.now()))
    if (Date.now() + wait >= this.deadline) return false
    if (wait) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, wait)
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    this.round++
    return !signal.aborted && Date.now() < this.deadline
  }
}
