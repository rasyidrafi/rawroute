import { lazy, Suspense } from "react"
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router"

import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { DashboardRouteSkeleton } from "@/components/dashboard-skeleton"
import { DashboardFrameSkeleton } from "@/components/dashboard/frame-skeleton"
import { PublicPageLayout } from "@/components/public-page-layout"
import { UsageSkeleton } from "@/components/dashboard/ai/usage-skeleton"
import { Button } from "@/components/ui/button"
import { useSession } from "@/hooks/use-session"
import { dashboardViews } from "@/components/dashboard/route-views"
import { dashboardPages, type DashboardPage, pagePaths } from "@/lib/dashboard/routes"
import { LoginPage } from "@/pages/login"

const PublicPage = lazy(() => import("@/pages/public").then((module) => ({ default: module.PublicPage })))

function SessionGate({ login = false }: { login?: boolean }) {
  const { data, error, mutate } = useSession()
  if (error) return <main className="p-6" role="alert"><p>Unable to check your session.</p><Button onClick={() => void mutate()}>Retry</Button></main>
  if (!data) return login ? <LoginPage checkingSession /> : <DashboardFrameSkeleton />
  if (login) return data.authenticated ? <Navigate to={pagePaths.dashboard} replace /> : <LoginPage />
  return data.authenticated ? <DashboardLayout /> : <Navigate to={pagePaths.login} replace />
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
    <Route path="*" element={<main className="p-6"><h1>Page not found</h1><Link to="/">Return to RawRoute</Link></main>} />
  </Routes></Suspense></BrowserRouter>
}
