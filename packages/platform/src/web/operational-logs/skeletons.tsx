import { RefreshCwIcon, ClipboardIcon, Trash2Icon } from "lucide-react"
import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { logPageClassName } from "@rawroute/ui/page-layout"
import { LogToolbar } from "./logs/log-toolbar"
import { LogResults } from "./logs/log-results"

const noop = () => undefined
function ConsoleLogSkeleton({ global }: { global: boolean }) {
  return <main className={logPageClassName} aria-busy="true" aria-label="Loading logs" data-slot="dashboard-content-skeleton"><div className="mx-auto h-full max-w-7xl"><Card className="h-full"><CardHeader className="flex shrink-0 flex-col sm:grid"><CardTitle>{global ? "System Logs" : "Console Log"}</CardTitle><CardDescription>{global ? "Authentication, global administration, and service activity for this instance." : "Gateway and dashboard activity for the selected workspace."}</CardDescription><CardAction><div className="flex flex-wrap gap-2"><Button variant="outline" disabled><RefreshCwIcon />Refresh</Button><Button variant="outline" disabled><ClipboardIcon />Copy</Button><Button variant="destructive" disabled><Trash2Icon />Clear</Button></div></CardAction></CardHeader><CardContent spacing="flow" className="flex min-h-0 flex-1 flex-col"><LogToolbar disabled level="all" setLevel={noop} query="" setQuery={noop} source="all" setSource={noop} sources={[]} live setLive={noop} /><LogResults entries={[]} loading /></CardContent></Card></div></main>
}
export const observabilitySkeletons = { logs: <ConsoleLogSkeleton global={false} />, systemLogs: <ConsoleLogSkeleton global /> }
