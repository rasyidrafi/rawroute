import { expect, test } from "bun:test"
import { createLogStore, resolveLogStore } from "./store"
import { safeDetails } from "./recorder"

const input = { source: "gateway", event: "gateway.request.completed", message: "Gateway request completed", level: "info" as const, origin: "server" as const, requestId: null, details: { status: 200 } }
const global = { kind: "global" as const }

test("scopes retain and clear independently, with per-scope and total memory bounds", () => {
  const store = createLogStore(2, 4)
  const a = store.admitWorkspace("a"), b = store.admitWorkspace("b")
  store.record(input, global)
  store.record(input, a)
  store.record(input, b)
  store.record(input, a)
  store.record(input, a)
  expect(store.snapshot(a).entries).toHaveLength(2)
  expect(store.snapshot(a).evicted).toBe(1)
  expect(store.snapshot(b).entries).toHaveLength(1)
  expect(store.snapshot().entries).toHaveLength(1)
  store.clear(a)
  expect(store.snapshot(a).entries).toHaveLength(0)
  expect(store.snapshot(b).entries).toHaveLength(1)
  expect(store.snapshot().entries).toHaveLength(1)
  const snapshot = store.snapshot(b)
  snapshot.entries[0]!.details.status = 999
  expect(store.snapshot(b).entries[0]!.details.status).toBe(200)
})

test("global total bound evicts oldest entries across scopes", () => {
  const store = createLogStore(2, 3)
  for (const id of ["a", "b", "c", "d"]) store.record(input, store.admitWorkspace(id))
  expect(store.snapshot({ kind: "workspace", workspaceId: "a" }).evicted).toBe(1)
  expect(store.snapshot({ kind: "workspace", workspaceId: "d" }).entries).toHaveLength(1)
})

test("deleting a workspace invalidates outstanding writers, including after re-admission", () => {
  const store = createLogStore()
  const old = store.admitWorkspace("a")
  store.record(input, old)
  store.deleteWorkspace("a")
  expect(store.record(input, old)).toBe(false)
  const next = store.admitWorkspace("a")
  expect(store.record(input, old)).toBe(false)
  expect(store.record(input, next)).toBe(true)
  expect(store.snapshot(next).entries).toHaveLength(1)
})

test("workspace buffer count is bounded and HMR replaces incompatible stores", () => {
  const store = createLogStore()
  for (let id = 0; id < 129; id++) store.record(input, store.admitWorkspace(String(id)))
  expect(store.snapshot({ kind: "workspace", workspaceId: "0" }).entries).toHaveLength(0)
  const runtime = { __rawrouteLogs: {} }
  const next = resolveLogStore(runtime)
  expect(resolveLogStore(runtime)).toBe(next)
})

test("metadata excludes credentials, free-form errors, URLs, control characters and unbounded values", () => {
  expect(safeDetails({ status: 200, durationMs: 10, apiKeyId: "key-id", model: "provider/model", inputTokens: 42, terminalEvent: true,
    password: "private", apiKey: "sk-private", error: "secret failure", prompt: "private", url: "https://host/?token=private",
    accountId: "sk-secret", providerId: "injected\nline", outputTokens: Infinity, source: "x".repeat(200), unknown: 12,
  })).toEqual({ status: 200, durationMs: 10, apiKeyId: "key-id", model: "provider/model", inputTokens: 42, terminalEvent: true })
})
