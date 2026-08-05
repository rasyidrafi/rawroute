import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("aliases expose copyable gateway IDs", () => {
  const view = readFileSync(new URL("./dashboard/aliases-view.tsx", import.meta.url), "utf8")

  expect(view).toContain("<TableHead>Gateway ID</TableHead>")
  expect(view).toContain("navigator.clipboard.writeText(alias.alias)")
  expect(view).toContain('toast.success("Gateway ID copied")')
  expect(view).toContain('variant="outline"')
  expect(view).toContain("<TableCell>{alias.targetModelId}</TableCell>")
  expect(view).toContain("setEditingAlias(alias)")
})

test("alias form pairs gateway ID and name, then provider and model", () => {
  const form = readFileSync(new URL("./dashboard/alias-form.tsx", import.meta.url), "utf8")

  expect(form).toContain('label="Gateway ID"')
  expect(form).toContain('label="Name"')
  expect(form).toContain('label="Provider"')
  expect(form).toContain('label="Model"')
  expect(form).toContain("disabled={!providerId")
  expect(form).toContain("onValueChange={setProviderId}")
})
