import { beforeEach, expect, mock, test } from "bun:test"
import { withLifecycleMutation } from "@/server/cliproxy/mutations"

const accounts = [
  { id: "a", priority: 1, credentialKind: "codex-cli-proxy", cliProxyAuthFile: "a.json" },
  { id: "b", priority: 0, credentialKind: "codex-cli-proxy", cliProxyAuthFile: "b.json" },
]
const management = mock<(path: string, init?: RequestInit) => Promise<Response>>()
const reorderDatabase = mock<(providerId: string, orderedIds: string[]) => Promise<void>>()
mock.module("@/lib/cliproxy/management", () => ({ cliproxyManagement: management }))
mock.module("@/lib/codex/oauth", () => ({ listCodexAccounts: async () => ({ accounts }) }))
mock.module("@/server/store", () => ({
  getProvider: async () => ({ prefix: "codex" }),
  reorderProviderApiKeys: reorderDatabase,
  listProviderApiKeys: async () => accounts,
  listProviders: async () => [],
  upsertProviderApiKey: async () => undefined,
}))
mock.module("@/server/workspace-repository", () => ({ listWorkspaces: async () => [] }))
mock.module("@/server/logging/recorder", () => ({ recordLog: () => undefined }))
mock.module("@/lib/cliproxy/provider-sync", () => ({ syncNonCodexProviderProjection: async () => undefined }))
const { POST } = await import("@/server/routes/api/admin/providers/by-provider/api-keys/reorder")

beforeEach(() => {
  process.env.CLIPROXY_MODE = "external"
  management.mockReset()
  reorderDatabase.mockReset()
})

for (const failure of [undefined, "upstream", "database"] as const) {
  test(`restart waits for the whole Codex reorder ${failure ? `and ${failure} failure rollback` : "and database commit"}`, async () => {
    const priorities = new Map(accounts.map(account => [account.cliProxyAuthFile, account.priority]))
    let databaseOrder = ["a", "b"]
    const events: string[] = []
    let wroteFirst!: () => void
    let continueFirst!: () => void
    const firstWritten = new Promise<void>(resolve => { wroteFirst = resolve })
    const barrier = new Promise<void>(resolve => { continueFirst = resolve })
    let writes = 0
    management.mockImplementation(async (_path, init) => {
      const { name, priority } = JSON.parse(String(init?.body)) as { name: string; priority: number }
      if (failure === "upstream" && name === "a.json" && priority === 0) throw new Error("Upstream write failed")
      priorities.set(name, priority)
      events.push(`${name}:${priority}`)
      if (++writes === 1) { wroteFirst(); await barrier }
      return Response.json({ ok: true })
    })
    reorderDatabase.mockImplementation(async (_providerId, orderedIds) => {
      if (failure === "database") throw new Error("Database write failed")
      databaseOrder = [...orderedIds]
      events.push("database committed")
    })
    const request = new Request("http://localhost/reorder", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds: ["b", "a"] }),
    })
    const reorder = POST(request, { providerId: "codex" })
    await firstWritten
    const lifecycle = withLifecycleMutation(async () => {
      events.push("restart")
      return { priorities: [...priorities], databaseOrder: [...databaseOrder] }
    })
    continueFirst()
    const [response, atRestart] = await Promise.all([reorder, lifecycle])
    expect(response.status).toBe(failure ? 502 : 200)
    expect(atRestart).toEqual({
      priorities: failure ? [["a.json", 1], ["b.json", 0]] : [["a.json", 0], ["b.json", 1]],
      databaseOrder: failure ? ["a", "b"] : ["b", "a"],
    })
    expect(events.at(-1)).toBe("restart")
    if (failure) expect(await response.text()).toContain(failure === "upstream" ? "Upstream write failed" : "Database write failed")
  })
}
