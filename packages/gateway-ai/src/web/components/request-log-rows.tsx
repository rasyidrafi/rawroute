import { useId, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@rawroute/ui/badge"
import { Button } from "@rawroute/ui/button"
import { TableCell, TableRow } from "@rawroute/ui/table"
import { formatAppDateTime } from "@rawroute/observability/contracts/timezone"
import { formatCost, formatDuration, formatTokenCount } from "../../contracts/usage-display"
import { requestLogComplete, requestLogKeyLabel, type RequestLogDisplayEvent } from "../../contracts/request-logs"
import { RequestLogMetadata } from "./request-logs-table"
import { ServiceTierBadge } from "./service-tier-badge"

export function RequestModelId({ label, value }: { label: string; value?: string }) {
  return <div className="flex min-h-6 max-w-96 items-center gap-1 text-xs text-muted-foreground">
    <span className="shrink-0">{label}:</span><span className="min-w-0 whitespace-normal break-all font-mono" title={value === undefined ? "Not recorded" : undefined}>{value ?? "—"}</span>
    {value !== undefined && <Button variant="ghost" size="icon-xs" aria-label={`Copy ${label.toLowerCase()} model ${value}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); toast.success("Model ID copied") }
      catch { toast.error("Unable to copy to clipboard") }
    }}><CopyIcon /></Button>}
  </div>
}

function TokenCell({ event }: { event: RequestLogDisplayEvent }) {
  return <TableCell>{event.usageAvailable ? formatTokenCount(event.totalTokens) : "Unavailable"}<div className="text-xs text-muted-foreground">{event.usageAvailable ? `${event.usageCompleteness === "partial" ? "Partial · " : ""}${formatTokenCount(event.inputTokens)} in · ${formatTokenCount(event.cacheReadTokens + event.cacheCreationTokens)} cache · ${formatTokenCount(event.outputTokens)} out` : "Provider usage not recorded"}</div></TableCell>
}

function UsageCells({ event }: { event: RequestLogDisplayEvent }) {
  return <>
    <TokenCell event={event} />
    <TableCell>{event.pricingConfidence === "unpriced" ? "Unpriced" : formatCost(event.costMicros)}{event.pricingConfidence === "assumed" && <div className="text-xs text-muted-foreground">Estimated</div>}</TableCell>
  </>
}

function Status({ event, parent = false }: { event: RequestLogDisplayEvent; parent?: boolean }) {
  if (parent && !requestLogComplete(event)) return <Badge variant="outline" title="The final attempt has not been recorded. This request may still be running or its history may be incomplete.">Outcome pending / unavailable</Badge>
  const success = event.status >= 200 && event.status < 300
  return <Badge variant={success ? "secondary" : "destructive"}>{success ? "Success" : "Failed"} · {event.status}</Badge>
}

function ModelTitle({ event }: { event: RequestLogDisplayEvent }) {
  const name = event.routing?.modelName || event.modelName || event.gatewayModelId
  const routeName = event.routing?.routeName
  return <span className="font-semibold" title={event.routing ? undefined : "Historical label from current configuration; routing names were not recorded."}>
    {name}{routeName && routeName !== name && <span className="font-normal text-muted-foreground"> (as {routeName})</span>}
  </span>
}

function ModelIds({ event }: { event: RequestLogDisplayEvent }) {
  const shared = event.sharedUsage
  const resolved = shared?.role === "consumer"
    ? `${shared.peerWorkspaceId}/${shared.sourceGatewayModelId}`
    : event.routing?.modelId || shared?.sourceGatewayModelId
  return <>
    <RequestModelId label="Payload" value={event.requestedModel} />
    <RequestModelId label="Resolved" value={resolved} />
  </>
}

export function RequestAttemptRow({ event, nested = false, id }: { event: RequestLogDisplayEvent; nested?: boolean; id?: string }) {
  return <TableRow id={id} data-slot={nested ? "request-attempt-row" : "request-log-row"}>
    <TableCell><div className={nested ? "ml-3 border-l-2 border-border pl-4" : undefined}>
      {nested && <div className="text-xs text-muted-foreground">{(event.attemptIndex ?? 0) + 1} · {event.attemptIndex === 0 ? "Main" : "Fallback"}</div>}
      <div className="flex max-w-96 flex-wrap items-center gap-1"><ModelTitle event={event} /><ServiceTierBadge event={event} /></div>
      <ModelIds event={event} />
      <div className="text-xs text-muted-foreground" title={nested ? event.id : event.requestId || event.id}>{nested ? "Attempt" : event.requestId ? "Request" : "Historical attempt"}: {(nested ? event.id : event.requestId || event.id).slice(0, 8)}</div>
    </div></TableCell>
    <TableCell><RequestLogMetadata event={event} /></TableCell>
    <TableCell>{requestLogKeyLabel(event)}</TableCell>
    <TableCell><Status event={event} parent={!nested} /></TableCell>
    <UsageCells event={event} />
    <TableCell>{formatDuration(event.durationMs)}</TableCell>
    <TableCell>{formatAppDateTime(event.completedAt)}</TableCell>
  </TableRow>
}

export function requestGroupSummary(attempts: RequestLogDisplayEvent[]) {
  const knownUsage = attempts.filter(event => event.usageAvailable)
  const priced = attempts.filter(event => event.pricingConfidence !== "unpriced")
  const starts = attempts.map(event => event.startedAt ? Date.parse(event.startedAt) : Date.parse(event.completedAt) - event.durationMs)
  return {
    singleUsage: knownUsage.length === 1 ? knownUsage[0] : undefined,
    tokens: knownUsage.reduce((sum, event) => sum + event.totalTokens, 0),
    hasUsage: knownUsage.length > 0,
    partialUsage: knownUsage.length !== attempts.length || attempts.some(event => event.usageCompleteness === "partial" || event.usageCompleteness === "missing"),
    cost: priced.reduce((sum, event) => sum + event.costMicros, 0),
    hasCost: priced.length > 0,
    partialCost: priced.length !== attempts.length,
    estimated: priced.some(event => event.pricingConfidence === "assumed"),
    duration: Math.max(0, Math.max(...attempts.map(event => Date.parse(event.completedAt))) - Math.min(...starts)),
  }
}

function GroupUsageCells({ summary }: { summary: ReturnType<typeof requestGroupSummary> }) {
  return <>
    {summary.singleUsage ? <TokenCell event={summary.singleUsage} /> : <TableCell>{summary.hasUsage ? formatTokenCount(summary.tokens) : "Unavailable"}<div className="text-xs text-muted-foreground">{!summary.hasUsage ? "Provider usage not recorded" : summary.partialUsage ? "Known usage · partial" : "All attempts"}</div></TableCell>}
    <TableCell>{summary.hasCost ? formatCost(summary.cost) : "Unpriced"}<div className="text-xs text-muted-foreground">{[summary.partialCost ? "Partial cost" : "All attempts", summary.estimated ? "Estimated" : ""].filter(Boolean).join(" · ")}</div></TableCell>
  </>
}

function GroupIdentity({ final, count, expanded, id, toggle }: { final: RequestLogDisplayEvent; count: number; expanded: boolean; id: string; toggle: () => void }) {
  const requestId = final.requestId || final.id
  return <TableCell>
    <Button variant="ghost" size="sm" className="max-w-96 justify-start whitespace-normal text-left" aria-label={`${expanded ? "Collapse" : "Expand"} request ${requestId}`} aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={toggle}>
      {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}<ModelTitle event={final} />
    </Button>
    <ServiceTierBadge event={final} />
    <ModelIds event={final} />
    <div className="max-w-96 whitespace-normal text-xs text-muted-foreground" title={requestId}>Request: {requestId.slice(0, 8)} · {count} recorded {count === 1 ? "attempt" : "attempts"}</div>
  </TableCell>
}

export function RequestLogGroup({ attempts }: { attempts: RequestLogDisplayEvent[] }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const final = attempts.at(-1)!
  if (final.sharedUsage?.role === "owner" || (attempts.length === 1 && (final.attemptIndex ?? 0) === 0 && requestLogComplete(final))) return <RequestAttemptRow event={final} />
  const summary = requestGroupSummary(attempts)
  const variedMetadata = attempts.some(event => event.reasoningEffort !== final.reasoningEffort || event.toolCount !== final.toolCount)
  return <>
    <TableRow data-slot="request-group-row" variant="group">
      <GroupIdentity final={final} count={attempts.length} expanded={expanded} id={id} toggle={() => setExpanded(!expanded)} />
      <TableCell>{variedMetadata ? <span className="text-xs text-muted-foreground">Varies by attempt</span> : <RequestLogMetadata event={final} />}</TableCell>
      <TableCell>{requestLogKeyLabel(final)}</TableCell>
      <TableCell><Status event={final} parent /></TableCell>
      <GroupUsageCells summary={summary} />
      <TableCell>{formatDuration(summary.duration)}<div className="text-xs text-muted-foreground">Recorded span</div></TableCell>
      <TableCell>{formatAppDateTime(final.completedAt)}</TableCell>
    </TableRow>
    {expanded && attempts.map((event, index) => <RequestAttemptRow key={event.id} event={event} nested id={index === 0 ? id : undefined} />)}
  </>
}
