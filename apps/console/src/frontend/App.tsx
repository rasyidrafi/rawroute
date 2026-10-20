import { Suspense } from "react"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router"

import { DashboardShell } from "@rawroute/platform/web/dashboard-shell"
import { DashboardRouteSkeleton } from "./route-skeleton"
import { DashboardFrameSkeleton } from "@rawroute/platform/web/frame-skeleton"
import { SessionBanner } from "@rawroute/platform/web/session-banner"
import { useSession } from "@rawroute/platform/web/use-session"
import { useOnlineStatus } from "@rawroute/platform/web/use-online-status"
import { dashboardViews, publicBrowserRoutes } from "./browser-modules"
import { dashboardPages, type DashboardPage, pagePaths } from "./contracts/dashboard/routes"
import { NotFoundPage } from "@rawroute/platform/web/pages/not-found"
import { LoginPage } from "@rawroute/platform/web/pages/login"
import { RouteScrollReset } from "@rawroute/platform/web/route-scroll-reset"
import { ConsoleWebComposition } from "./web-composition"
import { useShellComposition } from "@rawroute/platform/web/shell-composition"
import { matchesPagePath } from "@rawroute/platform/contracts/dashboard"

function SessionGate({ login = false }: { login?: boolean }) {
  const { data, error, mutate, isValidating } = useSession()
  const online = useOnlineStatus()
  const { defaultLanding } = useShellComposition()
  if (data && !data.authenticated && !login) return <Navigate to={pagePaths.login} replace />
  if (login && data?.authenticated) return <Navigate to={defaultLanding} replace />

  // Keep a verified dashboard mounted during connection failures so drafts survive.
  // The server still authorizes each API request; a confirmed expiry redirects above.
  return <>
    {login ? <LoginPage checkingSession={!data && isValidating} sessionUnavailable={!data || !!error || !online} /> : data?.authenticated ? <DashboardLayout /> : <DashboardFrameSkeleton />}
    {/* SWR exposes retry failures through `error`; consume the rejected promise too. */}
    {(error || !online) && <SessionBanner online={online} retrying={isValidating} onRetry={() => { void mutate().catch(() => undefined) }} />}
  </>
}

function DashboardLayout() {
  return <DashboardShell><Suspense fallback={<DashboardRouteSkeleton />}><Outlet /></Suspense></DashboardShell>
}

function RouteFallback() {
  const { pathname } = useLocation()
  const publicRoute = publicBrowserRoutes.find(route => matchesPagePath(route.path, pathname))
  if (publicRoute) return publicRoute.skeleton
  if (pathname === pagePaths.login) return <LoginPage checkingSession />
  return <DashboardFrameSkeleton />
}


export function App() {
  return <ConsoleWebComposition><BrowserRouter><RouteScrollReset /><Suspense fallback={<RouteFallback />}><Routes>
    {publicBrowserRoutes.map(route => <Route key={route.id} path={route.path} element={route.view} />)}
    <Route path={pagePaths.login} element={<SessionGate login />} />
    <Route element={<SessionGate />}>
      {Object.entries(dashboardViews).map(([page, element]) => <Route key={page} path={dashboardPages[page as DashboardPage].path} element={element} />)}
    </Route>
    <Route path="*" element={<NotFoundPage defaultLanding={pagePaths.overview} />} />
  </Routes></Suspense></BrowserRouter></ConsoleWebComposition>
}
