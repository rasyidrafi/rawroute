import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeLocalDatabase, getDatabase, getSqliteDatabase } from "../../packages/platform/src/server/database"
import { createWorkspaceRepository, drainWorkspaceDeletions, type WorkspaceCleanupParticipant } from "../../packages/platform/src/server/workspace-repository"
import { runWithAuditIdentity, runWithGatewayAuditIdentity } from "../../packages/observability/src/server/audit-context"
import { appendAudit, queryAudit } from "../../packages/platform/src/server/audit"
import { attachWorkspaceActivity, reopenWorkspaceAdmission, retainWorkspaceActivity } from "../../packages/platform/src/server/workspace-activity"
import { runInWorkspace, runWithoutWorkspace, currentWorkspaceId } from "../../packages/platform/src/server/workspace-context"
import { closeLocalCache, localCacheDelete, localCacheGet, localCacheSetIfAbsent } from "../../packages/platform/src/server/local-cache"
import { trackBackgroundTask, drainBackgroundTasks } from "../../packages/platform/src/server/background-tasks"
import { _resetMemoryBackend, createApiKey, deleteApiKey, listApiKeys, listProviders, upsertProvider, upsertModel, upsertAlias, upsertProviderApiKey, deleteProviderApiKey, findIndexedApiKeyByValue } from "../../packages/gateway-ai/src/server/store"
import { cleanupAiWorkspaceResources } from "../../packages/gateway-ai/src/server/workspace-cleanup"
import { identity, createSession } from "../../packages/platform/src/server/runtime"
import { apiRoutes } from "../../apps/console/src/server/routes"
import { logs } from "../../packages/observability/src/server/store"
import { requestContext } from "../../packages/observability/src/server/request-context"
import { resetAnalyticsForTests, recordGatewayUsage, getDashboardPayload } from "../../packages/gateway-ai/src/server/analytics"
import { resetModelSharesForTests, setModelShareTargets, listSharedModelsForRecipient } from "../../packages/gateway-ai/src/server/model-shares"
import { resetWorkspacesForTests } from "../../packages/platform/src/server/runtime"
import { proxyGatewayRequest } from "../../packages/gateway-ai/src/server/cliproxy/gateway"
import { proxyAiOAuthCallback } from "../../packages/gateway-ai/src/server/oauth-callback"
import { redeemCodexReset } from "../../packages/gateway-ai/src/server/codex/reset"
import { POST as login } from "../../packages/platform/src/server/routes/api/auth/login/index"
import { POST as logout } from "../../packages/platform/src/server/routes/api/auth/logout/index"
import { POST as password } from "../../packages/platform/src/server/routes/api/admin/account/password/index"
import { runInRequest } from "../../packages/observability/src/server/request-context"
import { withManagementMutation, withLifecycleMutation } from "../../packages/gateway-ai/src/server/cliproxy/mutations"
import { reservePendingCliProxyCodexLogin, savePendingCliProxyCodexLogin, hasPendingCodexLogin, takePendingCliProxyCodexLogin } from "../../packages/gateway-ai/src/server/codex/cli-login"

