import { useState } from "react"
import useSWR from "swr"
import { ListChecksIcon, RefreshCwIcon } from "lucide-react"
import { useDashboardApi } from "@/components/dashboard/api-context"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TableBody, TableCell, TableRow } from "@/components/ui/table"
import { formatAppDateTime } from "@/lib/timezone"
import { RequestLogsTable } from "./request-logs-table"
import type { RequestLogsPage } from "@/lib/request-logs"
import { formatCost, formatDuration, formatTokenCount } from "@/lib/usage-display"

function Filter({ label, value, options, onChange }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (value: string) => void }) {
  return <Select value={value} onValueChange={value => { if (value !== null) onChange(value) }}>
    <SelectTrigger aria-label={label}><SelectValue>{options.find(option => option.id === value)?.name || value}</SelectValue></SelectTrigger>
    <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>
}

export function RequestLogsView() {
  const { workspaceId } = useDashboardApi()
  return <RequestLogsWorkspace key={workspaceId} />
}

function RequestLogsWorkspace() {
  const { fetcher, workspaceId } = useDashboardApi()
  const [days, setDays] = useState("1")
  const [status, setStatus] = useState("all")
  const [model, setModel] = useState("")
  const [range, setRange] = useState(() => makeRange("1"))
  const [cursors, setCursors] = useState<string[]>([])
  const params = new URLSearchParams({ ...range, status, model })
  const cursor = cursors.at(-1)
  if (cursor) params.set("cursor", cursor)
  const url = `/api/admin/request-logs?${params}`
  const { data, error, isLoading, isValidating } = useSWR<RequestLogsPage>(workspaceId ? [workspaceId, url] : null, () => fetcher<RequestLogsPage>(url), { keepPreviousData: false, revalidateOnFocus: false })
  function reset() { setCursors([]) }
  function refresh() {
    reset()
    setRange(makeRange(days))
  }
  return <DashboardPage spacing="normal">
    <Card>
      <CardHeader><CardTitle variant="icon"><ListChecksIcon aria-hidden="true" />Request Logs</CardTitle><CardDescription>Workspace history of recorded model attempts.</CardDescription></CardHeader>
      <CardContent spacing="flow" className="flex flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <Filter label="Date range" value={days} options={[{ id: "1", name: "Last 24 hours" }, { id: "7", name: "Last 7 days" }]} onChange={value => { setDays(value); setRange(makeRange(value)); reset() }} />
          <Filter label="Status" value={status} options={[{ id: "all", name: "All statuses" }, { id: "success", name: "Success" }, { id: "failed", name: "Failed" }]} onChange={value => { setStatus(value); reset() }} />
          <Filter label="Model" value={model} options={[{ id: "", name: "All models" }, ...(data?.models || []), ...(model && !data?.models.some(option => option.id === model) ? [{ id: model, name: model }] : [])]} onChange={value => { setModel(value); reset() }} />
          <Button variant="outline" size="sm" disabled={isValidating || !workspaceId} onClick={refresh}><RefreshCwIcon data-icon="inline-start" />Refresh</Button>
        </div>
        {error ? <Alert variant="destructive"><AlertDescription>Unable to load request logs. Try refreshing.</AlertDescription></Alert> : isLoading || !workspaceId ? <RequestLogsTable loading /> : !data?.events.length ? <EmptyState title="No recorded attempts" description="No recorded model attempts match this range and these filters." icon={ListChecksIcon} treatment="embedded" /> : <RequestLogsTable>
          <TableBody>{data.events.map(event => <TableRow key={event.id}>
            <TableCell><div className="font-semibold">{event.modelName || event.gatewayModelId}</div><div className="text-xs text-muted-foreground" title={event.id}>{event.id.slice(0, 8)} · {event.keyName || `Unknown key (${event.gatewayKeyId.slice(0, 8)})`}</div></TableCell>
            <TableCell><Badge variant={event.status >= 200 && event.status < 300 ? "secondary" : "destructive"}>{event.status >= 200 && event.status < 300 ? "Success" : "Failed"} · {event.status}</Badge></TableCell>
            <TableCell>{event.usageAvailable ? formatTokenCount(event.totalTokens) : "Unavailable"}<div className="text-xs text-muted-foreground">{event.usageAvailable ? `${event.usageCompleteness === "partial" ? "Partial · " : ""}${formatTokenCount(event.inputTokens)} in · ${formatTokenCount(event.cacheReadTokens + event.cacheCreationTokens)} cache · ${formatTokenCount(event.outputTokens)} out` : "Provider usage not recorded"}</div></TableCell>
            <TableCell>{event.pricingConfidence === "unpriced" ? "Unpriced" : formatCost(event.costMicros)}{event.pricingConfidence === "assumed" && <div className="text-xs text-muted-foreground">Estimated</div>}</TableCell>
            <TableCell>{formatDuration(event.durationMs)}</TableCell>
            <TableCell>{formatAppDateTime(event.completedAt)}</TableCell>
          </TableRow>)}</TableBody>
        </RequestLogsTable>}
      </CardContent>
      <CardFooter><div className="flex w-full flex-wrap justify-between gap-2"><span className="text-xs text-muted-foreground">Newest first · 25 per page</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!cursors.length || isLoading} onClick={() => setCursors(previous => previous.slice(0, -1))}>Newer</Button><Button variant="outline" size="sm" disabled={!data?.nextCursor || !!error || isLoading} onClick={() => { if (data?.nextCursor) setCursors(previous => [...previous, data.nextCursor!]) }}>Older</Button></div></div></CardFooter>
    </Card>
  </DashboardPage>
}

function makeRange(days: string) {
  const now = Date.now()
  return { from: new Date(now - Number(days) * 86_400_000).toISOString(), to: new Date(now).toISOString() }
}
