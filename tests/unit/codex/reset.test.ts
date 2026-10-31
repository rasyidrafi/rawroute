import { afterEach, expect, jest, mock, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInWorkspace } from "../../../packages/platform/src/server/workspace-context"
import { closeLocalDatabase } from "../../../packages/platform/src/server/database"
import * as audit from "../../../packages/platform/src/server/audit"
import { admitGatewayExecution, drainGatewayExecutions, resumeGatewayExecutions } from "../../../packages/gateway-ai/src/server/gateway/admission"
import type { ProviderApiKey } from "../../../packages/gateway-ai/src/contracts/domain"
import { ensureCodexProvider } from "../../../packages/gateway-ai/src/server/codex/oauth"
import { deleteCodexCredential, registerCodexCredential } from "../../../packages/gateway-ai/src/server/codex-credentials"
import { setCodexOAuthFetchForTests } from "../../../packages/gateway-ai/src/server/codex/login"
import { PATCH as patchAutoRedeemSettings } from "../../../packages/gateway-ai/src/server/routes/api/admin/oauth-providers/auto-redeem"
import {
  checkCodexResetAutomatically,
  checkEnabledCodexAccountsAutomatically,
  completeCodexResetAccountRemoval,
  getCodexAutoRedeemSettings,
  getCodexAutoRedeemStatus,
  getCodexResetAccountStatus,
  redeemCodexReset,
  resetCodexResetCoordinatorForTests,
  reserveCodexResetAccountRemoval,
  setCodexResetApiCallForTests,
  startCodexResetAutomation,
  stopCodexResetAutomation,
  updateCodexAutoRedeemSettings,
} from "../../../packages/gateway-ai/src/server/codex/reset"
import { setCodexUsageApiCallForTests } from "../../../packages/gateway-ai/src/server/codex/usage"
import { setCodexUpstreamFetchForTests } from "../../../packages/gateway-ai/src/server/codex/upstream"
import { migrateCodexResetIdentity } from "../../../scripts/migrations/codex-reset-identity"

let workspaceSequence = 0
let account: ProviderApiKey
const workspaceTest = (name: string, callback: () => Promise<void>) => test(name, () => runInWorkspace({ id: `codex-reset-${++workspaceSequence}` }, async () => {
  account = await setupAccount()
  await callback()
}))

async function setupAccount() {
  const provider = await ensureCodexProvider()
  return registerCodexCredential(provider.id, {
    accountId: "acct-codex-reset-test",
    name: "Codex test account",
    secrets: {
      accessToken: "reset-access-token",
      refreshToken: "reset-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  })
}

let expiryAt = Date.now() + 20 * 60_000
let creditIds = ["credit-one"]
let weeklyUsedPercent = 100
let usageReads = 0
let inventoryReads = 0
let postCalls = 0

function configureUsage() {
  setCodexUsageApiCallForTests(async (_account, input) => {
    if (input.url.endsWith("/usage")) {
      usageReads++
      return {
        status: 200,
        body: JSON.stringify({ rate_limit: {
          primary_window: { used_percent: 100 },
          secondary_window: { used_percent: weeklyUsedPercent },
        } }),
      }
    }
    inventoryReads++
    return {
      status: 200,
      body: JSON.stringify({ credits: creditIds.map(id => ({ id, status: "available", expires_at: new Date(expiryAt).toISOString() })) }),
    }
  })
}

afterEach(async () => {
  await stopCodexResetAutomation()
  resumeGatewayExecutions()
  resetCodexResetCoordinatorForTests()
  setCodexUsageApiCallForTests()
  setCodexUpstreamFetchForTests()
  setCodexOAuthFetchForTests()
  expiryAt = Date.now() + 20 * 60_000
  creditIds = ["credit-one"]
  weeklyUsedPercent = 100
  usageReads = 0
  inventoryReads = 0
  postCalls = 0
  jest.useRealTimers()
  mock.restore()
})

workspaceTest("uses expiry within one hour by default and keeps weekly-exhaustion trigger off", async () => {
  expect(await getCodexAutoRedeemSettings()).toEqual({ expiryEnabled: true, weeklyExhaustionEnabled: false })
  await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: true })
  await runInAnotherWorkspace(async () => {
    expect(await getCodexAutoRedeemSettings()).toEqual({ expiryEnabled: true, weeklyExhaustionEnabled: false })
  })
  expect(await getCodexAutoRedeemSettings()).toEqual({ expiryEnabled: false, weeklyExhaustionEnabled: true })
})

workspaceTest("auto-redemption waits for expiry and the upstream weekly-quota guard", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  expiryAt = Date.now() + 2 * 60 * 60_000
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  expect((await getCodexResetAccountStatus(account.id))?.lastMessage).toContain("within 1 hour")

  expiryAt = Date.now() + 20 * 60_000
  weeklyUsedPercent = 99.9
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  expect((await getCodexResetAccountStatus(account.id))?.lastMessage).toContain("weekly Codex quota")

  weeklyUsedPercent = 100
  const result = await checkCodexResetAutomatically(account)
  expect(result).toMatchObject({ ok: true, status: 200 })
  expect(postCalls).toBe(1)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("redeemed")
  const publicStatus = await getCodexAutoRedeemStatus()
  expect(publicStatus.accounts[account.id]?.phase).toBe("redeemed")
  expect(JSON.stringify(publicStatus)).not.toContain(account.accountId!)
})

