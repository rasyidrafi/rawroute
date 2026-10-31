import { clearTimeout, setTimeout } from "node:timers"
import type { ProviderApiKey } from "../../contracts/domain"

const RPM_WINDOW_MS = 60_000
const SESSION_AFFINITY_TTL_MS = 15 * 60_000
const MAX_SESSION_AFFINITIES = 4_096
const sessionScopeHashPattern = /^[0-9a-f]{64}$/

type CredentialState = {
  requestTimes: number[]
  activeRequests: number
}

type SessionAffinity = {
  credentialKey: string
  lastUsedAt: number
}

export interface ProviderCredentialAdmissionInput {
  /** Provider owner, not the recipient workspace for shared models. */
  ownerWorkspaceId: string
  providerId: string
  credentials: readonly ProviderApiKey[]
  /** The caller-scoped SHA-256 from sessionPromptCacheScope; routing hint only, never authorization. */
  sessionScopeHash?: string
  /** Transport retries omit credentials that have already been attempted. */
  excludedCredentialIds?: Iterable<string>
  /** Stateful continuations must not silently move to another credential. */
  requiredCredentialId?: string
}

export type ProviderCredentialAdmissionFailureReason =
  | "no_eligible_credentials"
  | "required_credential_unavailable"
  | "rpm_limit"
  | "concurrency_limit"
  | "mixed_limits"

export type ProviderCredentialAdmission =
  | {
      ok: true
      credential: ProviderApiKey
      /** Mark the attempt before awaiting the outbound request. */
      markDispatched: () => void
      /** Refunds this admission only when no outbound dispatch has begun. */
      cancelBeforeDispatch: () => void
      /** Releases concurrency; RPM remains charged after dispatch. */
      release: () => void
    }
  | {
      ok: false
      reason: ProviderCredentialAdmissionFailureReason
      /** Earliest known RPM slot expiry, measured from the scheduler clock. */
      retryAfterMs?: number
    }

export interface ProviderCredentialScheduler {
  /** Synchronously selects and acquires one eligible credential, or explains why none fit. */
  acquire(input: ProviderCredentialAdmissionInput): ProviderCredentialAdmission
}

function poolKey(ownerWorkspaceId: string, providerId: string, credentialId: string) {
  return JSON.stringify([ownerWorkspaceId, providerId, credentialId])
}

function affinityKey(ownerWorkspaceId: string, providerId: string, sessionScopeHash: string) {
  return JSON.stringify([ownerWorkspaceId, providerId, sessionScopeHash])
}

function positiveLimit(value: number | undefined) {
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined
}

