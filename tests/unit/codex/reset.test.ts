import { afterEach, expect, jest, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInWorkspace } from "../../../packages/platform/src/server/workspace-context"
import { closeLocalDatabase } from "../../../packages/platform/src/server/database"
import * as audit from "../../../packages/platform/src/server/audit"
import { admitExecution, drainExecutions, resumeExecutions } from "../../../packages/gateway-ai/src/server/cliproxy/admission"
import type { ProviderApiKey } from "../../../packages/gateway-ai/src/contracts/domain"
import { upsertProvider, upsertProviderApiKey } from "../../../packages/gateway-ai/src/server/store"
import { PATCH as patchAutoRedeemSettings } from "../../../packages/gateway-ai/src/server/routes/api/admin/oauth-providers/auto-redeem"
import {
  checkCodexResetAutomatically,
  checkEnabledCodexAccountsAutomatically,
  completeCodexResetAccountRemoval,
  getCodexAutoRedeemSettings,
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

let workspaceSequence = 0
const workspaceTest = (name: string, callback: () => Promise<void>) => test(name, () => runInWorkspace({ id: `codex-reset-${++workspaceSequence}` }, callback))
const account: ProviderApiKey = {
  id: "reset-account",
  providerId: "codex",
  name: "Codex test account",
  key: "",
  credentialKind: "codex-cli-proxy",
  cliProxyAuthIndex: "auth-index",
  enabled: true,
  createdAt: new Date().toISOString(),
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
  resumeExecutions()
  resetCodexResetCoordinatorForTests()
  setCodexUsageApiCallForTests()
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
  process.env.CLIPROXY_MODE = "external"
  const provider = await upsertProvider({ name: "Codex", prefix: "codex", baseUrl: "https://chatgpt.com/backend-api/codex", protocol: "openai-responses", authType: "bearer", enabled: true })
  const mapped = await upsertProviderApiKey(provider.id, { name: account.name, key: "", credentialKind: "codex-cli-proxy", cliProxyAuthFile: "test.json", cliProxyAuthIndex: "auth-index", enabled: true })
  const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
  spyOn(fetchTarget, "fetch").mockImplementation(async () => Response.json({ files: [{ name: "test.json", type: "codex", auth_index: "auth-index", disabled: false }] }))
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
  expect((await getCodexResetAccountStatus(mapped.id))?.phase).toBe("redeemed")
})

workspaceTest("manual and automatic triggers share one persisted pending intent", async () => {
  configureUsage()
  setCodexResetApiCallForTests(async (_account, input) => {
    expect(input.method).toBe("POST")
    postCalls++
    const status = await getCodexResetAccountStatus(account.id)
    expect(status?.phase).toBe("pending")
    expect(status?.requestId).toBe(JSON.parse(input.data || "{}").redeem_request_id)
    await expect(reserveCodexResetAccountRemoval(account.id)).rejects.toThrow("in progress")
    return { status: 200, body: "{}" }
  })

  const results = await Promise.allSettled([
    redeemCodexReset(account, "Please use my Codex reset"),
    checkCodexResetAutomatically(account),
  ])
  expect(postCalls).toBe(1)
  expect(results.some(result => result.status === "fulfilled" && result.value?.ok === true)).toBe(true)
  expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("redeemed")

  const removal = await reserveCodexResetAccountRemoval(account.id)
  await completeCodexResetAccountRemoval(account.id, removal)
  expect(await getCodexResetAccountStatus(account.id)).toBeUndefined()
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
  try {
    await runInWorkspace(durableWorkspace, async () => {
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        throw new Error("connection closed")
      })
      await expect(redeemCodexReset(account, "use my codex reset")).rejects.toThrow("outcome is uncertain")
    })
    const beforeRestart = await runInWorkspace(durableWorkspace, () => getCodexResetAccountStatus(account.id))
    expect(beforeRestart?.phase).toBe("unknown")
    await closeLocalDatabase()

    await runInWorkspace(durableWorkspace, async () => {
      configureUsage()
      setCodexResetApiCallForTests(async () => {
        postCalls++
        return { status: 200, body: "{}" }
      })
      await checkCodexResetAutomatically(account)
      expect((await getCodexResetAccountStatus(account.id))?.phase).toBe("unknown")
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
    configureUsage()
    setCodexResetApiCallForTests(async () => {
      postCalls++
      return { status: 200, body: "{}" }
    })
    await updateCodexAutoRedeemSettings({ expiryEnabled: false, weeklyExhaustionEnabled: true })
    await checkCodexResetAutomatically(account)
    expect(postCalls).toBe(0)
    await closeLocalDatabase()
    resetCodexResetCoordinatorForTests()
    setCodexResetApiCallForTests(async () => {
      postCalls++
      return { status: 200, body: "{}" }
    })
    jest.setSystemTime(new Date(activatedAt + 59_999))
    await checkCodexResetAutomatically(account)
    expect(postCalls).toBe(0)
    jest.setSystemTime(new Date(activatedAt + 60_000))
    await checkCodexResetAutomatically(account)
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

workspaceTest("CLIProxy drain waits for an admitted reset POST", async () => {
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
  const drain = drainExecutions(2_000).then(() => { drained = true })
  await Bun.sleep(25)
  expect(drained).toBe(false)
  expect(() => admitExecution()).toThrow("draining")
  finishPost({ status: 200, body: "{}" })
  await attempt
  await drain
  expect(drained).toBe(true)
  expect(postCalls).toBe(1)
})

async function runInAnotherWorkspace(callback: () => Promise<void>) {
  return runInWorkspace({ id: "codex-reset-other" }, callback)
}
