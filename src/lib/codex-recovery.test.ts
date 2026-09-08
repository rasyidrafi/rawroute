import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ accounts: vi.fn(), files: vi.fn(), call: vi.fn(), management: vi.fn(), lock: vi.fn() }))
vi.mock("@/lib/store", () => ({ listProviderApiKeys: mocks.accounts }))
vi.mock("@/lib/cliproxy-codex", () => ({ listCliProxyCodexAuthFiles: mocks.files, cliProxyCodexApiCall: mocks.call, cliproxyManagement: mocks.management }))
vi.mock("@/lib/local-redis", () => ({ localRedisSetIfAbsent: mocks.lock }))
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }))
vi.mock("@/lib/workspace-context", () => ({ currentWorkspaceId: () => "workspace" }))
import { quotaAllowsProbe, recoverCodexQuota } from "@/lib/codex-recovery"

beforeEach(() => {
  vi.resetAllMocks()
  mocks.accounts.mockResolvedValue([{ id: "a", enabled: true, credentialKind: "codex-cli-proxy", cliProxyAuthFile: "owned" }])
  mocks.files.mockResolvedValue([{ name: "owned", authIndex: "index", statusMessage: "usage_limit_reached" }])
  mocks.lock.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 200, body: JSON.stringify({ rate_limit: { allowed: true, limit_reached: false } }) })
  mocks.management.mockResolvedValue(new Response(null, { status: 200 }))
})

test("fresh available quota clears only the mapped account cooldown", async () => {
  expect(await recoverCodexQuota("codex", "astra")).toBe(true)
  expect(mocks.management).toHaveBeenCalledWith("/v0/management/reset-quota", expect.objectContaining({ body: JSON.stringify({ auth_index: "index" }) }))
})

test("missing and model-specific quota restrictions never permit recovery", () => {
  expect(quotaAllowsProbe({}, "astra")).toBe(false)
  expect(quotaAllowsProbe({ rate_limit: { allowed: true, limit_reached: false }, model_usage: { astra: { available: false } } }, "astra")).toBe(false)
})

test("account guard prevents repeated resets across models", async () => {
  mocks.lock.mockResolvedValue(false)
  expect(await recoverCodexQuota("codex", "astra")).toBe(false)
  expect(mocks.call).not.toHaveBeenCalled()
  expect(mocks.management).not.toHaveBeenCalled()
})

test("disabled, foreign, and non-quota accounts are never reset", async () => {
  mocks.files.mockResolvedValue([{ name: "foreign", authIndex: "other", statusMessage: "usage_limit_reached" }])
  expect(await recoverCodexQuota("codex", "astra")).toBe(false)
  expect(mocks.management).not.toHaveBeenCalled()
})

test("usage failure preserves cooldown", async () => {
  mocks.call.mockResolvedValue({ status: 429, body: "{}" })
  expect(await recoverCodexQuota("codex", "astra")).toBe(false)
  expect(mocks.management).not.toHaveBeenCalled()
})
