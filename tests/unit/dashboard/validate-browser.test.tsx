import { expect, test } from "bun:test"
import { aiBrowserModule } from "../../../packages/gateway-ai/src/web/module"
import { toolsBrowserModule } from "../../../packages/gateway-tools/src/web/module"
import type { BrowserModule } from "../../../packages/platform/src/web/browser-module"
import { validateBrowserModules } from "../../../apps/console/src/frontend/contracts/dashboard/validate-browser"

test("validates real owner views, navigation, loading and public page contributions", () => {
  expect(() => validateBrowserModules([aiBrowserModule, toolsBrowserModule])).not.toThrow()
  expect(() => validateBrowserModules([{ ...aiBrowserModule, skeletons: {} }])).toThrow("Missing dashboard view")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, views: {} }])).toThrow("Missing dashboard view")
  expect(() => validateBrowserModules([{ ...toolsBrowserModule, app: undefined }])).toThrow("requires its app contribution")
})

test("rejects wrong navigation metadata and app landing ownership", () => {
  const app = aiBrowserModule.app
  const item = app.navigation[0]!.items[0]!
  expect(() => validateBrowserModules([{ ...aiBrowserModule, app: { ...app, navigation: [{ label: "Wrong", items: [{ ...item, href: "/dashboard/ai/not-canonical" }] }] } }])).toThrow("Navigation metadata mismatch")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, app: { ...app, href: "/dashboard/tools/overview" } }])).toThrow("no owned landing page")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, sharedNavigation: { global: [item] } }])).toThrow("Shared navigation references app-specific page")
})

test("rejects duplicate module owners and application IDs", () => {
  const empty: BrowserModule = { owner: "platform", pages: {}, views: {}, skeletons: {} }
  expect(() => validateBrowserModules([empty, empty])).toThrow("Duplicate browser module owner")
  expect(() => validateBrowserModules([aiBrowserModule, { ...toolsBrowserModule, app: { ...toolsBrowserModule.app, id: "ai-gateway" } }])).toThrow("Duplicate dashboard app ID")
})

test("public pages cannot shadow dashboard or parameter-equivalent public routes", () => {
  const route = aiBrowserModule.publicRoutes[1]
  expect(() => validateBrowserModules([{ ...aiBrowserModule, publicRoutes: [{ ...route, owner: "platform" }] }])).toThrow("owner does not match")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, publicRoutes: [route, { ...route, id: "another", path: "/usage/keys/:anotherId" }] }])).toThrow("Duplicate public page path")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, publicRoutes: [{ ...route, id: "overview" }] }])).toThrow("Duplicate public page ID")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, publicRoutes: [{ ...route, path: aiBrowserModule.pages.overview.path }] }])).toThrow("Duplicate public page path")
  expect(() => validateBrowserModules([{ ...aiBrowserModule, publicRoutes: [{ ...route, path: "/login" }] }])).toThrow("Duplicate public page path")
})
