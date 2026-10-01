import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("aliases expose copyable gateway IDs", () => {
  const view = readFileSync(new URL("../../src/components/dashboard/aliases-view.tsx", import.meta.url), "utf8")

  expect(view).toContain('id: "Gateway ID", label: "Gateway ID"')
  expect(view).toContain('copy(alias.alias, "Gateway ID copied")')
  expect(view).toContain('variant="outline"')
  expect(view).toContain('id: "Status", label: "Status"')
  expect(view).toContain("Shared Models")
  expect(view).toContain("setEditingAlias(alias)")
})

test("alias form pairs gateway ID and name, then provider and model", () => {
  const form = readFileSync(new URL("../../src/components/dashboard/alias-form.tsx", import.meta.url), "utf8")

  expect(form).toContain('label="Gateway ID"')
  expect(form).toContain('label="Name"')
  expect(form).toContain('label="Provider"')
  expect(form).toContain('label="Model"')
  expect(form).toContain("disabled={!providerId")
  expect(form).toContain("setProviderId(value); setTargetModelId(null)")
  expect(form).toContain('value={SHARED_PROVIDER_ID}')
})
