import { useEffect, useState } from "react"
import { useLocation } from "react-router"
import { dashboardPages, dashboardPageForPath } from "@/lib/dashboard/routes"
import { dashboardApps } from "@/components/dashboard/dashboard-apps"

export function useDashboardApp() {
  const { pathname, state } = useLocation()
  const [savedApp] = useState(() => window.localStorage.getItem("rawroute_app"))
  const page = dashboardPageForPath(pathname)
  const declared = page ? dashboardPages[page].app : "ai-gateway"
  const selected = declared === "shared" ? state?.dashboardApp ?? savedApp : declared
  const app = dashboardApps[selected === "tool-gateway" ? 1 : 0]
  useEffect(() => { window.localStorage.setItem("rawroute_app", app.id) }, [app.id])
  return app
}