let directory: string
const environment = { ...process.env }
const workspaceIds = new Set<string>()
beforeEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  directory = mkdtempSync(join(tmpdir(), "rawroute-lifecycle-"))
  process.env.SQLITE_PATH = join(directory, "test.sqlite")
  process.env.NODE_ENV = "test"
  process.env.CLIPROXY_MODE = "external"
  delete process.env.CLIPROXY_MANAGEMENT_KEY
  delete process.env.CLIPROXY_URL
  process.env.EXECUTOR_UPSTREAM_URL = "https://global-tools.invalid"
  process.env.EXECUTOR_UPSTREAM_API_KEY = "global-tool-secret-not-a-workspace-resource"
  _resetMemoryBackend()
  resetAnalyticsForTests()
  resetModelSharesForTests()
  identity.reset()
  globalThis.__rawrouteMemoryWorkspaces = new Map()
  globalThis.__rawrouteMemoryWorkspaceDeletions = new Map()
  globalThis.__rawrouteMemoryAudit = []
  globalThis.__rawroutePendingCodexCancellations = new Map()
  process.env.STORAGE_BACKEND = "memory"
  await resetWorkspacesForTests()
})
afterEach(async () => {
  await drainBackgroundTasks()
  await closeLocalDatabase()
  await closeLocalCache()
  for (const id of workspaceIds) reopenWorkspaceAdmission(id)
  workspaceIds.clear()
  rmSync(directory, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
  Object.assign(process.env, environment)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5))
function repository(participants: WorkspaceCleanupParticipant[] = [{ id: "ai", cleanup: cleanupAiWorkspaceResources }]) {
  return createWorkspaceRepository({ participants })
}
async function workspace(repo: ReturnType<typeof repository>, name: string) {
  const value = await repo.createWorkspace(name)
  workspaceIds.add(value.id)
  return value
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: repositories reject missing scope; Default is selected explicitly, identity is global`, async () => {
    process.env.STORAGE_BACKEND = backend
    await expect(listProviders()).rejects.toThrow("Workspace scope is required")
    await expect(createApiKey("must-not-write", "must-not-write-secret")).rejects.toThrow("Workspace scope is required")
    expect(() => currentWorkspaceId()).toThrow("Workspace scope is required")
    const repo = repository()
    await identity.readMeta()
    const selected = (await repo.listWorkspaces())[0]!
    expect(selected.id).toBe("default")
    expect(await runInWorkspace(selected, listApiKeys)).toHaveLength(1)
    expect(await findIndexedApiKeyByValue("must-not-write-secret")).toBeUndefined()
  })

  test(`${backend}: configuration, keys, and usage remain isolated between two workspaces`, async () => {
    process.env.STORAGE_BACKEND = backend
    const repo = repository()
    const first = await workspace(repo, "First")
    const second = await workspace(repo, "Second")
    await runInWorkspace(first, async () => {
      await upsertProvider({ name: "Private provider", prefix: "private", protocol: "openai-chat", baseUrl: "https://provider.invalid", authType: "none", enabled: true })
      const key = await createApiKey("Private key", "first-secret")
      await recordGatewayUsage({ gatewayKeyId: key.id, gatewayModelId: "private/model", protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 7, output: 2 } })
    })
    await runInWorkspace(second, async () => {
      expect(await listProviders()).toEqual([])
      expect(await listApiKeys()).toEqual([])
      expect((await getDashboardPayload({ preset: "all" })).summary.requests).toBe(0)
      await createApiKey("Second key", "second-secret")
    })
    expect((await runInWorkspace(first, () => getDashboardPayload({ preset: "all" }))).summary.tokens).toBe(9)
    expect((await findIndexedApiKeyByValue("second-secret"))?.workspaceId).toBe(second.id)
    expect(await identity.readMeta()).toHaveProperty("admin")
  })

  test(`${backend}: deletion checkpoints successes, redacts failures, recovers after restart and coalesces retries`, async () => {
    process.env.STORAGE_BACKEND = backend
    let firstCalls = 0
    let secondCalls = 0
    let fail = true
    const participants = [
      { id: "first", cleanup: async (id: string) => { firstCalls += 1; await cleanupAiWorkspaceResources(id) } },
      { id: "second", cleanup: async () => { secondCalls += 1; if (fail) throw new Error("credential=never-persist-this") } },
    ]
    const repo = repository(participants)
    const selected = await workspace(repo, "Recovery")
    await runInWorkspace(selected, () => createApiKey("Before failure", "before-failure-key"))
    await expect(repo.deleteWorkspace(selected.id, selected.name)).rejects.toThrow("never-persist-this")
    expect((await repo.getWorkspace(selected.id))?.status).toBe("deleting")
    expect(() => runInWorkspace(selected, currentWorkspaceId)).toThrow("unavailable")
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)
    expect(await findIndexedApiKeyByValue("before-failure-key")).toBeUndefined()
    expect(JSON.stringify(await queryAudit({ workspaceId: selected.id }))).not.toContain("never-persist-this")
    await closeLocalDatabase()
    await closeLocalCache()
    fail = false
    const restarted = repository(participants)
    await Promise.all([restarted.recoverWorkspaceDeletions(), restarted.deleteWorkspace(selected.id, selected.name), restarted.deleteWorkspace(selected.id, selected.name)])
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(2)
    expect(await restarted.getWorkspace(selected.id)).toBeUndefined()
    await restarted.deleteWorkspace(selected.id, selected.name)
    expect(secondCalls).toBe(2)
    const events = await queryAudit({ workspaceId: selected.id })
    expect(events.filter(event => event.action === "workspace.delete.complete")).toHaveLength(1)
    expect(events.some(event => event.action === "workspace.delete.failure" && event.result === "failure")).toBe(true)
    await expect(restarted.deleteWorkspace("default", "Default")).rejects.toThrow("cannot be deleted")
  })

  test(`${backend}: deletion drains in-flight requests and background settlement before cleanup, without changing global Tools`, async () => {
    process.env.STORAGE_BACKEND = backend
    const repo = repository()
    const selected = await workspace(repo, "Drain")
    const gate = deferred()
    let settled = false
    await runInWorkspace(selected, async () => {
      await createApiKey("Before", "before-drain-secret")
      void trackBackgroundTask(gate.promise.then(async () => {
        // Still-admitted accounting may write while deleting; cleanup follows it.
        await createApiKey("Settlement", "settlement-secret")
        settled = true
      }))
    })
    let deleted = false
    const deletion = repo.deleteWorkspace(selected.id, selected.name).then(() => { deleted = true })
    await tick()
    expect(deleted).toBe(false)
    await expect(repo.deleteWorkspace(selected.id, "wrong-name-during-drain")).rejects.toThrow("does not match")
    expect(() => runInWorkspace(selected, currentWorkspaceId)).toThrow("unavailable")
    gate.resolve()
    await deletion
    expect(settled).toBe(true)
    expect(await findIndexedApiKeyByValue("before-drain-secret")).toBeUndefined()
    expect(await findIndexedApiKeyByValue("settlement-secret")).toBeUndefined()
    expect(process.env.EXECUTOR_UPSTREAM_URL).toBe("https://global-tools.invalid")
    expect(process.env.EXECUTOR_UPSTREAM_API_KEY).toBe("global-tool-secret-not-a-workspace-resource")
    if (backend === "sqlite") expect((await getSqliteDatabase().collection(`rawroute_workspaces/${selected.id}/apiKeys`).get()).docs).toHaveLength(0)
  })

  test(`${backend}: shared owner admission survives consumer stream monitoring until owner accounting settles`, async () => {
    process.env.STORAGE_BACKEND = backend
    const repo = repository()
    const owner = await workspace(repo, "Owner")
    const consumer = await workspace(repo, "Consumer")
    const gate = deferred()
    let monitoring!: Promise<void>
    await runInWorkspace(consumer, async () => {
      attachWorkspaceActivity(owner.id)
      monitoring = retainWorkspaceActivity(gate.promise.then(async () => {
        await runInWorkspace(owner, () => createApiKey("Late owner accounting", "owner-accounting-secret"))
      }))
    })
    let deleted = false
    const deletion = repo.deleteWorkspace(owner.id, owner.name).then(() => { deleted = true })
    await tick()
    expect(deleted).toBe(false)
    gate.resolve()
    await monitoring
    await deletion
    expect(await findIndexedApiKeyByValue("owner-accounting-secret")).toBeUndefined()
    expect((await repo.getWorkspace(consumer.id))?.status).toBe("active")
  })

  test(`${backend}: audit is server-derived, redacted, survives log clearing and database reopen`, async () => {
    process.env.STORAGE_BACKEND = backend
    const repo = repository()
    const selected = await workspace(repo, "Audit")
    await runWithAuditIdentity("administrator", "audit-correlation", () => runInWorkspace(selected, async () => {
      const key = await createApiKey("secret-in-name", "secret-in-key-value")
      await deleteApiKey(key.id)
      logs.clear(requestContext().logScope)
    }))
    const before = await queryAudit({ workspaceId: selected.id })
    expect(before.some(event => event.action === "credential.create" && event.actor === "administrator" && event.correlationId === "audit-correlation")).toBe(true)
    expect(before.some(event => event.action === "credential.revoke")).toBe(true)
    expect(JSON.stringify(before)).not.toContain("secret-in-")
    await closeLocalDatabase()
    await closeLocalCache()
    const after = await queryAudit({ workspaceId: selected.id })
    expect(new Set(after.map(event => event.id))).toEqual(new Set(before.map(event => event.id)))
    expect(after.every(event => typeof event.correlationId === "string")).toBe(true)
  })

  test(`${backend}: failed identity mutation rolls back and emits no successful audit`, async () => {
    process.env.STORAGE_BACKEND = backend
    const before = await identity.readMeta()
    const auditBefore = (await queryAudit()).length
    await expect(identity.updateMeta(meta => { meta.admin.mustChangePassword = false; throw new Error("do-not-audit-this-secret") })).rejects.toThrow("do-not-audit-this-secret")
    expect(await identity.readMeta()).toEqual(before)
    expect((await queryAudit()).length).toBe(auditBefore)
  })

  test(`${backend}: HTTP/global isolation cannot inherit a closed admission; deletion cannot drain itself`, async () => {
    process.env.STORAGE_BACKEND = backend
    const repo = repository()
    const selected = await workspace(repo, "Admission isolation")
    await runInWorkspace(selected, async () => {
      await expect(repo.deleteWorkspace(selected.id, selected.name)).rejects.toThrow("outside its admitted activity")
      expect(() => runWithoutWorkspace(currentWorkspaceId)).toThrow("Workspace scope is required")
    })
    await repo.deleteWorkspace(selected.id, selected.name)
    expect(await repo.getWorkspace(selected.id)).toBeUndefined()
  })

  test(`${backend}: workspace create/rename/confirmation failures are durably audited without supplied values`, async () => {
    process.env.STORAGE_BACKEND = backend
    const repo = repository()
    const selected = await workspace(repo, "Private workspace name")
    await expect(repo.createWorkspace(selected.name)).rejects.toThrow("already in use")
    await expect(repo.renameWorkspace("default", "private-supplied-name")).rejects.toThrow("cannot be renamed")
    await expect(repo.deleteWorkspace(selected.id, "private-confirmation")).rejects.toThrow("does not match")
    const events = await queryAudit({ limit: 1000 })
    expect(events.some(event => event.action === "workspace.create" && event.result === "failure")).toBe(true)
    expect(events.some(event => event.action === "workspace.rename" && event.result === "failure")).toBe(true)
    expect(events.some(event => event.action === "workspace.delete.failure" && event.workspaceId === selected.id)).toBe(true)
    expect(JSON.stringify(events)).not.toContain("private-")
    expect(JSON.stringify(events)).not.toContain(selected.name)
    expect((await repo.getWorkspace(selected.id))?.status).toBe("active")
  })

  test(`${backend}: actual authentication/password/logout and provider credential paths emit safe audits`, async () => {
    process.env.STORAGE_BACKEND = backend
    const request = (body: object, cookie?: string) => new Request("https://console.test/api", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
    expect((await runInRequest(() => login(request({ password: "wrong-sensitive-password" })))).status).toBe(401)
    const authenticated = await runInRequest(() => login(request({ password: "123456" })))
    expect(authenticated.status).toBe(200)
    const cookie = authenticated.headers.get("set-cookie")!.split(";", 1)[0]!
    expect((await runWithAuditIdentity("administrator", "password-failure", () => password(request({ password: "short" })))).status).toBe(400)
    expect((await runWithAuditIdentity("administrator", "password-change", () => password(request({ password: "new-sensitive-password" })))).status).toBe(200)
    expect((await runInRequest(() => logout(request({}, cookie)))).status).toBe(200)
    const repo = repository()
    const selected = await workspace(repo, "Provider credentials")
    await runWithAuditIdentity("administrator", "provider-credentials", () => runInWorkspace(selected, async () => {
      const provider = await upsertProvider({ name: "provider-sensitive-name", prefix: "provider", baseUrl: "https://provider.invalid", protocol: "openai-chat", authType: "bearer", enabled: true })
      const key = await upsertProviderApiKey(provider.id, { name: "credential-sensitive-name", key: "provider-sensitive-key", enabled: true })
      await deleteProviderApiKey(provider.id, key.id)
    }))
    const events = await queryAudit({ limit: 1000 })
    expect(events.some(event => event.action === "auth.login" && event.result === "failure")).toBe(true)
    expect(events.some(event => event.action === "auth.login" && event.result === "success" && event.actor === "administrator")).toBe(true)
    expect(events.some(event => event.action === "auth.logout" && event.actor === "administrator")).toBe(true)
    expect(events.some(event => event.action === "auth.password" && event.result === "failure")).toBe(true)
    expect(events.some(event => event.action === "auth.password" && event.result === "success" && event.correlationId === "password-change")).toBe(true)
    expect(events.some(event => event.action === "credential.create" && event.resource === "provider-credential")).toBe(true)
    expect(events.some(event => event.action === "credential.revoke" && event.resource === "provider-credential")).toBe(true)
    expect(JSON.stringify(events)).not.toContain("sensitive")
  })
}

test("SQLite audit failure rolls back credentials, workspace creation, and identity mutations atomically", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  const repo = repository()
  const selected = await workspace(repo, "Rollback")
  await repo.listWorkspaces()
  await identity.readMeta()
  const before = await identity.readMeta()
  getDatabase().run("CREATE TRIGGER reject_audit BEFORE INSERT ON rawroute_documents WHEN NEW.collection_path = 'rawroute_audit' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  await expect(runInWorkspace(selected, () => createApiKey("Rejected", "rollback-key-secret"))).rejects.toThrow("audit unavailable")
  expect(await runInWorkspace(selected, listApiKeys)).toEqual([])
  expect(await findIndexedApiKeyByValue("rollback-key-secret")).toBeUndefined()
  await expect(repo.createWorkspace("Not created")).rejects.toThrow("audit unavailable")
  expect((await repo.listWorkspaces()).some(value => value.name === "Not created")).toBe(false)
  await expect(identity.updateMeta(meta => { meta.sessionSecret = "must-not-commit" })).rejects.toThrow("audit unavailable")
  expect(await identity.readMeta()).toEqual(before)
  await expect(repo.deleteWorkspace(selected.id, selected.name)).rejects.toThrow("audit unavailable")
  expect((await repo.getWorkspace(selected.id))?.status).toBe("active")
  expect(await runInWorkspace(selected, listApiKeys)).toEqual([])
  getDatabase().run("DROP TRIGGER reject_audit")
  await appendAudit({ action: "auth.login", resource: "administrator", result: "failure" })
})

test("SQLite rejects captured late writes and restored tombstones prevent new admission after restart", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  const repo = repository()
  const selected = await workspace(repo, "Late writes")
  const ref = getSqliteDatabase().collection(`rawroute_workspaces/${selected.id}/providers`).doc("late")
  const gate = deferred()
  let late!: Promise<void>
  runInWorkspace(selected, () => { late = gate.promise.then(() => ref.set({ name: "must-not-recreate" })) })
  await repo.deleteWorkspace(selected.id, selected.name)
  gate.resolve()
  await expect(late).rejects.toThrow("settled")
  await expect(ref.set({ name: "must-not-recreate" })).rejects.toThrow("unavailable")
  await closeLocalDatabase()
  await closeLocalCache()
  reopenWorkspaceAdmission(selected.id)
  const restarted = repository()
  await restarted.recoverWorkspaceDeletions()
  expect(() => runInWorkspace(selected, currentWorkspaceId)).toThrow("unavailable")
  expect((await ref.get()).exists).toBe(false)
})

test("remote mutation boundaries persist intent and redacted outcomes, including returned HTTP failures", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  await runWithAuditIdentity("administrator", "remote-security", async () => {
    await expect(withManagementMutation(async () => { throw new Error("remote-secret-must-not-appear") })).rejects.toThrow("remote-secret")
    await withManagementMutation(async () => Response.json({ error: "private response" }, { status: 400 }))
    await withLifecycleMutation(async () => "installed")
  })
  const events = await queryAudit()
  expect(events.filter(event => event.action === "oauth.remote" && event.result === "started")).toHaveLength(2)
  expect(events.filter(event => event.action === "oauth.remote" && event.result === "failure")).toHaveLength(2)
  expect(events.some(event => event.action === "cliproxy.lifecycle" && event.result === "success")).toBe(true)
  expect(events.every(event => event.actor === "administrator" && event.correlationId === "remote-security")).toBe(true)
  expect(JSON.stringify(events)).not.toContain("remote-secret")
  expect(JSON.stringify(events)).not.toContain("private response")
  getDatabase().run("CREATE TRIGGER reject_remote_audit BEFORE INSERT ON rawroute_documents WHEN NEW.collection_path = 'rawroute_audit' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  let mutated = false
  await expect(withManagementMutation(async () => { mutated = true })).rejects.toThrow("audit unavailable")
  expect(mutated).toBe(false)
})

test("gateway audit identity uses the verified opaque record ID and retains server correlation", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  await runWithAuditIdentity("anonymous", "server-correlation", () => runWithGatewayAuditIdentity("verified-key-record-id", () => appendAudit({ action: "config.update", resource: "routing", result: "success" })))
  expect((await queryAudit())[0]).toMatchObject({ actor: "gateway", actorId: "verified-key-record-id", correlationId: "server-correlation", resource: "routing" })
})

test("canonical upstream OAuth callbacks audit intent/outcome without code, state, URL, or response content", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.CLIPROXY_URL = "https://isolated-callback.invalid"
  const target: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
  const upstream = spyOn(target, "fetch").mockImplementation(async () => new Response("private-upstream-token", { status: 200 }))
  try {
    for (const path of ["/anthropic/callback", "/antigravity/callback", "/codex/callback"] as const) {
      const response = await runInRequest(() => proxyAiOAuthCallback(new Request(`https://console.test${path}?code=private-code&state=private-state`), path))
      expect(await response.text()).toBe("private-upstream-token")
    }
    const events = await queryAudit()
    expect(events.filter(event => event.action === "oauth.remote" && event.result === "started")).toHaveLength(3)
    expect(events.filter(event => event.action === "oauth.remote" && event.result === "success")).toHaveLength(3)
    expect(events.every(event => event.actor === "anonymous" && event.workspaceId === undefined)).toBe(true)
    expect(JSON.stringify(events)).not.toContain("private-")
    getDatabase().run("CREATE TRIGGER reject_callback_audit BEFORE INSERT ON rawroute_documents WHEN NEW.collection_path = 'rawroute_audit' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    await expect(proxyAiOAuthCallback(new Request("https://console.test/codex/callback?code=private-code"), "/codex/callback")).rejects.toThrow("audit unavailable")
    expect(upstream).toHaveBeenCalledTimes(3)
  } finally { upstream.mockRestore() }
})

