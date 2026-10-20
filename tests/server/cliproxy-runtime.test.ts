import { beforeEach, expect, mock, test } from "bun:test"
import type { CliproxyStatus } from "../../packages/gateway-ai/src/contracts/cliproxy"
import { currentWorkspaceId } from "../../packages/platform/src/server/workspace-context"
import { activeExecutions, admitExecution } from "../../packages/gateway-ai/src/server/cliproxy/admission"

const origin = "http://localhost:3000"
process.env.CLIPROXY_MODE = "managed"
process.env.RAWROUTE_PUBLIC_URL = origin
const stopped: CliproxyStatus = {
  installed: true, version: "7.3.4", pinnedVersion: "7.3.4", desiredRunning: false,
  processRunning: false, healthy: false, conflict: false, operation: null, restartAttempts: 0, lastError: null,
}
const state = { ...stopped }
const start = mock(async () => { Object.assign(state, { desiredRunning: true, processRunning: true, healthy: true }) })
const service = {
  initCliproxy: async () => undefined,
  registerCliproxyRecoveryReconciler: () => undefined,
  getStatus: async () => ({ ...state }),
  install: mock(async (version: string) => { state.version = version; state.pinnedVersion = version; return version }),
  start,
  restart: start,
  stop: async () => { Object.assign(state, { desiredRunning: false, processRunning: false, healthy: false }) },
}
const synced: Array<{ providerId: string; workspaceId: string }> = []
const reconcile = mock(async (providerId: string) => {
  if (!state.healthy) throw new Error("Connection refused: stopped engine")
  synced.push({ providerId, workspaceId: currentWorkspaceId() })
})
mock.module("../../packages/gateway-ai/src/server/cliproxy/service-module", () => ({ managedService: async () => service }))
mock.module("../../packages/gateway-ai/src/server/codex/cli-login", () => ({ hasPendingCodexLogin: async () => false }))
mock.module("../../packages/gateway-ai/src/server/cliproxy/transport", () => ({ cliProxyHealth: async () => false }))
mock.module("../../packages/gateway-ai/src/server/logging", () => ({ recordLog: () => undefined }))
mock.module("../../packages/platform/src/server/runtime", () => ({
  listWorkspaces: async () => [{ id: "workspace-a", status: "active" }, { id: "workspace-b", status: "active" }],
  readMeta: async () => ({ admin: { mustChangePassword: false } }),
}))
mock.module("../../packages/gateway-ai/src/server/store", () => ({
  listProviders: async () => [{ id: "provider-a", prefix: "openai" }, { id: "codex", prefix: "codex" }],
}))
mock.module("../../packages/gateway-ai/src/server/cliproxy/provider-sync", () => ({ invalidateProviderProjections: () => undefined, syncNonCodexProviderProjection: reconcile }))
const { initializeInstance, runInstanceAction } = await import("../../packages/gateway-ai/src/server/cliproxy/runtime")
const { lifecycle } = await import("../../packages/gateway-ai/src/server/cliproxy/http")
await initializeInstance()

beforeEach(() => {
  process.env.CLIPROXY_MODE = "managed"
  process.env.RAWROUTE_PUBLIC_URL = origin
  Object.assign(state, stopped)
  synced.length = 0
  mock.clearAllMocks()
})

test("installing a release on a stopped instance succeeds without contacting its management API", async () => {
  const response = await lifecycle(new Request(`${origin}/api/admin/cliproxy/service/install`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ version: "7.3.5" }),
  }), { action: "install" })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, version: "7.3.5" })
  expect(state).toMatchObject({ version: "7.3.5", desiredRunning: false, processRunning: false })
  expect(reconcile).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
  const release = admitExecution()
  release()
  expect(activeExecutions()).toBe(0)
})

for (const action of ["start", "restart", "install"] as const) {
  test(`${action} reconciles the providers of each workspace when the resulting instance is healthy`, async () => {
    if (action === "install") Object.assign(state, { healthy: true, processRunning: true, desiredRunning: true })
    await runInstanceAction(action, action === "install" ? "7.3.5" : undefined)
    expect(synced).toEqual([
      { providerId: "provider-a", workspaceId: "workspace-a" },
      { providerId: "provider-a", workspaceId: "workspace-b" },
    ])
  })
}