workspaceTest("already-exhausted weekly quota waits a full minute after activation", async () => {
  jest.useFakeTimers()
  const activatedAt = Date.now()
  jest.setSystemTime(new Date(activatedAt))
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: false })
  await updateCodexAutoRedeemSettings({ weeklyExhaustionEnabled: true })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  expect((await getCodexResetAccountStatus(account.id))?.lastMessage).toContain("1-minute safety delay")

  jest.setSystemTime(new Date(activatedAt + 59_999))
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  // Re-saving an already-enabled setting must not restart the delay.
  await updateCodexAutoRedeemSettings({ weeklyExhaustionEnabled: true })
  jest.setSystemTime(new Date(activatedAt + 60_000))
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(1)
})

workspaceTest("turning weekly automation off cancels the delay and re-enabling starts a new minute", async () => {
  jest.useFakeTimers()
  const activatedAt = Date.now()
  jest.setSystemTime(new Date(activatedAt))
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: true })
  await checkCodexResetAutomatically(account)
  jest.setSystemTime(new Date(activatedAt + 30_000))
  await updateCodexAutoRedeemSettings({ weeklyExhaustionEnabled: false })
  jest.setSystemTime(new Date(activatedAt + 60_000))
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)

  await updateCodexAutoRedeemSettings({ weeklyExhaustionEnabled: true })
  await checkCodexResetAutomatically(account)
  jest.setSystemTime(new Date(activatedAt + 119_999))
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  jest.setSystemTime(new Date(activatedAt + 120_000))
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(1)
})

workspaceTest("normal quota exhaustion after activation has no safety delay", async () => {
  jest.useFakeTimers()
  const activatedAt = Date.now()
  jest.setSystemTime(new Date(activatedAt))
  configureUsage()
  weeklyUsedPercent = 50
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: true })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  weeklyUsedPercent = 100
  jest.setSystemTime(new Date(activatedAt + 1_000))
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(1)
})

workspaceTest("expiry activation redeems immediately and bypasses the weekly activation delay", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: false })
  await updateCodexAutoRedeemSettings({ weeklyExhaustionEnabled: true })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  await updateCodexAutoRedeemSettings({ expiryEnabled: true })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(1)
})

workspaceTest("turning automation off while preflight is in progress prevents the POST", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  setCodexUsageApiCallForTests(async (_account, input) => {
    if (input.url.endsWith("/usage")) {
      await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: false })
      return { status: 200, body: JSON.stringify({ rate_limit: { secondary_window: { used_percent: 100 } } }) }
    }
    return { status: 200, body: JSON.stringify({ credits: [{ id: "credit-one", status: "available", expires_at: new Date(expiryAt).toISOString() }] }) }
  })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
})

workspaceTest("turning automation off after intent is persisted cancels before sending the POST", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  const auditRemoteOperation = audit.auditRemoteOperation
  spyOn(audit, "auditRemoteOperation").mockImplementation(async (input, operation, succeeded) => {
    expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("pending")
    await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: false })
    return auditRemoteOperation(input, operation, succeeded)
  })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(0)
  const status = await getCodexResetAccountStatus(account.id)
  expect(status?.phase).toBe("idle")
  expect(status?.lastMessage).toContain("no redemption request was sent")
})

