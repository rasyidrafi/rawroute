import { logPageClassName } from "@/components/dashboard/page-layout"
import { useState } from "react"
import { ClipboardIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { useConsoleLogs } from "@/hooks/use-console-logs"
import { formatLog } from "@/lib/logging/format"
import type { LogLevel, LogScope } from "@/lib/logging/types"
import { reportEvent } from "@/lib/logging/client"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { LoadingSpinner } from "@/components/loading-spinner"
import { LogResults, LogStatus } from "./log-results"
import { LogToolbar } from "./log-toolbar"

export function LogPanel({ scope }: { scope: LogScope }) {
  const [live, setLive] = useState(true)
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState<LogLevel | "all">("all")
  const [source, setSource] = useState("all")
  const [clearOpen, setClearOpen] = useState(false)
  const { snapshot, error, clearError, isInitialLoading, isRefreshing, isClearing, busy, refresh, clear } = useConsoleLogs(live, scope)
  const entries = snapshot?.entries ?? []
  const sources = [...new Set(entries.map(entry => entry.source))].sort()
  const visible = entries.filter(entry => (level === "all" || entry.level === level) && (source === "all" || entry.source === source) && formatLog(entry).toLowerCase().includes(query.toLowerCase()))
  const global = scope.kind === "global"
  const page = global ? "systemLogs" : "logs"
  const title = global ? "System Logs" : "Console Log"
  async function copy() {
    try {
      await navigator.clipboard.writeText(visible.map(formatLog).join("\n"))
      reportEvent({ event: "logs.copied", page }, scope)
      toast.success("Logs copied")
    } catch { toast.error("Unable to copy logs") }
  }
  async function clearHistory() {
    if (await clear()) { setClearOpen(false); toast.success("Log history cleared") }
  }
  function toggleLive(value: boolean) {
    setLive(value)
    reportEvent({ event: value ? "logs.resumed" : "logs.paused", page }, scope)
    if (value) void refresh()
  }
  return <main className={logPageClassName}>
    <div className="mx-auto h-full max-w-7xl"><Card className="h-full">
      <CardHeader className="flex shrink-0 flex-col sm:grid"><CardTitle>{title}</CardTitle><CardDescription>{global ? "Authentication, global administration, and service activity for this instance." : "Gateway and dashboard activity for the selected workspace."} History is kept in memory until the server restarts.</CardDescription><CardAction><div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>{isRefreshing ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button>
        <Button variant="outline" disabled={!visible.length} onClick={() => void copy()}><ClipboardIcon />Copy</Button>
        <Button variant="destructive" disabled={busy || !entries.length} onClick={() => setClearOpen(true)}><Trash2Icon />Clear</Button>
      </div></CardAction></CardHeader>
      <CardContent spacing="flow" className="flex min-h-0 flex-1 flex-col">
        <LogToolbar level={level} setLevel={setLevel} query={query} setQuery={setQuery} source={source} setSource={setSource} sources={sources} live={live} setLive={toggleLive} />
        <LogStatus count={visible.length} snapshot={snapshot} live={live} />
        {error && <p className="text-sm text-destructive" role="alert">{error} Existing entries may be stale.</p>}
        <LogResults entries={visible} loading={isInitialLoading} />
      </CardContent>
    </Card></div>
    <AlertDialog open={clearOpen} onOpenChange={setClearOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Clear {global ? "system" : "console"} logs?</AlertDialogTitle><AlertDialogDescription>This clears all retained {global ? "global" : "workspace"} entries for every administrator, including entries hidden by filters. Other scopes are unaffected.</AlertDialogDescription></AlertDialogHeader>{clearError && <p role="alert" className="text-sm text-destructive">{clearError}</p>}<AlertDialogFooter><AlertDialogCancel disabled={isClearing}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={isClearing} onClick={event => { event.preventDefault(); void clearHistory() }}>{isClearing && <LoadingSpinner />}Clear logs</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </main>
}
