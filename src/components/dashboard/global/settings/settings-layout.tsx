import type { ReactNode } from "react"
import { LockKeyholeIcon, SlidersHorizontalIcon } from "lucide-react"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function SettingsLayout({ gateway, password, loading = false }: { gateway: ReactNode; password: ReactNode; loading?: boolean }) {
  return <DashboardPage spacing="normal" aria-busy={loading} data-slot={loading ? "dashboard-content-skeleton" : undefined}>
    <div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Settings</h1><p className="text-sm text-muted-foreground">Manage gateway behavior and administrator access across all workspaces.</p></div>
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-slot="settings-grid">{gateway}{password}</div>
  </DashboardPage>
}

export function GatewaySettingsCard({ children }: { children: ReactNode }) {
  return <Card><CardHeader><CardTitle variant="icon"><SlidersHorizontalIcon className="size-5" />Global gateway settings</CardTitle><CardDescription>Control the shared CLIProxy service for every workspace.</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}

export function PasswordSettingsCard({ children }: { children: ReactNode }) {
  return <Card><CardHeader><CardTitle variant="icon"><LockKeyholeIcon className="size-5" />Admin password</CardTitle><CardDescription>Update the administrator password used across all workspaces.</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}
