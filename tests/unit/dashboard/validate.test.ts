import { expect, test } from "bun:test"
import { aiPages } from "../../../packages/gateway-ai/src/contracts/pages"
import { toolPages } from "../../../packages/gateway-tools/src/contracts/pages"
import { observabilityPages } from "../../../packages/platform/src/contracts/operational-log-pages"
import type { DashboardPageMeta } from "../../../packages/platform/src/contracts/dashboard"
import { dashboardPages, pageContributions, dashboardPageForPath } from "../../../apps/console/src/frontend/contracts/dashboard/routes"
import { validatePageContributions, validatePageReferences } from "../../../apps/console/src/frontend/contracts/dashboard/validate"

const page: DashboardPageMeta = { ...aiPages.overview }

test("production contributions preserve separate owner, navigation placement and access scope", () => {
  expect(() => validatePageContributions(pageContributions)).not.toThrow()
  expect(Object.keys(dashboardPages)).toHaveLength(27)
  expect(observabilityPages.logs).toMatchObject({ owner: "observability", app: "shared", scope: "workspace" })
  expect(observabilityPages.systemLogs).toMatchObject({ owner: "observability", app: "shared", scope: "global" })
  expect(Object.values(toolPages).every(value => value.scope === "global")).toBe(true)
})

test("rejects duplicate IDs before object merging can erase a contribution", () => {
  expect(() => validatePageContributions([
    { owner: "ai", pages: { overview: page } },
    { owner: "ai", pages: { overview: { ...page, path: "/dashboard/ai/another" } } },
  ])).toThrow("Duplicate dashboard page ID: overview")
})

test("rejects duplicate and parameter-equivalent paths with both page IDs", () => {
  for (const paths of [["/dashboard/ai/example", "/dashboard/ai/example"], ["/dashboard/ai/example/:first", "/dashboard/ai/example/:second"]]) {
    expect(() => validatePageContributions([{ owner: "ai", pages: { first: { ...page, path: paths[0]! }, second: { ...page, path: paths[1]! } } }])).toThrow("first and second")
  }
})

test("validates owner, app, canonical path, scope and loading metadata", () => {
  const invalid: [Partial<DashboardPageMeta>, string][] = [
    [{ owner: "tools" }, "does not match contribution"],
    [{ app: "tool-gateway" }, "Invalid app placement"],
    [{ path: "/dashboard/tools/overview" }, "path does not match its app"],
    [{ path: "/dashboard/ai/overview/" }, "Invalid canonical dashboard path"],
    [{ path: "/dashboard/ai/overview?tab=one" }, "Invalid canonical dashboard path"],
    [{ skeleton: "" }, "requires title and skeleton"],
  ]
  for (const [change, message] of invalid) expect(() => validatePageContributions([{ owner: "ai", pages: { example: { ...page, ...change } } }])).toThrow(message)
  expect(() => validatePageContributions([{ owner: "tools", pages: { example: { ...toolPages.tools, scope: "workspace" } } }])).toThrow("must have global scope")
})

test("requires a view for every page and rejects dangling view and navigation references", () => {
  const pages = { example: page }
  expect(() => validatePageReferences(pages, {}, [])).toThrow("Missing dashboard view for page example")
  expect(() => validatePageReferences(pages, { example: null }, [])).toThrow("Missing dashboard view")
  expect(() => validatePageReferences(pages, { example: {}, other: {} }, [])).toThrow("view references unknown page other")
  expect(() => validatePageReferences(pages, { example: {} }, [{ page: "other" }])).toThrow("navigation references unknown page other")
  expect(() => validatePageReferences(pages, { example: {} }, [{ page: "example" }])).not.toThrow()
})

test("route lookup derives parameter matches from canonical owner metadata", () => {
  expect(dashboardPageForPath("/dashboard/ai/providers/encoded%2Fid")).toBe("provider")
  expect(dashboardPageForPath("/dashboard/ai/providers/")).toBeUndefined()
  expect(dashboardPageForPath("/dashboard/ai/providers/id/extra")).toBeUndefined()
  expect(dashboardPageForPath("/dashboard/ai/overview/usage/keys/key")).toBe("keyUsage")
  expect(dashboardPageForPath("/dashboard/ai/overview/usage/keys/")).toBeUndefined()
})
