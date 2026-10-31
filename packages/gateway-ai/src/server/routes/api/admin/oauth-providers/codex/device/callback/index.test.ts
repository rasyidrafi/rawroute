import { beforeEach, expect, test, mock } from "bun:test"

const mocks = {
  takeLogin: mock(),
  completeLogin: mock(),
  workspaceId: mock(),
}

mock.module("../../../../../../../codex/login", () => ({
  CodexLoginExpiredError: class extends Error { constructor(message = "Codex login has expired. Start it again.") { super(message); this.name = "CodexLoginExpiredError" } },
  takePendingCodexLogin: mocks.takeLogin,
  completeCodexLogin: mocks.completeLogin,
}))
mock.module("../../../../../../../../../../platform/src/server/workspace-context", () => ({ currentWorkspaceId: mocks.workspaceId }))

const { POST } = await import("./index")

beforeEach(() => {
  mock.clearAllMocks()
  mocks.workspaceId.mockReturnValue("workspace-a")
  mocks.takeLogin.mockResolvedValue({ state: "oauth-state", codeVerifier: "verifier", workspaceId: "workspace-a", expiresAt: Date.now() + 60_000 })
  mocks.completeLogin.mockResolvedValue({ status: "authorized" })
})

function request(redirectUrl: string) {
  return new Request("http://rawroute.test/api/admin/oauth-providers/codex/device/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginId: "login-a", redirectUrl }),
  })
}

test("accepts the registered localhost Codex callback and exchanges its code", async () => {
  const response = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=oauth-state"))

  expect(response.status).toBe(200)
  expect(mocks.completeLogin).toHaveBeenCalledTimes(1)
  expect(mocks.completeLogin.mock.calls[0]!.slice(0, 2)).toEqual(["login-a", { state: "oauth-state", codeVerifier: "verifier", workspaceId: "workspace-a", expiresAt: expect.any(Number) }])
  expect(mocks.completeLogin.mock.calls[0]![2]).toEqual({ code: "secret-code" })
})

test("rejects public and mismatched callback URLs", async () => {
  const publicResponse = await POST(request("http://203.0.113.10:8080/auth/callback?code=secret-code&state=oauth-state"))
  const wrongStateResponse = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=other-state"))

  expect(publicResponse.status).toBe(400)
  expect(wrongStateResponse.status).toBe(400)
  expect(mocks.completeLogin).not.toHaveBeenCalled()
})

test("rejects a callback without an authorization code", async () => {
  const response = await POST(request("http://localhost:1455/auth/callback?state=oauth-state"))

  expect(response.status).toBe(400)
  expect(mocks.completeLogin).not.toHaveBeenCalled()
})

test("reports an expired or foreign login instead of trying to finish it", async () => {
  mocks.takeLogin.mockResolvedValue(undefined)
  const expired = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=oauth-state"))
  expect(expired.status).toBe(410)

  mocks.takeLogin.mockResolvedValue({ state: "oauth-state", codeVerifier: "verifier", workspaceId: "workspace-b", expiresAt: Date.now() + 60_000 })
  const foreign = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=oauth-state"))
  expect(foreign.status).toBe(403)
  expect(mocks.completeLogin).not.toHaveBeenCalled()
})

test("forwards an authorization denial as a finished login", async () => {
  const response = await POST(request("http://localhost:1455/auth/callback?error=access_denied&state=oauth-state"))

  expect(response.status).toBe(200)
  expect(mocks.completeLogin).toHaveBeenCalledTimes(1)
  expect(mocks.completeLogin.mock.calls[0]![2]).toEqual({ error: "access_denied" })
})
