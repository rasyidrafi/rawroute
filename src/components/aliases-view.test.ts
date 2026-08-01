import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("aliases expose copyable gateway IDs", () => {
  const view = readFileSync(new URL("./dashboard/aliases-view.tsx", import.meta.url), "utf8")

  expect(view).toContain("<TableHead>Gateway ID</TableHead>")
  expect(view).toContain("navigator.clipboard.writeText(alias.alias)")
  expect(view).toContain('toast.success("Gateway ID copied")')
  expect(view).toContain('variant="outline"')
  expect(view).toContain("<TableCell>{alias.targetModelId}</TableCell>")
})
