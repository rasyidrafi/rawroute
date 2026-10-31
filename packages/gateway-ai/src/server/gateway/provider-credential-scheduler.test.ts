import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import type { ProviderApiKey } from "../../contracts/domain"
import { createProviderCredentialScheduler } from "./provider-credential-scheduler"

function key(id: string, overrides: Partial<ProviderApiKey> = {}): ProviderApiKey {
  return {
    id,
    providerId: "provider",
    name: id,
    key: `secret-${id}`,
    enabled: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function session(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function admitted(result: ReturnType<ReturnType<typeof createProviderCredentialScheduler>["acquire"]>) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Expected credential admission, got ${result.reason}`)
  return result
}

describe("provider credential capacity scheduler", () => {
  test("expires RPM attempts at the exact rolling-window boundary", () => {
    let now = 100
    const scheduler = createProviderCredentialScheduler({ now: () => now })
    const credential = key("a", { rpmLimit: 1 })

    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).release()
    now = 60_099
    const stillFull = scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })
    expect(stillFull).toEqual({ ok: false, reason: "rpm_limit", retryAfterMs: 1 })
    now = 60_100
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).release()
  })

  test("records unlimited attempts so newly added limits use existing history", () => {
    let now = 0
    const scheduler = createProviderCredentialScheduler({ now: () => now })
    const unlimited = key("a")
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [unlimited] })).release()
    now = 1
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [unlimited] })).release()

    const nowLimited = { ...unlimited, rpmLimit: 2 }
    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [nowLimited] })).toEqual({
      ok: false,
      reason: "rpm_limit",
      retryAfterMs: 59_999,
    })
    const absentAndInvalidLimits = [key("b", { rpmLimit: 0, maxConcurrency: 0 })]
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: absentAndInvalidLimits })).release()
  })

  test("reports the first eligible RPM expiry after lowering a limit, taking the earliest candidate", () => {
    let now = 0
    const scheduler = createProviderCredentialScheduler({ now: () => now })
    const previouslyUnlimited = key("a")
    const laterCandidate = key("b", { rpmLimit: 1 })

    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [previouslyUnlimited] })).release()
    now = 10_000
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [previouslyUnlimited] })).release()
    now = 15_000
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [laterCandidate] })).release()
    now = 20_000

    // A's oldest attempt expires at 60s, but count 2 at limit 1 stays blocked
    // until its second attempt expires at 70s. B's slot expires later at 75s.
    expect(scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [{ ...previouslyUnlimited, rpmLimit: 1 }, laterCandidate],
    })).toEqual({ ok: false, reason: "rpm_limit", retryAfterMs: 50_000 })
  })

  test("acquires synchronously across candidates without exceeding concurrency", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const candidates = [
      key("a", { priority: 2, maxConcurrency: 1 }),
      key("b", { priority: 1, maxConcurrency: 1 }),
    ]
    const admittedRequests = Array.from({ length: 20 }, () => scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: candidates,
    })).filter((result) => result.ok)

    expect(admittedRequests).toHaveLength(2)
    expect(admittedRequests.map((result) => result.ok && result.credential.id)).toEqual(["a", "b"])
    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: candidates })).toEqual({
      ok: false,
      reason: "concurrency_limit",
    })
    admittedRequests.forEach((result) => { if (result.ok) result.release() })
  })

  test("failed concurrency admissions do not consume RPM and changed limits do not reset active work", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const credential = key("a", { rpmLimit: 2, maxConcurrency: 1 })
    const first = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] }))
    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).toEqual({
      ok: false,
      reason: "concurrency_limit",
    })

    // A replacement configuration keeps both the first request's RPM and lease state.
    expect(scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [{ ...credential, rpmLimit: 1, maxConcurrency: 1, priority: 999 }],
    })).toEqual({ ok: false, reason: "mixed_limits", retryAfterMs: 60_000 })
    first.release()
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).release()
    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).toEqual({
      ok: false,
      reason: "rpm_limit",
      retryAfterMs: 60_000,
    })
  })

  test("release is idempotent and never refunds the RPM attempt, including cancellation", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const credential = key("a", { rpmLimit: 1, maxConcurrency: 2 })
    const cancelled = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] }))
    cancelled.release()
    cancelled.release()

    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).toEqual({
      ok: false,
      reason: "rpm_limit",
      retryAfterMs: 60_000,
    })
  })

  test("pre-dispatch cancellation refunds its reservation but cannot refund a dispatched attempt", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const credential = key("a", { rpmLimit: 1, maxConcurrency: 1 })
    const cancelled = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] }))
    cancelled.cancelBeforeDispatch()
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [credential] })).release()

    const dispatched = admitted(scheduler.acquire({ ownerWorkspaceId: "other-owner", providerId: "provider", credentials: [credential] }))
    dispatched.markDispatched()
    dispatched.cancelBeforeDispatch()
    expect(scheduler.acquire({ ownerWorkspaceId: "other-owner", providerId: "provider", credentials: [credential] })).toEqual({
      ok: false,
      reason: "rpm_limit",
      retryAfterMs: 60_000,
    })
  })

  test("orders by saved priority, creation time, and deterministic credential ID", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const candidates = [
      key("z", { priority: 4, createdAt: "2025-01-02" }),
      key("b", { priority: 4, createdAt: "2025-01-01" }),
      key("a", { priority: 4, createdAt: "2025-01-01" }),
      key("top", { priority: 5, createdAt: "2025-02-01" }),
    ]
    const selected = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: candidates }))
    expect(selected.credential.id).toBe("top")
    selected.release()

    const next = admitted(scheduler.acquire({
      ownerWorkspaceId: "other-owner",
      providerId: "provider",
      credentials: candidates.filter((credential) => credential.id !== "top"),
    }))
    expect(next.credential.id).toBe("a")
    next.release()
  })

  test("balances active requests before RPM utilization, then falls back to saved order", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const a = key("a", { priority: 2, rpmLimit: 10 })
    const b = key("b", { priority: 1, rpmLimit: 10 })

    const first = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a, b] }))
    expect(first.credential.id).toBe("a")
    const whileAActive = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a, b] }))
    expect(whileAActive.credential.id).toBe("b")
    first.release()
    whileAActive.release()

    const equalUtilization = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a, b] }))
    expect(equalUtilization.credential.id).toBe("a")
    equalUtilization.release()
    const lowerUtilization = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a, b] }))
    expect(lowerUtilization.credential.id).toBe("b")
    lowerUtilization.release()
  })

  test("treats missing RPM limits as unlimited zero utilization", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const unlimited = key("unlimited", { priority: 2 })
    const limited = key("limited", { priority: 1, rpmLimit: 1 })
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [unlimited] })).release()

    const next = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [unlimited, limited] }))
    expect(next.credential.id).toBe("unlimited")
    next.release()
  })

  test("spreads sessions, reuses affinity, expires it, and does not balance requests without a session", () => {
    let now = 0
    const scheduler = createProviderCredentialScheduler({ now: () => now })
    const a = key("a", { priority: 2 })
    const b = key("b", { priority: 1 })
    const credentials = [a, b]
    const sessionA = session("session-a")
    const sessionB = session("session-b")

    const firstA = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials, sessionScopeHash: sessionA }))
    expect(firstA.credential.id).toBe("a")
    firstA.release()
    const firstB = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials, sessionScopeHash: sessionB }))
    expect(firstB.credential.id).toBe("b")
    firstB.release()

    const reusedA = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials, sessionScopeHash: sessionA }))
    expect(reusedA.credential.id).toBe("a")
    reusedA.release()

    // A saved-order change cannot move a live affinity, but expiry restores saved ordering.
    const reversed = [{ ...a, priority: 0 }, { ...b, priority: 10 }]
    const stillA = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: reversed, sessionScopeHash: sessionA }))
    expect(stillA.credential.id).toBe("a")
    stillA.release()
    now = 15 * 60_000
    const expired = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: reversed, sessionScopeHash: sessionA }))
    expect(expired.credential.id).toBe("b")
    expired.release()

    // No-session requests skip session-binding balancing and follow saved order.
    const onlyA = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a], sessionScopeHash: session("bound-a") }))
    onlyA.release()
    const withoutSession = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: reversed }))
    expect(withoutSession.credential.id).toBe("b")
    withoutSession.release()
  })

  test("evicts the oldest session binding at the fixed cache bound", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const a = key("a", { priority: 2 })
    const b = key("b", { priority: 1 })
    const originalSession = session("oldest")
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a], sessionScopeHash: originalSession })).release()

    for (let index = 0; index < 4_096; index++) {
      admitted(scheduler.acquire({
        ownerWorkspaceId: "owner",
        providerId: "provider",
        credentials: [a],
        sessionScopeHash: session(`new-${index}`),
      })).release()
    }

    const reselected = admitted(scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [a, b],
      sessionScopeHash: originalSession,
    }))
    expect(reselected.credential.id).toBe("b")
    reselected.release()
  })

  test("isolates pools by owner and provider while shared recipients use their owner's pool", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const credential = key("same-id", { maxConcurrency: 1 })
    const ownerLease = admitted(scheduler.acquire({
      ownerWorkspaceId: "shared-owner",
      providerId: "provider-a",
      credentials: [credential],
      sessionScopeHash: session("recipient-one/gateway-one/session"),
    }))
    expect(scheduler.acquire({
      ownerWorkspaceId: "shared-owner",
      providerId: "provider-a",
      credentials: [credential],
      sessionScopeHash: session("recipient-two/gateway-two/session"),
    })).toEqual({ ok: false, reason: "concurrency_limit" })

    const otherOwner = admitted(scheduler.acquire({ ownerWorkspaceId: "other-owner", providerId: "provider-a", credentials: [credential] }))
    const otherProvider = admitted(scheduler.acquire({ ownerWorkspaceId: "shared-owner", providerId: "provider-b", credentials: [credential] }))
    ownerLease.release()
    otherOwner.release()
    otherProvider.release()
  })

  test("preserves leases through disable, deletion, reintroduction, and limit changes", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const original = key("a", { maxConcurrency: 1 })
    const live = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [original] }))

    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [{ ...original, enabled: false }] })).toEqual({
      ok: false,
      reason: "no_eligible_credentials",
    })
    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [] })).toEqual({
      ok: false,
      reason: "no_eligible_credentials",
    })
    expect(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [{ ...original, maxConcurrency: 1, priority: 100 }] })).toEqual({
      ok: false,
      reason: "concurrency_limit",
    })
    live.release()
    admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [original] })).release()
  })

  test("excludes attempted credentials, pins required continuations, and distinguishes saturation reasons", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const a = key("a", { priority: 2, rpmLimit: 1 })
    const b = key("b", { priority: 1, maxConcurrency: 1 })
    const attemptedA = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a] }))
    attemptedA.release()
    const liveB = admitted(scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [b] }))

    const requiredB = scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [a, b],
      excludedCredentialIds: ["a"],
      requiredCredentialId: "b",
    })
    expect(requiredB).toEqual({ ok: false, reason: "concurrency_limit" })
    expect(scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [a, b],
      excludedCredentialIds: ["b"],
      requiredCredentialId: "b",
    })).toEqual({ ok: false, reason: "required_credential_unavailable" })

    const mixed = scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a, b] })
    expect(mixed).toEqual({ ok: false, reason: "mixed_limits", retryAfterMs: 60_000 })
    liveB.release()
    const rpmOnly = scheduler.acquire({ ownerWorkspaceId: "owner", providerId: "provider", credentials: [a] })
    expect(rpmOnly).toEqual({ ok: false, reason: "rpm_limit", retryAfterMs: 60_000 })
  })

  test("returns no credential when only disabled, empty, or OAuth credentials remain", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    const result = scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [
        key("disabled", { enabled: false }),
        key("empty", { key: "  " }),
        key("oauth", { credentialKind: "codex-oauth" }),
      ],
    })
    expect(result).toEqual({ ok: false, reason: "no_eligible_credentials" })
  })

  test("rejects a raw session value instead of caching it as affinity", () => {
    const scheduler = createProviderCredentialScheduler({ now: () => 0 })
    expect(() => scheduler.acquire({
      ownerWorkspaceId: "owner",
      providerId: "provider",
      credentials: [key("a")],
      sessionScopeHash: "raw-session-header",
    })).toThrow("caller-scoped SHA-256")
  })
})
