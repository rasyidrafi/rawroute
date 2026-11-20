import { Badge } from "@rawroute/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { toolPages } from "../contracts/pages"

function ToolsSkeleton() {
  return <DashboardPage spacing="normal" width="narrow" aria-busy="true" aria-label="Loading dashboard" data-slot="dashboard-content-skeleton" data-variant="tool-gateway"><Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>Executor integration</CardTitle><Badge variant="secondary">Checking</Badge><Badge variant="secondary">API-only</Badge><Badge variant="outline">Shared deployment</Badge></div><CardDescription>Connect to Executor with a RawRoute gateway key. Browser sign-in and MCP aren’t available here.</CardDescription></CardHeader><CardContent spacing="compact-stack"><div role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Checking the optional Executor service.</div></CardContent></Card></DashboardPage>
}
export const toolsSkeletons = Object.fromEntries(Object.keys(toolPages).map(id => [id, <ToolsSkeleton key={id} />]))
