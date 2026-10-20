import { useLocation } from "react-router"
import { dashboardSkeletons } from "./browser-modules"
import { dashboardPageForPath, dashboardPages, type DashboardSkeletonVariant } from "./contracts/dashboard/routes"

export function dashboardSkeletonForPath(path: string): DashboardSkeletonVariant {
  const page = dashboardPageForPath(path)
  return page ? dashboardPages[page].skeleton : "endpoint-key"
}
export function DashboardRouteSkeleton() {
  const { pathname } = useLocation()
  return <DashboardContentSkeleton variant={dashboardSkeletonForPath(pathname)} />
}
export function DashboardContentSkeleton({ variant }: { variant: DashboardSkeletonVariant }) {
  const page = Object.entries(dashboardPages).find(([, page]) => page.skeleton === variant)?.[0]
  return dashboardSkeletons[page ?? "endpoint"]
}
