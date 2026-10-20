import type { LucideIcon } from "lucide-react"
import type { DashboardAppId } from "../contracts/dashboard"
import type { NavigationItem, NavigationGroup } from "@rawroute/ui/navigation"

export type DashboardNavigationItem = NavigationItem
export type DashboardNavigationGroup = NavigationGroup
export type DashboardApp = { id: DashboardAppId; title: string; description: string; icon: LucideIcon; href: string; navigation: DashboardNavigationGroup[]; showAppTitle?: boolean }
