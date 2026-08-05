import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("providers use a list page and a dynamic detail page", () => {
  const dashboard = readFileSync(new URL("./gateway-dashboard.tsx", import.meta.url), "utf8")
  const list = readFileSync(new URL("./dashboard/providers-view.tsx", import.meta.url), "utf8")
  const detail = readFileSync(new URL("./dashboard/provider-detail-view.tsx", import.meta.url), "utf8")
  const detailPage = readFileSync(new URL("../app/dashboard/providers/[providerId]/page.tsx", import.meta.url), "utf8")
  const codexPage = readFileSync(new URL("../app/dashboard/providers/codex/page.tsx", import.meta.url), "utf8")
  const codexLoading = readFileSync(new URL("../app/dashboard/providers/codex/loading.tsx", import.meta.url), "utf8")

  expect(dashboard).toContain('case "providers"')
  expect(dashboard).toContain('case "provider-detail"')
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
  expect(detailPage).toContain('view="provider-detail"')
  expect(detailPage).toContain("providerId={providerId}")
  expect(codexPage).toContain('ProviderDetailView providerId="codex"')
  expect(codexPage).not.toContain("OAuthProvidersView")
  expect(codexLoading).toContain('variant="provider-detail"')
})
