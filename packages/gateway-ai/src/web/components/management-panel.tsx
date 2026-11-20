import { DashboardPage } from "@rawroute/ui/page-layout"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"
import { RefreshScrim } from "@rawroute/ui/loading-layout"

export function sanitizeNonNegativeDraft(value: string) {
  return value.includes("-") ? "0" : value
}

export function Panel({ title, description, icon, refresh, loading, refreshing, children }: { title: string; description: string; icon: React.ReactNode; refresh?: () => void; loading?: boolean; refreshing?: boolean; children: React.ReactNode }) {
  return <DashboardPage spacing="normal"><Card className="relative" aria-busy={refreshing || undefined}>{refreshing && <RefreshScrim />}<CardHeader><CardTitle variant="icon">{icon}{title}</CardTitle><CardDescription>{description}</CardDescription>{refresh && <CardAction><Button aria-busy={loading} variant="outline" onClick={refresh} disabled={loading}>{loading ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction>}</CardHeader><CardContent spacing="stack">{children}</CardContent></Card></DashboardPage>
}
