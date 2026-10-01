import { afterEach, expect, spyOn, test } from "bun:test"
import { createApiClient } from "@/components/dashboard/api"

const target = globalThis as unknown as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }
let mocked: ReturnType<typeof spyOn> | undefined
afterEach(() => mocked?.mockRestore())

test("clients retain their captured workspace for delayed follow-up requests", async () => {
  const requests: Array<{ url: string; workspace: string | null }> = []
  mocked = spyOn(target, "fetch").mockImplementation(async (url, init) => {
    requests.push({ url: String(url), workspace: new Headers(init?.headers).get("x-rawroute-workspace-id") })
    return Response.json({ ok: true })
  })
  const a = createApiClient("alpha")
  await a.apiPost("/api/admin/aliases", {})
  const b = createApiClient("beta")
  await b.apiFetch("/api/admin/aliases")
  await a.apiDelete("/api/admin/aliases/old")
  await createApiClient().apiFetch("/api/admin/settings", { headers: { "x-rawroute-workspace-id": "spoof" } })
  expect(requests.map(request => request.workspace)).toEqual(["alpha", "beta", "alpha", null])
})
