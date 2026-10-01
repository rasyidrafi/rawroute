import { beforeEach, expect, mock, test } from "bun:test"

const readMeta = mock(async () => ({ admin: { mustChangePassword: false } }))
const mappedWorkspaceForFile = mock(async () => undefined as string | undefined)
mock.module("@/server/store", () => ({ readMeta }))
mock.module("@/lib/codex/cliproxy", () => ({ mappedWorkspaceForFile }))
const management = mock<(path: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({}))
mock.module("@/lib/cliproxy/management", () => ({ cliproxyManagement: management, cliproxyManagementJson: async (path: string, init?: RequestInit) => { const response = await management(path, init); return { response, data: await response.clone().json() } } }))
const admin = await import("@/server/cliproxy/admin")
const origin = "http://localhost:3000"
function request(path: string, method = "GET", body?: unknown, withOrigin = true) {
  return new Request(`${origin}${path}`, { method, headers: { ...(withOrigin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
beforeEach(() => {
  process.env.CLIPROXY_MODE = "external"
  process.env.CLIPROXY_API_KEY = "private-transport-key"
  process.env.RAWROUTE_PUBLIC_URL = origin
  readMeta.mockResolvedValue({ admin: { mustChangePassword: false } })
  mappedWorkspaceForFile.mockResolvedValue(undefined)
  management.mockReset()
})

test("global key replacement preserves the internal credential and never returns plaintext keys", async () => {
  let keys = ["private-transport-key", "private-extra-key"]
  management.mockImplementation(async (_path, init) => { if (init?.method === "PUT") keys = JSON.parse(String(init.body)); return Response.json({ "api-keys": keys }) })
  const listed = await admin.getKeys(request("/api/admin/cliproxy/api-keys"))
  const body = await listed.text()
  expect(body).not.toContain("private-transport-key")
  expect(body).not.toContain("private-extra-key")
  const managed = JSON.parse(body).apiKeys.find((key: { managedTransport: boolean }) => key.managedTransport)
  expect((await admin.deleteKey(request("/keys", "DELETE"), { keyId: managed.id })).status).toBe(409)
  expect((await admin.putKeys(request("/keys", "PUT", { apiKeys: ["replacement"] }))).status).toBe(200)
  expect(keys).toEqual(["replacement", "private-transport-key"])
})

test("global auth mutations protect workspace mappings and reserved workspace prefixes", async () => {
  management.mockResolvedValue(Response.json({ files: [{ name: "owned.json", type: "codex", prefix: "rr-codex-existing", refresh_token: "never-return" }] }))
  const response = await admin.getAuthFiles(request("/auth"))
  expect(await response.text()).not.toContain("never-return")
  expect((await admin.mutateAuthFile(request("/auth?name=owned.json", "DELETE"))).status).toBe(409)
  expect((await admin.mutateAuthFile(request("/auth?all=true", "DELETE"))).status).toBe(400)
  expect(management.mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

test("global controls require password rotation and matching mutation origin", async () => {
  expect((await admin.putKeys(request("/keys", "PUT", { add: "new" }, false))).status).toBe(403)
  readMeta.mockResolvedValue({ admin: { mustChangePassword: true } })
  expect((await admin.getKeys(request("/keys"))).status).toBe(403)
  expect(management).not.toHaveBeenCalled()
})

test("engine log redaction removes secrets from structured objects and log strings", async () => {
  management.mockResolvedValue(Response.json({ lines: ["Authorization: Bearer private-transport-key", 'refresh_token="oauth-secret"', "ok"], access_token: "token-value" }))
  const response = await admin.getLogs(request("/logs?limit=500"))
  const text = await response.text()
  for (const secret of ["private-transport-key", "oauth-secret", "token-value"]) expect(text).not.toContain(secret)
  expect(text).toContain("ok")
})
