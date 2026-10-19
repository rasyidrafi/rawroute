import { expect, mock, test } from "bun:test"
import { createBudgetActions } from "./budgets-view"

type Patch = (path: string, body: unknown) => Promise<unknown>

function actions(apiPatch: ReturnType<typeof mock>) {
  return createBudgetActions({ apiPatch, apiPost: mock(), apiDelete: mock(), mutate: mock(), setPending: () => {}, clearSelectedApiKey: () => {} })
}

test("activation saves the displayed exclusions before enabling Unlimited Mode", async () => {
  const patch = mock<Patch>(async () => ({}))
  expect(await actions(patch).toggleBypass(true, true, ["expensive"])).toBe(true)
  expect(patch.mock.calls).toEqual([
    ["/api/admin/budgets/unlimited", { excludedModelIds: ["expensive"] }],
    ["/api/admin/budgets/bypass", { enabled: true, autoDeactivateAtWindowEnd: true }],
  ])
})

test("failed exclusion save prevents activation", async () => {
  const patch = mock<Patch>(async () => { throw new Error("Could not save exclusions") })
  expect(await actions(patch).toggleBypass(true, false, ["expensive"])).toBe(false)
  expect(patch).toHaveBeenCalledTimes(1)
  expect(patch.mock.calls[0]?.[0]).toBe("/api/admin/budgets/unlimited")
})

test("deactivation remains possible with unsaved exclusions", async () => {
  const patch = mock<Patch>(async () => ({}))
  expect(await actions(patch).toggleBypass(false, false, ["expensive"])).toBe(true)
  expect(patch.mock.calls).toEqual([["/api/admin/budgets/bypass", { enabled: false }]])
})

test("activation persists an empty exclusion draft before enabling the bypass", async () => {
  const patch = mock<Patch>(async () => ({}))
  expect(await actions(patch).toggleBypass(true, false, [])).toBe(true)
  expect(patch.mock.calls[0]).toEqual(["/api/admin/budgets/unlimited", { excludedModelIds: [] }])
})
