import { lazy, Suspense } from "react"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router"

import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { DashboardRouteSkeleton } from "@/components/dashboard-skeleton"
import { DashboardFrameSkeleton } from "@/components/dashboard/frame-skeleton"
import { PublicPageLayout } from "@/components/public-page-layout"
import { UsageSkeleton } from "@/components/dashboard/ai/usage-skeleton"
import { SessionBanner } from "@/components/session-banner"
import { useSession } from "@/hooks/use-session"
import { useOnlineStatus } from "@/hooks/use-online-status"
import { dashboardViews } from "@/components/dashboard/route-views"
import { dashboardPages, type DashboardPage, pagePaths } from "@/lib/dashboard/routes"
import { NotFoundPage } from "@/pages/not-found"
import { LoginPage } from "@/pages/login"

const PublicPage = lazy(() => import("@/pages/public").then((module) => ({ default: module.PublicPage })))

function SessionGate({ login = false }: { login?: boolean }) {
  const { data, error, mutate, isValidating } = useSession()
  const online = useOnlineStatus()
  if (data && !data.authenticated && !login) return <Navigate to={pagePaths.login} replace />
  if (login && data?.authenticated) return <Navigate to={pagePaths.dashboard} replace />

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
  if (pathname === pagePaths.home) return <PublicPageLayout loading><UsageSkeleton /></PublicPageLayout>
  if (pathname === pagePaths.login) return <LoginPage checkingSession />
  return <DashboardFrameSkeleton />
}


export function App() {
  return <BrowserRouter><Suspense fallback={<RouteFallback />}><Routes>
    <Route path={pagePaths.home} element={<PublicPage />} />
    <Route path={pagePaths.login} element={<SessionGate login />} />
    <Route element={<SessionGate />}>
      {Object.entries(dashboardViews).map(([page, element]) => <Route key={page} path={dashboardPages[page as DashboardPage].path} element={element} />)}
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Routes></Suspense></BrowserRouter>
}
