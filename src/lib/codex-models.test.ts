import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

test("Codex built-in models include the GPT-6 variants", () => {
  const source = readFileSync(new URL("./codex.ts", import.meta.url), "utf8")

  for (const variant of ["astra", "luna", "sol"]) {
    const displayName = variant[0]!.toUpperCase() + variant.slice(1)
    expect(source).toContain(`name: "GPT-6 ${displayName}"`)
    expect(source).toContain(`gatewayModelId: "codex/gpt-6-${variant}"`)
    expect(source).toContain(`upstreamModel: "gpt-6-${variant}"`)
  }
})