workspaceTest("settings activation wakes the server immediately and disabling cancels its scheduled wakeup", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: false })
  startCodexResetAutomation()
  const patch = (input: Record<string, boolean>) => patchAutoRedeemSettings(new Request("http://localhost/api/admin/oauth-providers/auto-redeem/settings", { method: "PATCH", body: JSON.stringify(input) }))
  expect((await patch({ weeklyExhaustionEnabled: true })).status).toBe(200)
  expect(globalThis.__rawrouteCodexResetScheduler?.wakeups.size).toBe(1)
  expect((await patch({ weeklyExhaustionEnabled: false })).status).toBe(200)
  expect(globalThis.__rawrouteCodexResetScheduler?.wakeups.size).toBe(0)
  expect(postCalls).toBe(0)

  expect((await patch({ expiryEnabled: true })).status).toBe(200)
  // Stopping drains the immediate checks rather than abandoning them.
  await stopCodexResetAutomation()
  expect(postCalls).toBe(1)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("redeemed")
})

workspaceTest("manual and automatic triggers share one persisted pending intent", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async (_account, input) => {
    expect(input.method).toBe("POST")
    postCalls++
    const status = await getCodexResetAccountStatus(account.id)
    expect(status?.phase).toBe("pending")
    expect(status?.requestId).toBe(JSON.parse(input.data || "{}").redeem_request_id)
    await expect(reserveCodexResetAccountRemoval(account)).rejects.toThrow("in progress")
    return { status: 200, body: "{}" }
  })

  const results = await Promise.allSettled([
    redeemCodexReset(account, "Please use my Codex reset"),
    checkCodexResetAutomatically(account),
  ])
  expect(postCalls).toBe(1)
  expect(results.some(result => result.status === "fulfilled" && result.value?.ok === true)).toBe(true)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("redeemed")

  const removal = await reserveCodexResetAccountRemoval(account)
  await completeCodexResetAccountRemoval(account, removal)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("redeemed")
})

workspaceTest("unknown POST outcome retries reads but never sends a second POST", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    throw new Error("connection closed")
  })

  await expect(redeemCodexReset(account, "use my codex reset")).rejects.toThrow("outcome is uncertain")
  const first = await getCodexResetAccountStatus(account.id)
  expect(first?.phase).toBe("unknown")
  expect(first?.requestId).toBeTruthy()
  const readsBeforeRetry = usageReads
  await checkCodexResetAutomatically(account)
  expect(usageReads).toBeGreaterThan(readsBeforeRetry)
  const second = await getCodexResetAccountStatus(account.id)
  expect(second?.phase).toBe("unknown")
  expect(second?.requestId).toBe(first?.requestId)
  expect(postCalls).toBe(1)
})

workspaceTest("direct reset-credit consumption is scoped and never replays an uncertain POST", async () => {
  configureUsage()
  const requests: Array<{ url: URL; method: string; headers: Headers; body: string }> = []
  setCodexResetApiCallForTests()
  setCodexUpstreamFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: new URL(input instanceof Request ? input.url : String(input)),
      method: init?.method || "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    })
    return Response.json({ error: "authorization failed" }, { status: 401 })
  }) as typeof fetch)

  await expect(redeemCodexReset(account, "use my codex reset")).rejects.toThrow("outcome is uncertain")
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("unknown")
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url.toString()).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume")
  expect(requests[0]!.method).toBe("POST")
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer reset-access-token")
  expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("acct-codex-reset-test")
  expect(JSON.parse(requests[0]!.body)).toMatchObject({ redeem_request_id: expect.any(String) })

  await checkCodexResetAutomatically(account)
  expect(requests).toHaveLength(1)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("unknown")
})

workspaceTest("failed token refresh before reset dispatch does not create an unknown outcome", async () => {
  configureUsage()
  const provider = await ensureCodexProvider()
  account = await registerCodexCredential(provider.id, {
    accountId: account.accountId!,
    name: account.name,
    secrets: {
      accessToken: "expired-reset-access",
      refreshToken: "failed-reset-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  })
  let refreshCalls = 0
  setCodexOAuthFetchForTests((async () => {
    refreshCalls++
    throw new Error("temporary refresh failure")
  }) as unknown as typeof fetch)
  setCodexResetApiCallForTests()
  const requests: Request[] = []
  setCodexUpstreamFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    return Response.json({ ok: true })
  }) as unknown as typeof fetch)

  await expect(redeemCodexReset(account, "use my codex reset")).rejects.not.toThrow("outcome is uncertain")
  expect(refreshCalls).toBe(1)
  expect(requests).toHaveLength(0)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("idle")

  setCodexOAuthFetchForTests((async () => Response.json({
    access_token: "recovered-reset-access",
    refresh_token: "recovered-reset-refresh",
    expires_in: 3600,
  })) as unknown as typeof fetch)
  await expect(redeemCodexReset(account, "use my codex reset")).resolves.toMatchObject({ ok: true, status: 200 })
  expect(requests).toHaveLength(1)
})

