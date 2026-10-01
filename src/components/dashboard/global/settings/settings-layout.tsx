import type { ReactNode } from "react"
import { LockKeyholeIcon } from "lucide-react"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function SettingsLayout({ password, loading = false }: { password: ReactNode; loading?: boolean }) {
  return <DashboardPage spacing="normal" aria-busy={loading} data-slot={loading ? "dashboard-content-skeleton" : undefined}>
    <div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Settings</h1><p className="text-sm text-muted-foreground">Manage RawRoute administrator access across all workspaces.</p></div>
    <div className="w-full max-w-2xl">{password}</div>
  </DashboardPage>
}

export function PasswordSettingsCard({ children }: { children: ReactNode }) {
  return <Card><CardHeader><CardTitle variant="icon"><LockKeyholeIcon className="size-5" />Admin password</CardTitle><CardDescription>Update the administrator password used across all workspaces.</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}
