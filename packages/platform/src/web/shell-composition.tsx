import { createContext, useContext, type ReactNode } from "react"
import { useLocation } from "react-router"
import type { DashboardPageMeta } from "../contracts/dashboard"
import type { DashboardApp, DashboardNavigationItem } from "./navigation"

export type ShellComposition = {
  apps: readonly DashboardApp[]
  defaultLanding: string
  pageForPath: (pathname: string) => { id: string; meta: DashboardPageMeta } | undefined
  renderSkeleton: (pathname: string) => ReactNode
  events: ReactNode
  wrapDashboard: (children: ReactNode) => ReactNode
  availability: Readonly<Record<string, { available: boolean; statusLabel: string }>>
  workspaceChanged: (pathname: string) => string | undefined
  reportCopy: (page: string, success: boolean, workspaceId: string | null) => void
}

const ShellContext = createContext<ShellComposition | undefined>(undefined)

export function ShellCompositionProvider({ value, children }: { value: ShellComposition; children: ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShellComposition() {
  const value = useContext(ShellContext)
  if (!value) throw new Error("ShellCompositionProvider is required")
  return value
}

export function DashboardRouteSkeleton() {
  const { pathname } = useLocation()
  return useShellComposition().renderSkeleton(pathname)
}

export function isNavigationItemActive(pathname: string, item: DashboardNavigationItem, apps: readonly DashboardApp[]) {
  return pathname === item.href || (!apps.some(app => app.href === item.href) && pathname.startsWith(`${item.href}/`))
}
