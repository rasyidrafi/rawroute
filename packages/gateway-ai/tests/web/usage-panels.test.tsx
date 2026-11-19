import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { EmptyState } from "@rawroute/ui/empty-state"
import { UsageTable } from "../../src/web/components/usage-panels"
import { formatKeyTickLabel } from "../../src/web/components/usage-utils"
import type { DashboardPayload } from "../../src/contracts/domain"

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

test("deleted keys show a Deleted badge, unknown keys show no mask, live keys keep their masked value", () => {
  const deleted = { ...key, label: "Retired user", maskedKey: "deleted" }
  const unknown = { ...key, id: "c8a425ee-ae8a-4980-8ae2-70a34ea91a97", label: "Unknown key · c8a425ee", maskedKey: "unknown" }
  const live = { ...key, id: "live-key", label: "Live user", maskedKey: "sk-rr-3••••••••••••8d4b" }
  const markup = renderToStaticMarkup(<MemoryRouter><UsageTable keys={[deleted, unknown, live]} refreshing={false} workspaceId="workspace_1" /></MemoryRouter>)
  expect(markup).toContain("Retired user")
  expect(markup).toContain(">Deleted<")
  expect(markup).toContain("Unknown key · c8a425ee")
  expect(markup).not.toContain("font-medium\">c8a425ee-ae8a-4980-8ae2-70a34ea91a97")
  expect(markup).not.toContain("unkn")
  expect(markup).toContain("sk-rr-3••••••••••••8d4b")
})

test("public usage table marks confirmed deletions without exposing credential masks", () => {
  const deleted = { ...key, label: "Retired user", maskedKey: "deleted" }
  const unknown = { ...key, label: "Unknown key · c8a425ee", maskedKey: "hidden" }
  const live = { ...key, label: "Live user", maskedKey: "sk-rr-3••••••••••••8d4b" }
  const markup = renderToStaticMarkup(<MemoryRouter><UsageTable keys={[deleted, unknown, live]} refreshing={false} publicView workspaceId="workspace_1" /></MemoryRouter>)
  expect(markup).toContain(">Deleted<")
  expect(markup).not.toContain("sk-rr-")
})

test("public deletion badge survives key names that look like shared-workspace IDs", () => {
  // Public rows use the display label as their id, so a legitimate key name can
  // carry the shared-workspace prefix; the sentinel must still win.
  const deleted = { ...key, id: "shared-workspace:billing", label: "shared-workspace:billing", maskedKey: "deleted" }
  const markup = renderToStaticMarkup(<MemoryRouter><UsageTable keys={[deleted]} refreshing={false} publicView workspaceId="workspace_1" /></MemoryRouter>)
  expect(markup).toContain(">Deleted<")
})

test("chart ticks keep the distinguishing suffix of unresolved key labels", () => {
  const first = formatKeyTickLabel("Unknown key · c8a425ee")
  const second = formatKeyTickLabel("Unknown key · 70a34ea9")
  expect(first).toContain("c8a425ee")
  expect(second).toContain("70a34ea9")
  expect(first).not.toBe(second)
  expect(formatKeyTickLabel("Rasyid")).toBe("Rasyid")
})

test("public usage table actions link to the public detail route and keep workspace scope", () => {
  const markup = render(true)
  expect(markup).toContain(`href="/usage/keys/${"a".repeat(64)}?workspace=workspace_1"`)
  expect(markup).toContain('aria-label="View usage for Public API key"')
  expect(markup).not.toContain("internal-key-id")
})

test("refreshing usage table keeps its rows under the shared spinner overlay", () => {
  const markup = renderToStaticMarkup(<MemoryRouter><UsageTable keys={[key]} refreshing workspaceId="workspace_1" /></MemoryRouter>)
  expect(markup).toContain("Public API key")
  expect(markup).toContain("Refreshing data...")
  expect(markup).toContain('aria-busy="true"')
  expect(markup).toContain("animate-spin")
  expect(render(false)).not.toContain("Refreshing data...")
})

test("retained empty states carry the same refreshing overlay", () => {
  const markup = renderToStaticMarkup(<EmptyState title="No trend data" description="No usage buckets were found for this range." refreshing />)
  expect(markup).toContain("No trend data")
  expect(markup).toContain("Refreshing data...")
  expect(markup).toContain('aria-busy="true"')
  const idle = renderToStaticMarkup(<EmptyState title="No trend data" description="No usage buckets were found for this range." />)
  expect(idle).not.toContain("Refreshing data...")
})
