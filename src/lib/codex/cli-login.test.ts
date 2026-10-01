import { beforeEach, expect, test, mock } from "bun:test"

const mocks = {
  compareAndDelete: mock(),
  delete: mock(),
  get: mock(),
  set: mock(),
  setIfAbsent: mock(),
}

mock.module("@/lib/local-redis", () => ({
  localRedisCompareAndDelete: mocks.compareAndDelete,
  localRedisDelete: mocks.delete,
  localRedisGet: mocks.get,
  localRedisSet: mocks.set,
  localRedisSetIfAbsent: mocks.setIfAbsent,
}))

const {
  deletePendingCliProxyCodexLogin,
  reservePendingCliProxyCodexLogin,
  savePendingCliProxyCodexLogin,
  takePendingCliProxyCodexLogin,
} = await import("@/lib/codex/cli-login")

beforeEach(() => {
  mock.clearAllMocks()
  mocks.compareAndDelete.mockResolvedValue(true)
  mocks.delete.mockResolvedValue(true)
  mocks.set.mockResolvedValue(true)
  mocks.setIfAbsent.mockResolvedValue(true)
})

test("rejects concurrent or unsafe login reservations", async () => {
  mocks.setIfAbsent.mockResolvedValueOnce(false)
  await expect(reservePendingCliProxyCodexLogin("login-b")).rejects.toThrow("already in progress")

  mocks.setIfAbsent.mockResolvedValueOnce(undefined)
  await expect(reservePendingCliProxyCodexLogin("login-c")).rejects.toThrow("Redis is required")
})

test("persists and restores a workspace-bound CLIProxy state", async () => {
  await savePendingCliProxyCodexLogin("login-a", {
    state: "oauth-state",
    workspaceId: "workspace-a",
    authFiles: { "existing.json": "signature" },
  })
  const stored = JSON.parse(String(mocks.set.mock.calls[0][1]))
  mocks.get.mockResolvedValue(JSON.stringify(stored))

  await expect(takePendingCliProxyCodexLogin("login-a")).resolves.toMatchObject({
    state: "oauth-state",
    workspaceId: "workspace-a",
    authFiles: { "existing.json": "signature" },
  })
})

test("releases only the caller-owned global login lock", async () => {
  await deletePendingCliProxyCodexLogin("login-a")
  expect(mocks.compareAndDelete).toHaveBeenCalledWith("rawroute:codex-login:v2:active", "login-a")
})