workspaceTest("manual redemption retains the weekly exhaustion preflight guard", async () => {
  configureUsage()
  weeklyUsedPercent = 99.9
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })

  await expect(redeemCodexReset(account, "use my codex reset")).rejects.toThrow("weekly Codex quota must be exhausted")
  expect(postCalls).toBe(0)
  expect(inventoryReads).toBe(1)
})

workspaceTest("automatic checks read and redeem enabled Codex accounts only", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  const disabled = { ...account, id: "disabled-reset-account", enabled: false }
  await checkEnabledCodexAccountsAutomatically([account, disabled])

  expect(postCalls).toBe(1)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("redeemed")
  expect(await getCodexResetAccountStatus(disabled.id)).toBeUndefined()
})

workspaceTest("blocks unchanged inventory but allows remaining credits after a confirmed inventory decrease", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })

  creditIds = ["credit-one", "credit-two"]
  await checkCodexResetAutomatically(account)
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(1)
  expect((await getCodexResetAccountStatus(account.id))?.lastMessage).toContain("inventory before another redemption")

  creditIds = ["credit-two"]
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(2)
})

workspaceTest("does not post again when reset-credit details disappear after a confirmed redemption", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async () => {
    postCalls++
    return { status: 200, body: "{}" }
  })
  await checkCodexResetAutomatically(account)
  expect(postCalls).toBe(1)

  setCodexUsageApiCallForTests(async (_account, input) => input.url.endsWith("/usage")
    ? { status: 200, body: JSON.stringify({ rate_limit_reset_credits: { available_count: 1 }, rate_limit: { secondary_window: { used_percent: 100 } } }) }
    : { status: 503, body: "inventory unavailable" })
  await checkCodexResetAutomatically(account)

  expect(postCalls).toBe(1)
  expect((await getCodexResetAccountStatus(account.id))?.lastMessage).toContain("details are unavailable")
})

workspaceTest("keeps ambiguous coordinator state across a SQLite close and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rawroute-codex-reset-recovery-"))
  const previousStorageBackend = process.env.STORAGE_BACKEND
  const previousSqlitePath = process.env.SQLITE_PATH
  await closeLocalDatabase()
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.SQLITE_PATH = join(directory, "rawroute.sqlite")
  const durableWorkspace = { id: "codex-reset-durable" }
  let durableAccountId = ""
  try {
    await runInWorkspace(durableWorkspace, async () => {
      const durableAccount = await setupAccount()
      durableAccountId = durableAccount.id
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        throw new Error("connection closed")
      })
      await expect(redeemCodexReset(durableAccount, "use my codex reset")).rejects.toThrow("outcome is uncertain")
    })
    const beforeRestart = await runInWorkspace(durableWorkspace, () => getCodexResetAccountStatus(durableAccountId))
    expect(beforeRestart?.phase).toBe("unknown")
    await closeLocalDatabase()

    await runInWorkspace(durableWorkspace, async () => {
      const durableAccount = await setupAccount()
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      await checkCodexResetAutomatically(durableAccount)
      expect((await getCodexResetAccountStatus(durableAccount.id))?.phase).toBe("unknown")
    })
    expect(postCalls).toBe(1)
  } finally {
    await closeLocalDatabase()
    if (previousStorageBackend === undefined) delete process.env.STORAGE_BACKEND
    else process.env.STORAGE_BACKEND = previousStorageBackend
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousSqlitePath
    rmSync(directory, { recursive: true, force: true })
  }
})

