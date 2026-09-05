import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

test("Codex built-in models include GPT-6 Astra", () => {
  const source = readFileSync(new URL("./codex.ts", import.meta.url), "utf8")

  expect(source).toContain('name: "GPT-6 Astra"')
  expect(source).toContain('gatewayModelId: "codex/gpt-6-astra"')
  expect(source).toContain('upstreamModel: "gpt-6-astra"')
})
