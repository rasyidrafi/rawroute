import { beforeEach, expect, mock, test } from "bun:test"

const accounts = [
  { id: "a", providerId: "codex", name: "A", key: "", credentialKind: "codex-oauth", enabled: true, priority: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", providerId: "codex", name: "B", key: "", credentialKind: "codex-oauth", enabled: true, priority: 0, createdAt: "2026-01-02T00:00:00.000Z" },
]
const reorderDatabase = mock<(providerId: string, orderedIds: string[]) => Promise<void>>()
mock.module("../../packages/gateway-ai/src/server/store", () => ({
  getProvider: async () => ({ prefix: "codex" }),
  reorderProviderApiKeys: reorderDatabase,
  listProviderApiKeys: async () => accounts.map(account => ({ ...account })),
}))
mock.module("../../packages/gateway-ai/src/server/logging", () => ({ recordLog: () => undefined }))
const { POST } = await import("../../packages/gateway-ai/src/server/routes/api/admin/providers/by-provider/api-keys/reorder/index")

beforeEach(() => {
  reorderDatabase.mockReset()
  accounts[0]!.priority = 1
  accounts[1]!.priority = 0
})

function request(orderedIds: string[]) {
  return POST(new Request("http://localhost/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  }), { providerId: "codex" })
}

test("serializes Codex account reorders against the latest stored account list", async () => {
  let firstStarted!: () => void
  let releaseFirst!: () => void
  const started = new Promise<void>(resolve => { firstStarted = resolve })
  const barrier = new Promise<void>(resolve => { releaseFirst = resolve })
  const committedOrders: string[][] = []
  reorderDatabase.mockImplementation(async (_providerId, orderedIds) => {
    if (!committedOrders.length) {
      firstStarted()
      await barrier
    }
    committedOrders.push([...orderedIds])
    orderedIds.forEach((id, index) => {
      const account = accounts.find(entry => entry.id === id)!
      account.priority = orderedIds.length - index - 1
    })
  })

  const first = request(["b", "a"])
  await started
  const second = request(["a", "b"])
  releaseFirst()
  const [firstResponse, secondResponse] = await Promise.all([first, second])

  expect(firstResponse.status).toBe(200)
  expect(secondResponse.status).toBe(200)
  expect(committedOrders).toEqual([["b", "a"], ["a", "b"]])
  expect(accounts.map(account => [account.id, account.priority])).toEqual([["a", 1], ["b", 0]])
})

test("rejects unsupported stored credentials and stale account orders", async () => {
  const unsupported = accounts[0]!.credentialKind
  accounts[0]!.credentialKind = "api-key"
  try {
    const unsupportedResponse = await request(["b", "a"])
    expect(unsupportedResponse.status).toBe(400)
    expect(await unsupportedResponse.text()).toContain("Reconnect Codex accounts")
    expect(reorderDatabase).not.toHaveBeenCalled()
  } finally {
    accounts[0]!.credentialKind = unsupported
  }

  const stale = await request(["a"])
  expect(stale.status).toBe(400)
  expect(await stale.text()).toContain("out of date")
  expect(reorderDatabase).not.toHaveBeenCalled()
})