function compareSavedOrder(left: ProviderApiKey, right: ProviderApiKey) {
  return (right.priority ?? 0) - (left.priority ?? 0)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function eligibleCredentials(credentials: readonly ProviderApiKey[]) {
  return credentials
    .filter((credential) => credential.enabled && credential.credentialKind !== "codex-oauth" && credential.key.trim().length > 0)
    .sort(compareSavedOrder)
}

/**
 * Credential accounting is process-local: RPM history starts empty after a
 * process restart. The window and affinity bounds are fixed owner defaults.
 */
export function createProviderCredentialScheduler(options: { now?: () => number } = {}): ProviderCredentialScheduler {
  const clock = options.now ?? (() => performance.now())
  const schedulesIdleCleanup = options.now === undefined
  const credentials = new Map<string, CredentialState>()
  // Insertion order is the fixed-size LRU order; session counts are derived
  // from this map so expiry, eviction, and rebinding cannot drift counters.
  const affinities = new Map<string, SessionAffinity>()
  let lastNow = Number.NEGATIVE_INFINITY
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined

  function currentTime() {
    const observed = clock()
    if (!Number.isFinite(observed)) throw new RangeError("Provider scheduler clock must return a finite number.")
    // Keep internal timestamps monotonic even if a faulty injected clock moves backwards.
    lastNow = Math.max(lastNow, observed)
    return lastNow
  }

  function prune(now: number) {
    const cutoff = now - RPM_WINDOW_MS
    for (const [key, state] of credentials) {
      while (state.requestTimes.length && state.requestTimes[0]! <= cutoff) state.requestTimes.shift()
      if (state.activeRequests === 0 && state.requestTimes.length === 0) credentials.delete(key)
    }
    const affinityCutoff = now - SESSION_AFFINITY_TTL_MS
    for (const [key, affinity] of affinities) {
      if (affinity.lastUsedAt <= affinityCutoff) affinities.delete(key)
    }
  }

  function scheduleIdleCleanup(now: number) {
    if (!schedulesIdleCleanup) return
    if (cleanupTimer) clearTimeout(cleanupTimer)
    let nextExpiry = Number.POSITIVE_INFINITY
    for (const state of credentials.values()) {
      if (state.requestTimes.length) nextExpiry = Math.min(nextExpiry, state.requestTimes[0]! + RPM_WINDOW_MS)
    }
    for (const affinity of affinities.values()) {
      nextExpiry = Math.min(nextExpiry, affinity.lastUsedAt + SESSION_AFFINITY_TTL_MS)
    }
    if (!Number.isFinite(nextExpiry)) {
      cleanupTimer = undefined
      return
    }
    cleanupTimer = setTimeout(() => {
      cleanupTimer = undefined
      const current = currentTime()
      prune(current)
      scheduleIdleCleanup(current)
    }, Math.max(1, nextExpiry - now))
    cleanupTimer.unref()
  }

  function getAffinityCounts(exceptAffinityKey: string | undefined) {
    const counts = new Map<string, number>()
    for (const [key, affinity] of affinities) {
      if (key === exceptAffinityKey) continue
      counts.set(affinity.credentialKey, (counts.get(affinity.credentialKey) ?? 0) + 1)
    }
    return counts
  }

  function setAffinity(key: string, credentialKey: string, now: number) {
    affinities.delete(key)
    affinities.set(key, { credentialKey, lastUsedAt: now })
    while (affinities.size > MAX_SESSION_AFFINITIES) {
      const oldest = affinities.keys().next().value
      if (oldest === undefined) break
      affinities.delete(oldest)
    }
  }

  function acquire(input: ProviderCredentialAdmissionInput): ProviderCredentialAdmission {
    if (input.sessionScopeHash !== undefined && !sessionScopeHashPattern.test(input.sessionScopeHash)) {
      throw new TypeError("Session affinity requires a caller-scoped SHA-256 session hash.")
    }
    const now = currentTime()
    prune(now)

    const excluded = new Set(input.excludedCredentialIds)
    const ordered = eligibleCredentials(input.credentials).filter((credential) => !excluded.has(credential.id))
    if (input.requiredCredentialId !== undefined) {
      const required = ordered.find((credential) => credential.id === input.requiredCredentialId)
      if (!required) {
        scheduleIdleCleanup(now)
        return { ok: false, reason: "required_credential_unavailable" }
      }
      ordered.splice(0, ordered.length, required)
    }
    if (!ordered.length) {
      scheduleIdleCleanup(now)
      return { ok: false, reason: "no_eligible_credentials" }
    }

    const currentAffinityKey = input.sessionScopeHash === undefined
      ? undefined
      : affinityKey(input.ownerWorkspaceId, input.providerId, input.sessionScopeHash)
    const existingAffinity = currentAffinityKey ? affinities.get(currentAffinityKey) : undefined
    const counts = input.sessionScopeHash === undefined ? undefined : getAffinityCounts(currentAffinityKey)
    const available: Array<{
      credential: ProviderApiKey
      key: string
      state: CredentialState | undefined
      requestCount: number
      activeRequests: number
      utilization: number
      activeBindings: number
    }> = []
    let blockedByRpm = false
    let blockedByConcurrency = false
    let earliestRpmExpiry = Number.POSITIVE_INFINITY

    for (const credential of ordered) {
      const key = poolKey(input.ownerWorkspaceId, input.providerId, credential.id)
      const state = credentials.get(key)
      const requestCount = state?.requestTimes.length ?? 0
      const rpmLimit = positiveLimit(credential.rpmLimit)
      const concurrencyLimit = positiveLimit(credential.maxConcurrency)
      const rpmBlocked = rpmLimit !== undefined && requestCount >= rpmLimit
      const concurrencyBlocked = concurrencyLimit !== undefined && (state?.activeRequests ?? 0) >= concurrencyLimit
      if (rpmBlocked || concurrencyBlocked) {
        blockedByRpm ||= rpmBlocked
        blockedByConcurrency ||= concurrencyBlocked
        if (rpmBlocked && state?.requestTimes.length && rpmLimit !== undefined) {
          // Keep enough attempts in the window to remain at the limit. The
          // request at count-limit is the first expiry that makes this key
          // eligible again; older expiries alone do not free a slot.
          const firstEligibleExpiryIndex = requestCount - rpmLimit
          earliestRpmExpiry = Math.min(
            earliestRpmExpiry,
            state.requestTimes[firstEligibleExpiryIndex]! + RPM_WINDOW_MS,
          )
        }
        continue
      }
      available.push({
        credential,
        key,
        state,
        requestCount,
        activeRequests: state?.activeRequests ?? 0,
        // No configured RPM limit means unlimited headroom (zero utilization).
        utilization: rpmLimit === undefined ? 0 : requestCount / rpmLimit,
        activeBindings: counts?.get(key) ?? 0,
      })
    }

    if (!available.length) {
      scheduleIdleCleanup(now)
      const reason = blockedByRpm && blockedByConcurrency
        ? "mixed_limits"
        : blockedByRpm ? "rpm_limit" : "concurrency_limit"
      return {
        ok: false,
        reason,
        ...(Number.isFinite(earliestRpmExpiry) ? { retryAfterMs: Math.max(0, earliestRpmExpiry - now) } : {}),
      }
    }

    let selected = existingAffinity
      ? available.find((entry) => entry.key === existingAffinity.credentialKey)
      : undefined
    if (!selected) {
      available.sort((left, right) => {
        if (counts) {
          const bindingDifference = left.activeBindings - right.activeBindings
          if (bindingDifference) return bindingDifference
        }
        return left.activeRequests - right.activeRequests
          || left.utilization - right.utilization
          || compareSavedOrder(left.credential, right.credential)
      })
      selected = available[0]!
    }

    const state = selected.state ?? { requestTimes: [], activeRequests: 0 }
    if (!selected.state) credentials.set(selected.key, state)
    // One attempt is charged at admission and is never refunded by release.
    state.requestTimes.push(now)
    state.activeRequests++
    if (currentAffinityKey) setAffinity(currentAffinityKey, selected.key, now)
    scheduleIdleCleanup(now)

    let released = false
    let dispatched = false
    const finish = (refund: boolean) => {
      if (released) return
      released = true
      if (state.activeRequests > 0) state.activeRequests--
      if (refund && !dispatched) {
        const requestIndex = state.requestTimes.lastIndexOf(now)
        if (requestIndex >= 0) state.requestTimes.splice(requestIndex, 1)
      }
      const releasedAt = currentTime()
      prune(releasedAt)
      scheduleIdleCleanup(releasedAt)
    }
    return {
      ok: true,
      credential: selected.credential,
      markDispatched: () => { dispatched = true },
      cancelBeforeDispatch: () => finish(true),
      release: () => finish(false),
    }
  }

  return { acquire }
}

/** Shared by gateway transports. Restarting the process resets only this local RPM history. */
export const providerCredentialScheduler = createProviderCredentialScheduler()
