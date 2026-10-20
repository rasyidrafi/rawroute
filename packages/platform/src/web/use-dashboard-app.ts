import { useEffect, useState } from "react"
import { useLocation } from "react-router"
import { useShellComposition } from "./shell-composition"

export function useDashboardApp() {
  const { pathname, state } = useLocation()
  const { apps, pageForPath } = useShellComposition()
  const [savedApp] = useState(() => window.localStorage.getItem("rawroute_app"))
  const declared = pageForPath(pathname)?.meta.app ?? apps[0]!.id
  const selected = declared === "shared" ? state?.dashboardApp ?? savedApp : declared
  const app = apps.find(app => app.id === selected) ?? apps[0]!
  useEffect(() => { window.localStorage.setItem("rawroute_app", app.id) }, [app.id])
  return app
}
