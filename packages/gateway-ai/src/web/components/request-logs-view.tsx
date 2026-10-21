import { useId, useState } from "react"
import { useRequestLogs } from "../use-request-logs"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"
import { ListChecksIcon, RefreshCwIcon } from "lucide-react"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@rawroute/ui/card"
import { EmptyState } from "@rawroute/ui/empty-state"
import { Button } from "@rawroute/ui/button"
import { Checkbox } from "@rawroute/ui/checkbox"
import { Alert, AlertDescription } from "@rawroute/ui/alert"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"
import { TableBody } from "@rawroute/ui/table"
import { RequestLogsTable } from "./request-logs-table"
import { RequestLogGroup } from "./request-log-rows"
import { groupRequestLogEvents, requestLogGroupId, type RequestLogDisplayEvent } from "../../contracts/request-logs"

function Filter({ label, value, options, onChange }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (value: string) => void }) {
  const id = useId()
  return <div className="flex min-w-0 max-w-full items-center gap-2">
    <label htmlFor={id} className="shrink-0 text-xs font-medium text-muted-foreground">{label}</label>
    <Select value={value} onValueChange={value => { if (value !== null) onChange(value) }}>
    <SelectTrigger id={id} aria-label={label} className="min-w-0"><SelectValue>{options.find(option => option.id === value)?.name || value}</SelectValue></SelectTrigger>
    <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </div>
}

function requestLogOptions(allLabel: string, selected: string, options: { id: string; name: string }[] = []) {
  const missing = selected && !options.some(option => option.id === selected) ? [{ id: selected, name: selected }] : []
  return [{ id: "", name: allLabel }, ...options, ...missing]
}

export function RequestLogsView() {
  const { workspaceId } = useDashboardApi()
  return <RequestLogsWorkspace key={workspaceId} />
}

function RequestLogsWorkspace() {
  const { workspaceId } = useDashboardApi()
  const [days, setDays] = useState("1")
  const [status, setStatus] = useState("all")
  const [model, setModel] = useState("")
  const [keyId, setKeyId] = useState("")
  const { data, error, isLoading, isValidating, live, toggleLive, refresh, older, newer, hasNewer } = useRequestLogs(days, status, model, keyId)
  return <DashboardPage spacing="normal">
    <Card>
      <CardHeader><CardTitle variant="icon"><ListChecksIcon aria-hidden="true" />Request Logs</CardTitle><CardDescription>Workspace requests with their recorded main and fallback attempts.</CardDescription></CardHeader>
      <CardContent spacing="flow" className="flex flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <Filter label="Date range" value={days} options={[{ id: "1", name: "Last 24 hours" }, { id: "7", name: "Last 7 days" }]} onChange={setDays} />
          <Filter label="Status" value={status} options={[{ id: "all", name: "All statuses" }, { id: "success", name: "Success" }, { id: "failed", name: "Failed" }, { id: "recovered", name: "Recovered by fallback" }, { id: "incomplete", name: "Pending / incomplete" }]} onChange={setStatus} />
          <Filter label="Key" value={keyId} options={requestLogOptions("All keys", keyId, data?.keys)} onChange={setKeyId} />
          <Filter label="Model" value={model} options={requestLogOptions("All models", model, data?.models)} onChange={setModel} />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" focusableWhenDisabled disabled={!workspaceId || isValidating} onClick={refresh}>{isValidating ? <LoadingSpinner /> : <RefreshCwIcon data-icon="inline-start" />}Refresh</Button>
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm"><Checkbox checked={live} onCheckedChange={toggleLive} /><span aria-hidden="true" className={live ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-muted-foreground"} />{live ? "Live" : "Paused"}</label>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Updates every 3 seconds. Browsing older logs pauses live updates. Status filters use the final request outcome; expand a request to see failed attempts.</p>
        {error && <Alert variant="destructive"><AlertDescription>Unable to load request logs. Try refreshing. Existing entries may be stale.</AlertDescription></Alert>}
        <RequestLogResults data={data} loading={isLoading || !workspaceId} failed={!!error} />
      </CardContent>
      <CardFooter><div className="flex w-full flex-wrap justify-between gap-2"><span className="text-xs text-muted-foreground">Newest first · 25 requests per page</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!hasNewer || isLoading} onClick={newer}>Newer</Button><Button variant="outline" size="sm" disabled={!data?.nextCursor || !!error || isLoading} onClick={older}>Older</Button></div></div></CardFooter>
    </Card>
  </DashboardPage>
}

export function RequestLogResults({ data, loading, failed }: { data: { events: RequestLogDisplayEvent[] } | undefined; loading: boolean; failed: boolean }) {
  if (!data && loading) return <RequestLogsTable loading />
  if (!data?.events.length) return !failed && <EmptyState title="No recorded attempts" description="No recorded model attempts match this range and these filters." icon={ListChecksIcon} treatment="embedded" />
  return <RequestLogsTable>
          <TableBody>{groupRequestLogEvents(data.events).map(attempts => <RequestLogGroup key={requestLogGroupId(attempts[0]!)} attempts={attempts} />)}</TableBody>
        </RequestLogsTable>
}
