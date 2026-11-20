import { useLocation } from "react-router"
import { dashboardSkeletons } from "./browser-modules"
import { dashboardPageForPath } from "./contracts/dashboard/routes"

export function dashboardSkeletonForPath(path: string) {
  const page = dashboardPageForPath(path)
  return page ? dashboardSkeletons[page] : null
}
export function DashboardRouteSkeleton() {
  const { pathname } = useLocation()
  return dashboardSkeletonForPath(pathname)
}
