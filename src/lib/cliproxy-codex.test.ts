import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listProviderApiKeys: vi.fn(),
  listProviders: vi.fn(),
  upsertProviderApiKey: vi.fn(),
  listWorkspaces: vi.fn(),
  runInWorkspace: vi.fn(),
}))

vi.mock("@/lib/store", () => ({
  listProviderApiKeys: mocks.listProviderApiKeys,
  listProviders: mocks.listProviders,
  upsertProviderApiKey: mocks.upsertProviderApiKey,
}))
vi.mock("@/lib/workspaces", () => ({ listWorkspaces: mocks.listWorkspaces }))
vi.mock("@/lib/workspace-context", () => ({ runInWorkspace: mocks.runInWorkspace }))

import { completeCliProxyCodexLogin, registerCliProxyCodexAccount, startCliProxyCodexLogin } from "@/lib/cliproxy-codex"

const provider = { id: "codex-provider", prefix: "codex" } as never

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CLIPROXY_MANAGEMENT_KEY = "management-secret"
  mocks.listWorkspaces.mockResolvedValue([])
  mocks.runInWorkspace.mockImplementation((_workspace, callback) => callback())
})

test("keeps CLIProxy OAuth state and detects a refreshed existing auth file", async () => {
  let authListCalls = 0
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/auth-files")) {
      authListCalls += 1
      const refreshed = authListCalls > 1
      return Response.json({ files: [{ name: "codex-user.json", type: "codex", auth_index: "idx-1", email: "user@example.com", last_refresh: refreshed ? "2026-09-04T01:00:00Z" : "2026-09-04T00:00:00Z" }] })
    }
    if (url.includes("/codex-auth-url")) return Response.json({ status: "ok", state: "oauth-state", url: "https://auth.example/?state=oauth-state" })
    if (url.includes("/get-auth-status")) return Response.json({ status: "ok" })
    if (url.endsWith("/auth-files/fields") && init?.method === "PATCH") return Response.json({ status: "ok" })
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)

  const started = await startCliProxyCodexLogin()
  expect(started.state).toBe("oauth-state")
  const completed = await completeCliProxyCodexLogin(started.state, started.existingAuthFiles, "workspace-a")

  expect(completed?.file.name).toBe("codex-user.json")
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/auth-files/fields"), expect.objectContaining({
    method: "PATCH",
    body: expect.stringContaining('"prefix":"rr-codex-'),
  }))
  vi.unstubAllGlobals()
})

test("updates an existing RawRoute mapping when the same CLIProxy file is reauthorized", async () => {
  mocks.listProviderApiKeys.mockResolvedValue([{ id: "account-a", name: "Existing label", credentialKind: "codex-cli-proxy", cliProxyAuthFile: "codex-user.json", enabled: true }])
  mocks.upsertProviderApiKey.mockImplementation(async (_providerId, input) => input)

  await registerCliProxyCodexAccount(provider, {
    authFile: { name: "codex-user.json", type: "codex", authIndex: "idx-1", disabled: false, unavailable: false, email: "user@example.com" },
  })

  expect(mocks.upsertProviderApiKey).toHaveBeenCalledWith("codex-provider", expect.objectContaining({
    originalId: "account-a",
    name: "Existing label",
    credentialKind: "codex-cli-proxy",
  }))
})
