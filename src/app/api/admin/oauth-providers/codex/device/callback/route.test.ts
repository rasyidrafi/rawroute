import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  takeLogin: vi.fn(),
  submitCallback: vi.fn(),
  workspaceId: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock("@/lib/codex-cli-login", () => ({ takePendingCliProxyCodexLogin: mocks.takeLogin }))
vi.mock("@/lib/cliproxy-codex", () => ({ submitCliProxyCodexCallback: mocks.submitCallback }))
vi.mock("@/lib/workspace-context", () => ({ currentWorkspaceId: mocks.workspaceId }))

import { POST } from "./route"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireAdmin.mockResolvedValue(() => undefined)
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
  const publicResponse = await POST(request("http://8.219.106.148:18080/codex/callback?code=secret-code&state=oauth-state"))
  const wrongStateResponse = await POST(request("http://localhost:1455/auth/callback?code=secret-code&state=other-state"))

  expect(publicResponse.status).toBe(400)
  expect(wrongStateResponse.status).toBe(400)
  expect(mocks.submitCallback).not.toHaveBeenCalled()
})
