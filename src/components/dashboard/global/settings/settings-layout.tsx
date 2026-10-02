import type { ReactNode } from "react"
import { LockKeyholeIcon } from "lucide-react"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function SettingsLayout({ password, appearance, loading = false }: { password: ReactNode; appearance: ReactNode; loading?: boolean }) {
  return <DashboardPage spacing="normal" aria-busy={loading} data-slot={loading ? "dashboard-content-skeleton" : undefined}>
    <div className="flex flex-col gap-1"><h2 className="text-2xl font-semibold tracking-tight">Global settings</h2><p className="text-sm text-muted-foreground">Manage administrator access and personalize your experience.</p></div>
    <div className="grid items-start gap-6 xl:grid-cols-2">{password}{appearance}</div>
  </DashboardPage>
}

export function PasswordSettingsCard({ children }: { children: ReactNode }) {
  return <Card><CardHeader><CardTitle variant="icon"><LockKeyholeIcon aria-hidden="true" />Admin password</CardTitle><CardDescription>Update the administrator password used across all workspaces.</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}