test("Codex reset-credit consumption is audited before the remote financial mutation", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.CLIPROXY_URL = "https://isolated-reset.invalid"
  const repo = repository()
  const selected = await workspace(repo, "Reset credit")
  let consumed = 0
  const target: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
  const upstream = spyOn(target, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string }
    if (body.method === "POST") {
      consumed += 1
      return Response.json({ status_code: 200, body: "private-reset-response" })
    }
    return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit_reset_credits: { available_count: 1 }, rate_limit: { secondary_window: { used_percent: 100 } } }) })
  })
  const account = { id: "opaque-account-id", providerId: "opaque-provider-id", name: "private-account-name", key: "", enabled: true, createdAt: new Date().toISOString(), credentialKind: "codex-cli-proxy" as const, cliProxyAuthIndex: "private-auth-index" }
  try {
    await runWithAuditIdentity("administrator", "reset-credit", () => runInWorkspace(selected, () => redeemCodexReset(account, "use my codex reset")))
    expect(consumed).toBe(1)
    const events = await queryAudit({ workspaceId: selected.id })
    expect(events.some(event => event.action === "oauth.remote" && event.resource === "oauth" && event.result === "started")).toBe(true)
    expect(events.some(event => event.action === "oauth.remote" && event.result === "success" && event.correlationId === "reset-credit")).toBe(true)
    expect(JSON.stringify(events)).not.toContain("private-")
    getDatabase().run("CREATE TRIGGER reject_reset_audit BEFORE INSERT ON rawroute_documents WHEN NEW.collection_path = 'rawroute_audit' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    await expect(runInWorkspace(selected, () => redeemCodexReset(account, "use my codex reset"))).rejects.toThrow("audit unavailable")
    expect(consumed).toBe(1)
  } finally { upstream.mockRestore() }
})

