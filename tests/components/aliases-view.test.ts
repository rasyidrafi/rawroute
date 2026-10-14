import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("combos expose copyable gateway IDs and shared models", () => {
  const view = readFileSync(new URL("../../src/components/dashboard/ai/aliases-view.tsx", import.meta.url), "utf8")

  expect(view).toContain('id: "Gateway ID", label: "Gateway ID"')
  expect(view).toContain('copy(combo.combo, "Gateway ID copied")')
  expect(view).toContain('variant="outline"')
  expect(view).toContain('id: "Status", label: "Status"')
  expect(view).toContain("Shared Models")
  expect(view).toContain("setEditingCombo(combo)")
})

test("combo form pairs gateway ID and name with ordered local and shared models", () => {
  const form = readFileSync(new URL("../../src/components/dashboard/ai/combo-form.tsx", import.meta.url), "utf8")

  expect(form).toContain('label="Gateway ID"')
  expect(form).toContain('label="Name"')
  expect(form).toContain('label="Models / fallback order"')
  expect(form).toContain("Select a local or shared model")
  expect(form).toContain("disabled={!selectedModel || members.length >= 8}")
  expect(form).toContain('sharedModels.filter((model) => model.status === "active")')
  expect(form).toContain("onDragEnd={reorderMembers}")
})
