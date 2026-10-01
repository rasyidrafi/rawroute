import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("providers use a list page and a dynamic detail page", () => {
  const routes = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8")
  const list = readFileSync(new URL("../../src/components/dashboard/providers-view.tsx", import.meta.url), "utf8")
  const detail = readFileSync(new URL("../../src/components/dashboard/provider-detail-view.tsx", import.meta.url), "utf8")

  expect(routes).toContain("<ProviderPage />")
  expect(routes).toContain('providerId="codex"')
  expect(list).toContain("/dashboard/providers/${provider.id}")
  expect(detail).toContain('buttonLabel="Delete provider"')
  expect(detail).toContain("Expose upstream models behind your provider prefix.")
  expect(detail).toContain('isOAuthProvider ? "Accounts" : "API keys"')
  expect(detail).not.toContain('apiKey.credentialKind === "codex-oauth" ? null')
  expect(detail).toContain("moveProviderApiKey(index, -1)")
  expect(detail).toContain("moveProviderApiKey(index, 1)")
  expect(detail).toContain("deleteModel")
  expect(detail.match(/nativeButton=\{false\}/g)).toHaveLength(2)
  expect(list.match(/nativeButton=\{false\}/g)).toHaveLength(2)
})
