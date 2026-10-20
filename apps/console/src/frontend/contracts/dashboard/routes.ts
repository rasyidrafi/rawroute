// Console-only static composition. Owners declare canonical metadata in contracts.
import { aiPages, publicUsageRoutes } from "@rawroute/gateway-ai/contracts/pages"
import { toolPages } from "@rawroute/gateway-tools/contracts/pages"
import { observabilityPages } from "@rawroute/platform/contracts/operational-log-pages"
import { matchesPagePath, pagePathsFor, platformPages, platformPagePaths } from "@rawroute/platform/contracts/dashboard"
import { validatePageContributions } from "./validate"

export type { DashboardAppId, DashboardPageMeta } from "@rawroute/platform/contracts/dashboard"

export const pageContributions = [
  { owner: "ai", pages: aiPages },
  { owner: "tools", pages: toolPages },
  { owner: "observability", pages: observabilityPages },
  { owner: "platform", pages: platformPages },
] as const
validatePageContributions(pageContributions)

export const dashboardPages = { ...aiPages, ...observabilityPages, ...platformPages, ...toolPages }
export type DashboardPage = keyof typeof dashboardPages
export type DashboardSkeletonVariant = typeof dashboardPages[DashboardPage]["skeleton"]

export const pagePaths = {
  ...platformPagePaths,
  publicKeyUsage: publicUsageRoutes.keyUsage,
  ...pagePathsFor(dashboardPages),
}

export function dashboardPageForPath(pathname: string): DashboardPage | undefined {
  const ids = Object.keys(dashboardPages) as DashboardPage[]
  return ids.find(id => dashboardPages[id].path === pathname)
    ?? ids.find(id => matchesPagePath(dashboardPages[id].path, pathname))
}

export function isPagePath(pathname: string) {
  return pathname === pagePaths.home || pathname === pagePaths.login || dashboardPageForPath(pathname) !== undefined || matchesPagePath(publicUsageRoutes.keyUsage, pathname)
}

export function isDashboardPage(value: unknown): value is DashboardPage {
  return typeof value === "string" && Object.hasOwn(dashboardPages, value)
}
