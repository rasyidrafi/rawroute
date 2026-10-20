import { expect, test } from "bun:test"
import { createRecorder, safeDetails } from "./recorder"
import { logs } from "./store"

test("neutral metadata admits operational fields but never gateway reasoning, payloads or secrets", () => {
  expect(safeDetails({ method: "GET", status: 200, workspaceId: "workspace-a", succeeded: true, reasoningEffort: "high", toolCount: 1, apiKey: "sk-private", error: "secret", route: "password=private" })).toEqual({ method: "GET", status: 200, workspaceId: "workspace-a", succeeded: true })
})

test("an explicitly contributed recorder uses its closed catalog and metadata normalizer", () => {
  const record = createRecorder({ "fixture.completed": { message: "Fixture completed", source: "fixture" } }, details => ({ count: Number(details.count) }))
  logs.clear()
  record("fixture.completed", { count: 3, secret: "private" })
  expect(logs.snapshot().entries[0]).toMatchObject({ event: "fixture.completed", message: "Fixture completed", source: "fixture", details: { count: 3 } })
  expect(() => createRecorder({})("not-declared" as never)).toThrow("Unknown operational event")
  logs.clear()
})
