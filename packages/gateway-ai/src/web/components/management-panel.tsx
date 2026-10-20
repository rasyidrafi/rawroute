import { DashboardPage } from "@rawroute/ui/page-layout"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"

export function sanitizeNonNegativeDraft(value: string) {
  return value.includes("-") ? "0" : value
}

export function Panel({ title, description, icon, refresh, loading, children }: { title: string; description: string; icon: React.ReactNode; refresh?: () => void; loading?: boolean; children: React.ReactNode }) {
  return <DashboardPage spacing="normal"><Card><CardHeader><CardTitle variant="icon">{icon}{title}</CardTitle><CardDescription>{description}</CardDescription>{refresh && <CardAction><Button aria-busy={loading} variant="outline" onClick={refresh} disabled={loading}>{loading ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction>}</CardHeader><CardContent spacing="stack">{children}</CardContent></Card></DashboardPage>
}
