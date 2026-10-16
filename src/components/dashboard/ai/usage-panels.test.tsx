import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { UsageTable } from "./usage-panels"
import type { DashboardPayload } from "@/lib/types"

const key: DashboardPayload["keys"][number] = {
  id: "internal-key-id",
  publicId: "a".repeat(64),
  label: "Public API key",
  maskedKey: "hidden",
  requests: 1,
  tokens: 10,
  costMicros: 100,
  models: [],
  lastUsed: null,
}

function render(publicView: boolean) {
  return renderToStaticMarkup(<MemoryRouter><UsageTable keys={[key]} refreshing={false} publicView={publicView} workspaceId="workspace_1" /></MemoryRouter>)
}

test("usage table actions link to the protected dashboard detail route", () => {
  const markup = render(false)
  expect(markup).toContain('href="/dashboard/ai/overview/usage/keys/internal-key-id"')
  expect(markup).toContain('aria-label="View usage for Public API key"')
})

test("public usage table actions link to the public detail route and keep workspace scope", () => {
  const markup = render(true)
  expect(markup).toContain(`href="/usage/keys/${"a".repeat(64)}?workspace=workspace_1"`)
  expect(markup).toContain('aria-label="View usage for Public API key"')
  expect(markup).not.toContain("internal-key-id")
})
