import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  compareAndDelete: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  setIfAbsent: vi.fn(),
}))

vi.mock("@/lib/local-redis", () => ({
  localRedisCompareAndDelete: mocks.compareAndDelete,
  localRedisDelete: mocks.delete,
  localRedisGet: mocks.get,
  localRedisSet: mocks.set,
  localRedisSetIfAbsent: mocks.setIfAbsent,
}))

import {
  deletePendingCliProxyCodexLogin,
  reservePendingCliProxyCodexLogin,
  savePendingCliProxyCodexLogin,
  takePendingCliProxyCodexLogin,
} from "@/lib/codex-cli-login"

beforeEach(() => {
  vi.clearAllMocks()
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