workspaceTest("keeps an unknown redemption blocked after SQLite deletion and same-account reconnection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rawroute-codex-reset-unknown-reconnect-"))
  const previousStorageBackend = process.env.STORAGE_BACKEND
  const previousSqlitePath = process.env.SQLITE_PATH
  await closeLocalDatabase()
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.SQLITE_PATH = join(directory, "rawroute.sqlite")
  const durableWorkspace = { id: "codex-reset-unknown-reconnect" }
  let removed: ProviderApiKey
  try {
    await runInWorkspace(durableWorkspace, async () => {
      removed = await setupAccount()
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        throw new Error("connection closed")
      })
      await expect(redeemCodexReset(removed, "use my codex reset")).rejects.toThrow("outcome is uncertain")

      const removal = await reserveCodexResetAccountRemoval(removed)
      await deleteCodexCredential(removed.providerId, removed.id)
      await completeCodexResetAccountRemoval(removed, removal)
      expect(await getCodexResetAccountStatus(removed.id)).toBeUndefined()
    })
    expect(postCalls).toBe(1)
    await closeLocalDatabase()

    await runInWorkspace(durableWorkspace, async () => {
      const reconnected = await setupAccount()
      expect(reconnected.id).not.toBe(removed.id)
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      expect((await getCodexResetAccountStatus(reconnected.id))?.phase).toBe("unknown")
      await expect(redeemCodexReset(reconnected, "use my codex reset")).rejects.toThrow("automatic retries are blocked")
      await checkCodexResetAutomatically(reconnected)
      expect(postCalls).toBe(1)
      expect((await getCodexResetAccountStatus(reconnected.id))?.phase).toBe("unknown")
    })
  } finally {
    await closeLocalDatabase()
    if (previousStorageBackend === undefined) delete process.env.STORAGE_BACKEND
    else process.env.STORAGE_BACKEND = previousStorageBackend
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousSqlitePath
    rmSync(directory, { recursive: true, force: true })
  }
})

workspaceTest("keeps the confirmed-inventory barrier after SQLite deletion and reconnection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rawroute-codex-reset-redeemed-reconnect-"))
  const previousStorageBackend = process.env.STORAGE_BACKEND
  const previousSqlitePath = process.env.SQLITE_PATH
  await closeLocalDatabase()
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.SQLITE_PATH = join(directory, "rawroute.sqlite")
  const durableWorkspace = { id: "codex-reset-redeemed-reconnect" }
  let removed: ProviderApiKey
  try {
    await runInWorkspace(durableWorkspace, async () => {
      removed = await setupAccount()
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      await expect(redeemCodexReset(removed, "use my codex reset")).resolves.toMatchObject({ ok: true })
      expect((await getCodexResetAccountStatus(removed.id))?.phase).toBe("redeemed")

      const removal = await reserveCodexResetAccountRemoval(removed)
      await deleteCodexCredential(removed.providerId, removed.id)
      await completeCodexResetAccountRemoval(removed, removal)
    })
    expect(postCalls).toBe(1)
    await closeLocalDatabase()

    await runInWorkspace(durableWorkspace, async () => {
      const reconnected = await setupAccount()
      expect(reconnected.id).not.toBe(removed.id)
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      expect((await getCodexResetAccountStatus(reconnected.id))?.phase).toBe("redeemed")
      await expect(redeemCodexReset(reconnected, "use my codex reset")).rejects.toThrow("waiting for Codex to update")
      await checkCodexResetAutomatically(reconnected)
      expect(postCalls).toBe(1)
      expect((await getCodexResetAccountStatus(reconnected.id))?.phase).toBe("redeemed")
    })
  } finally {
    await closeLocalDatabase()
    if (previousStorageBackend === undefined) delete process.env.STORAGE_BACKEND
    else process.env.STORAGE_BACKEND = previousStorageBackend
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousSqlitePath
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const legacyRecord of [
  { phase: "unknown", requestId: "old-unknown-request", lastMessage: "The redemption outcome is unknown." },
  { phase: "redeemed", requestId: "old-redeemed-request", blockedCreditCount: 1, blockedInventoryKnown: true, lastMessage: "The previous redemption was confirmed." },
] as const) test(`unmigrated local-ID reset history fails closed and migrated ${legacyRecord.phase} state remains blocked`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "rawroute-codex-reset-schema-"))
  const previousStorageBackend = process.env.STORAGE_BACKEND
  const previousSqlitePath = process.env.SQLITE_PATH
  await closeLocalDatabase()
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.SQLITE_PATH = join(directory, "rawroute.sqlite")
  const durableWorkspace = { id: `codex-reset-schema-${legacyRecord.phase}` }
  let localAccount: ProviderApiKey
  try {
    localAccount = await runInWorkspace(durableWorkspace, setupAccount)
    await closeLocalDatabase()
    const database = new Database(process.env.SQLITE_PATH)
    try {
      expect(database.query<{ version: number }, []>("SELECT version FROM ai_codex_reset_schema WHERE id = 1").get()?.version).toBe(1)
      database.run("DROP TABLE ai_codex_reset_schema")
      const collection = `rawroute_workspaces/${durableWorkspace.id}/codexResetAutomationAccounts`
      const path = `${collection}/${localAccount.id}`
      database.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)")
        .run(path, collection, localAccount.id, JSON.stringify(legacyRecord))
    } finally { database.close() }

    await runInWorkspace(durableWorkspace, async () => {
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      await expect(redeemCodexReset(localAccount, "use my codex reset")).rejects.toThrow("offline migration")
      await expect(checkCodexResetAutomatically(localAccount)).rejects.toThrow("offline migration")
      expect(postCalls).toBe(0)
    })
    await closeLocalDatabase()

    const migrated = migrateCodexResetIdentity(process.env.SQLITE_PATH, { apply: true, writersStopped: true })
    expect(migrated).toMatchObject({ applied: true, required: false, records: 1 })
    await runInWorkspace(durableWorkspace, async () => {
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      if (legacyRecord.phase === "unknown") {
        await expect(redeemCodexReset(localAccount, "use my codex reset")).rejects.toThrow("automatic retries are blocked")
        await checkCodexResetAutomatically(localAccount)
      } else {
        await expect(redeemCodexReset(localAccount, "use my codex reset")).rejects.toThrow("waiting for Codex to update")
        await checkCodexResetAutomatically(localAccount)
      }
      expect(postCalls).toBe(0)
      expect((await getCodexResetAccountStatus(localAccount.id))?.phase).toBe(legacyRecord.phase)
    })
  } finally {
    await closeLocalDatabase()
    if (previousStorageBackend === undefined) delete process.env.STORAGE_BACKEND
    else process.env.STORAGE_BACKEND = previousStorageBackend
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousSqlitePath
    rmSync(directory, { recursive: true, force: true })
  }
})

