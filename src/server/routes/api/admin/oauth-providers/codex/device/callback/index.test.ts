import { beforeEach, expect, test, mock } from "bun:test"

const mocks = {
  takeLogin: mock(),
  submitCallback: mock(),
  workspaceId: mock(),
}

mock.module("@/lib/codex/cli-login", () => ({ takePendingCliProxyCodexLogin: mocks.takeLogin }))
mock.module("@/lib/codex/cliproxy", () => ({ submitCliProxyCodexCallback: mocks.submitCallback }))
mock.module("@/lib/workspace/context", () => ({ currentWorkspaceId: mocks.workspaceId }))

const { POST } = await import("./index")

beforeEach(() => {
  mock.clearAllMocks()
  mocks.workspaceId.mockReturnValue("workspace-a")
  mocks.takeLogin.mockResolvedValue({ state: "oauth-state", workspaceId: "workspace-a" })
  mocks.submitCallback.mockResolvedValue(undefined)
})

function request(redirectUrl: string) {
  return new Request("http://rawroute.test/api/admin/oauth-providers/codex/device/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginId: "login-a", redirectUrl }),
  })
}

test("accepts the registered localhost Codex callback and forwards its code", async () => {
  const response = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=oauth-state"))

  expect(response.status).toBe(200)
  expect(mocks.submitCallback).toHaveBeenCalledWith({ code: "secret-code", state: "oauth-state" })
})

test("rejects public and mismatched callback URLs", async () => {
  const publicResponse = await POST(request("http://203.0.113.10:8080/codex/callback?code=secret-code&state=oauth-state"))
  const wrongStateResponse = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=other-state"))

  expect(publicResponse.status).toBe(400)
  expect(wrongStateResponse.status).toBe(400)
  expect(mocks.submitCallback).not.toHaveBeenCalled()
})