test("shutdown drains workspace coordinators even when no HTTP request remains attached", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  const gate = deferred()
  const repo = repository([{ id: "cleanup", cleanup: () => gate.promise }])
  const selected = await workspace(repo, "Shutdown drain")
  const deletion = repo.deleteWorkspace(selected.id, selected.name)
  let drained = false
  const drain = drainWorkspaceDeletions().then(() => { drained = true })
  await tick()
  expect(drained).toBe(false)
  gate.resolve()
  await Promise.all([deletion, drain])
  expect(drained).toBe(true)
  expect(await repo.getWorkspace(selected.id)).toBeUndefined()
})

test("concrete AI cleanup deletes only mapped OAuth resources and pending login; leaves shared engine and Tools alone", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.CLIPROXY_MANAGEMENT_KEY = "isolated-management-secret"
  process.env.CLIPROXY_URL = "https://isolated-cliproxy.invalid"
  const repo = repository()
  const selected = await workspace(repo, "OAuth cleanup")
  await runInWorkspace(selected, async () => {
    const provider = await upsertProvider({ name: "Codex", prefix: "codex", protocol: "openai-chat", authType: "none", enabled: true })
    await upsertProviderApiKey(provider.id, { name: "Mapped", key: "", credentialKind: "codex-cli-proxy", cliProxyAuthFile: "only-owned-file.json", enabled: true })
    await reservePendingCliProxyCodexLogin("owned-login")
    await savePendingCliProxyCodexLogin("owned-login", { workspaceId: selected.id, state: "only-owned-state", authFiles: {} })
  })
  const calls: string[] = []
  const target: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
  const upstream = spyOn(target, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method || "GET"} ${url}`)
    expect(url.startsWith("https://isolated-cliproxy.invalid/")).toBe(true)
    return new Response(null, { status: 404 }) // Idempotent already-removed resources.
  })
  try {
    await repo.deleteWorkspace(selected.id, selected.name)
    expect(calls).toHaveLength(2)
    expect(calls.some(call => call.includes("auth-files?name=only-owned-file.json"))).toBe(true)
    expect(calls.some(call => call.includes("oauth-session?state=only-owned-state"))).toBe(true)
    expect(await hasPendingCodexLogin()).toBe(false)
    expect(process.env.EXECUTOR_UPSTREAM_URL).toBe("https://global-tools.invalid")
    expect((await queryAudit({ workspaceId: selected.id })).some(event => event.action === "workspace.delete.complete")).toBe(true)
    expect(JSON.stringify(await queryAudit())).not.toContain("only-owned")
  } finally { upstream.mockRestore() }
})

test("SQLite retries idempotently when participant side effects succeed but its durable checkpoint fails", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  let calls = 0
  const repo = repository([{ id: "ai", cleanup: async id => { calls += 1; await cleanupAiWorkspaceResources(id) } }])
  const selected = await workspace(repo, "Checkpoint failure")
  await runInWorkspace(selected, () => createApiKey("Revoke", "checkpoint-key"))
  getDatabase().run("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON rawroute_documents WHEN NEW.collection_path = 'rawroute_workspace_deletions' AND json_array_length(NEW.data, '$.completed') > 0 BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END")
  await expect(repo.deleteWorkspace(selected.id, selected.name)).rejects.toThrow("checkpoint failed")
  expect((await repo.getWorkspace(selected.id))?.status).toBe("deleting")
  expect(await findIndexedApiKeyByValue("checkpoint-key")).toBeUndefined()
  getDatabase().run("DROP TRIGGER reject_checkpoint")
  await repo.deleteWorkspace(selected.id, selected.name)
  expect(calls).toBe(2)
  expect(await repo.getWorkspace(selected.id)).toBeUndefined()
  expect((await queryAudit({ workspaceId: selected.id })).filter(event => event.action === "workspace.delete.complete")).toHaveLength(1)
})

test("real shared native SSE settles both usage copies before owner deletion and never recreates owner records", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  const repo = repository()
  const owner = await workspace(repo, "Streaming owner")
  const consumer = await workspace(repo, "Streaming consumer")
  const model = await runInWorkspace(owner, async () => {
    const provider = await upsertProvider({ name: "Native", prefix: "native", baseUrl: "https://native-provider.invalid/v1", protocol: "openai-responses", authType: "none", enabled: true })
    return upsertModel(provider.id, { name: "Stream", gatewayModelId: "native/stream", upstreamModel: "stream", enabled: true })
  })
  await runInWorkspace(owner, () => setModelShareTargets(model.id, [consumer.id]))
  const key = await runInWorkspace(consumer, async () => {
    const share = (await listSharedModelsForRecipient())[0]!
    await upsertAlias({ alias: "streaming", name: "Streaming alias", targetModelId: share.qualifiedModelId, sharedModelId: share.id })
    return createApiKey("Streaming consumer", "streaming-consumer-key")
  })
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const target: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
  const upstream = spyOn(target, "fetch").mockImplementation(async input => {
    expect(String(input).startsWith("https://native-provider.invalid/")).toBe(true)
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { "content-type": "text/event-stream" } })
  })
  try {
    const response = await proxyGatewayRequest(new Request("https://gateway.test/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "streaming", input: "Hello", stream: true }) }))
    expect(response.status).toBe(200)
    let deleted = false
    const deletion = repo.deleteWorkspace(owner.id, owner.name).then(() => { deleted = true })
    await tick()
    expect(deleted).toBe(false)
    stream.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n'))
    stream.close()
    await response.text()
    await drainBackgroundTasks()
    await deletion
    expect(await repo.getWorkspace(owner.id)).toBeUndefined()
    expect((await getSqliteDatabase().collection(`rawroute_workspaces/${owner.id}/usageEvents`).get()).docs).toHaveLength(0)
    const consumerUsage = await runInWorkspace(consumer, () => getDashboardPayload({ preset: "all" }))
    expect(consumerUsage.summary.requests).toBe(1)
    expect(consumerUsage.summary.tokens).toBe(4)
    expect(upstream).toHaveBeenCalledTimes(1)
  } finally { upstream.mockRestore() }
})

test("SQLite recovery retries attributed OAuth cancellation after interaction expiry and database/cache restart", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.CLIPROXY_URL = "https://isolated-login.invalid"
  process.env.CLIPROXY_MANAGEMENT_KEY = "isolated-login-management-key"
  await identity.readMeta()
  await identity.updateMeta(meta => { meta.admin.mustChangePassword = false })
  const repo = repository()
  const selected = await workspace(repo, "Durable pending login")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes: apiRoutes, fetch: () => new Response(null, { status: 404 }) })
  const cookie = (await createSession(new Request(server.url))).split(";", 1)[0]!
  let cancellations = 0
  let failCancellation = true
  const target: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
  const originalFetch = globalThis.fetch
  const upstream = spyOn(target, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    if (!url.startsWith("https://isolated-login.invalid/")) return originalFetch(input, init)
    if (url.includes("/auth-files")) return Response.json({ files: [] })
    if (url.includes("/codex-auth-url")) return Response.json({ state: "private-durable-oauth-state", url: "https://auth.invalid/?state=private-durable-oauth-state" })
    expect(url).toContain("/oauth-session?state=private-durable-oauth-state")
    cancellations += 1
    return new Response(null, { status: failCancellation ? 503 : 404 })
  })
  try {
    const response = await fetch(new URL("/api/admin/oauth-providers/codex/device/start", server.url), { method: "POST", headers: { cookie, "x-rawroute-workspace-id": selected.id } })
    expect(response.status).toBe(200)
    const { loginId } = await response.json() as { loginId: string }
    expect(await hasPendingCodexLogin()).toBe(true)
    const cacheKey = `rawroute:codex-login:v2:session:${loginId}`
    const cached = JSON.parse((await localCacheGet(cacheKey))!) as { expiresAt: number }
    cached.expiresAt = Date.now() - 1
    await localCacheDelete(cacheKey)
    await localCacheSetIfAbsent(cacheKey, JSON.stringify(cached), 60_000)
    expect(await takePendingCliProxyCodexLogin(loginId)).toBeUndefined()
    expect(await hasPendingCodexLogin()).toBe(false) // Existing five-minute interaction/lock semantics.
    const ref = getSqliteDatabase().collection("rawroute_codex_login_cancellations").doc(loginId)
    expect((await ref.get()).data()).toMatchObject({ workspaceId: selected.id, state: "private-durable-oauth-state" })
    await expect(repo.deleteWorkspace(selected.id, selected.name)).rejects.toThrow("503")
    expect(cancellations).toBe(1)
    expect((await repo.getWorkspace(selected.id))?.status).toBe("deleting")
    expect((await ref.get()).exists).toBe(true)
    await server.stop(true)
    await closeLocalDatabase()
    await closeLocalCache()
    failCancellation = false
    const restarted = repository()
    const recovery = await restarted.recoverWorkspaceDeletions()
    expect(recovery.every(result => result.status === "fulfilled")).toBe(true)
    expect(cancellations).toBe(2)
    expect((await ref.get()).exists).toBe(false)
    expect(await restarted.getWorkspace(selected.id)).toBeUndefined()
    const events = await queryAudit({ workspaceId: selected.id, limit: 1000 })
    expect(events.some(event => event.action === "workspace.delete.failure")).toBe(true)
    expect(events.some(event => event.action === "workspace.delete.complete")).toBe(true)
    expect(JSON.stringify(await queryAudit({ limit: 1000 }))).not.toContain("private-durable-oauth-state")
  } finally { upstream.mockRestore(); await server.stop(true) }
})

test("authenticated canonical password endpoint audits malformed JSON/null and fails closed if audit is unavailable", async () => {
  process.env.STORAGE_BACKEND = "sqlite"
  const before = await identity.readMeta()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes: apiRoutes, fetch: () => new Response(null, { status: 404 }) })
  const cookie = (await createSession(new Request(server.url))).split(";", 1)[0]!
  try {
    const requests: string[] = []
    for (const body of ['{"password":"private-malformed-password"', "null"]) {
      const response = await fetch(new URL("/api/admin/account/password", server.url), { method: "POST", headers: { cookie, "content-type": "application/json" }, body })
      expect(response.status).toBe(400)
      requests.push(response.headers.get("x-request-id")!)
      expect(await response.json()).toEqual({ error: { message: "Invalid request." } })
    }
    await closeLocalDatabase()
    const failures = (await queryAudit({ limit: 1000 })).filter(event => event.action === "auth.password" && event.result === "failure")
    expect(failures).toHaveLength(2)
    expect(failures.every(event => event.actor === "administrator" && !event.workspaceId)).toBe(true)
    expect(new Set(failures.map(event => event.correlationId))).toEqual(new Set(requests))
    expect(JSON.stringify(failures)).not.toContain("private-malformed-password")
    expect(await identity.readMeta()).toEqual(before)
    getDatabase().run("CREATE TRIGGER reject_malformed_password_audit BEFORE INSERT ON rawroute_documents WHEN NEW.collection_path = 'rawroute_audit' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    for (const body of ["{", "null"]) {
      const response = await fetch(new URL("/api/admin/account/password", server.url), { method: "POST", headers: { cookie, "content-type": "application/json" }, body })
      expect(response.status).toBe(500)
      await response.body?.cancel()
    }
    expect(await identity.readMeta()).toEqual(before)
  } finally { await server.stop(true) }
})