workspaceTest("keeps the weekly activation safety deadline across a SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rawroute-codex-reset-delay-"))
  const previousStorageBackend = process.env.STORAGE_BACKEND
  const previousSqlitePath = process.env.SQLITE_PATH
  await closeLocalDatabase()
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.SQLITE_PATH = join(directory, "rawroute.sqlite")
  jest.useFakeTimers()
  const activatedAt = Date.now()
  jest.setSystemTime(new Date(activatedAt))
  try {
    const durableWorkspace = { id: "codex-reset-delay-durable" }
    const durableAccount = await runInWorkspace(durableWorkspace, setupAccount)
    configureUsage()
    setCodexResetApiCallForTests(async () => {
      postCalls++
      return { status: 200, body: "{}" }
    })
    await runInWorkspace(durableWorkspace, async () => {
      await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: true })
      await checkCodexResetAutomatically(durableAccount)
      expect(postCalls).toBe(0)
    })
    await closeLocalDatabase()
    resetCodexResetCoordinatorForTests()
    setCodexResetApiCallForTests(async () => {
      postCalls++
      return { status: 200, body: "{}" }
    })
    jest.setSystemTime(new Date(activatedAt + 59_999))
    await runInWorkspace(durableWorkspace, async () => {
      await checkCodexResetAutomatically(durableAccount)
      expect(postCalls).toBe(0)
    })
    jest.setSystemTime(new Date(activatedAt + 60_000))
    await runInWorkspace(durableWorkspace, async () => {
      await checkCodexResetAutomatically(durableAccount)
      expect(postCalls).toBe(1)
    })
  } finally {
    await closeLocalDatabase()
    if (previousStorageBackend === undefined) delete process.env.STORAGE_BACKEND
    else process.env.STORAGE_BACKEND = previousStorageBackend
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousSqlitePath
    rmSync(directory, { recursive: true, force: true })
  }
})

workspaceTest("gateway shutdown drain waits for an admitted reset POST", async () => {
  configureUsage()
  let postStarted!: () => void
  let finishPost!: (result: { status: number; body: string }) => void
  const started = new Promise<void>(resolve => { postStarted = resolve })
  const pendingResponse = new Promise<{ status: number; body: string }>(resolve => { finishPost = resolve })
  setCodexResetApiCallForTests(async (_account, input) => {
    expect(input.method).toBe("POST")
    postCalls++
    postStarted()
    return pendingResponse
  })

  const attempt = redeemCodexReset(account, "use my codex reset")
  await started
  let drained = false
  const drain = drainGatewayExecutions(2_000).then(() => { drained = true })
  await Bun.sleep(25)
  expect(drained).toBe(false)
  expect(() => admitGatewayExecution()).toThrow("shutting down")
  finishPost({ status: 200, body: "{}" })
  await attempt
  await drain
  expect(drained).toBe(true)
  expect(postCalls).toBe(1)
})

async function runInAnotherWorkspace(callback: () => Promise<void>) {
  return runInWorkspace({ id: "codex-reset-other" }, callback)
}
