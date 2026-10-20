import { aiBrowserModule } from "@rawroute/gateway-ai/web"
import { toolsBrowserModule } from "@rawroute/gateway-tools/web"
import { observabilityBrowserModule } from "@rawroute/platform/web/operational-logs"
import { platformBrowserModule } from "@rawroute/platform/web"
import type { BrowserModule } from "@rawroute/platform/web/browser-module"
import type { DashboardApp, DashboardNavigationItem } from "@rawroute/platform/web/navigation"
import { isNavigationItemActive } from "@rawroute/platform/web/shell-composition"
import { validateBrowserModules } from "./contracts/dashboard/validate-browser"

export const browserModules: readonly BrowserModule[] = [aiBrowserModule, toolsBrowserModule, observabilityBrowserModule, platformBrowserModule]
validateBrowserModules(browserModules)

const sharedNavigation = [
  { label: "System", items: browserModules.flatMap(module => module.sharedNavigation?.workspace ?? []) },
  { label: "Global", items: browserModules.flatMap(module => module.sharedNavigation?.global ?? []) },
]
export const dashboardApps: DashboardApp[] = browserModules.flatMap(module => module.app ? [{ ...module.app, navigation: [...module.app.navigation, ...sharedNavigation] }] : [])
export const dashboardViews = Object.assign({}, ...browserModules.map(module => module.views)) as BrowserModule["views"]
export const dashboardSkeletons = Object.assign({}, ...browserModules.map(module => module.skeletons)) as BrowserModule["skeletons"]
export const publicBrowserRoutes = browserModules.flatMap(module => module.publicRoutes ?? [])
export function isDashboardNavigationItemActive(pathname: string, item: DashboardNavigationItem) {
  return isNavigationItemActive(pathname, item, dashboardApps)
}
