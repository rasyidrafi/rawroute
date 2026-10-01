import type { ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { SlidersHorizontalIcon } from "lucide-react"
import { pagePaths } from "@/lib/dashboard/routes"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
export function CliProxySettingsLayout({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  const { state } = useLocation()
  return <DashboardPage spacing="normal" aria-busy={loading} data-slot={loading ? "dashboard-content-skeleton" : undefined}>
    <div className="space-y-2"><Link to={pagePaths.cliproxy} state={state} className="text-sm text-muted-foreground underline">Back to CLIProxyAPI</Link><h2 className="text-2xl font-semibold tracking-tight">CLIProxyAPI settings</h2><p className="text-sm text-muted-foreground">Configure the shared provider engine for every workspace.</p></div>
    <div className="w-full max-w-3xl">{children}</div>
  </DashboardPage>
}
export function CliProxySettingsCard({ children }: { children: ReactNode }) {
  return <Card><CardHeader><CardTitle variant="icon"><SlidersHorizontalIcon className="size-5" />Engine settings</CardTitle><CardDescription>Logging, statistics, retries, and routing for CLIProxyAPI.</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}
