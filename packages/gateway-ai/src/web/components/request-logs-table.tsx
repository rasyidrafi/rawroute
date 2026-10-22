import type { ReactNode } from "react"
import { Skeleton } from "@rawroute/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@rawroute/ui/table"
import type { UsageEvent } from "../../contracts/domain"

export const requestLogMetadataDescription = "Requested or router-selected effort and declared tool definitions; unknown means no effort was recorded, and undeclared tools means no tool metadata was recorded. Not actual reasoning or executed tool calls."

export function RequestLogMetadata({ event }: { event: Pick<UsageEvent, "reasoningEffort" | "toolCount"> }) {
  return <div data-slot="request-log-metadata">
    <div className="font-medium">{event.reasoningEffort ?? "unknown"}</div>
    <div className="text-xs text-muted-foreground">{event.toolCount === undefined ? "undeclared tools" : `${event.toolCount} declared ${event.toolCount === 1 ? "tool" : "tools"}`}</div>
  </div>
}

export function RequestLogMetadataSkeleton() {
  return <div aria-hidden="true" className="flex flex-col gap-2"><Skeleton motion="respect-preference" className="h-4 w-16" /><Skeleton motion="respect-preference" className="h-3 w-20" /></div>
}

/** Keep loading and recorded rows in the same columns and horizontal scroll container. */
export function RequestLogsTable({ loading = false, children }: { loading?: boolean; children?: ReactNode }) {
  return <div className="min-w-0 max-w-full" role={loading ? "status" : undefined} aria-label={loading ? "Loading request logs" : undefined} aria-busy={loading || undefined}>
    <Table className="min-w-max">
      <TableHeader><TableRow>
        <TableHead className="min-w-56">Request / model</TableHead>
        <TableHead className="min-w-36" title={requestLogMetadataDescription}>Reasoning / tools</TableHead>
        <TableHead className="min-w-32">Key</TableHead>
        <TableHead className="min-w-32">Status</TableHead>
        <TableHead className="min-w-56">Tokens</TableHead>
        <TableHead className="min-w-28">Cost</TableHead>
        <TableHead className="min-w-24">Duration</TableHead>
        <TableHead className="min-w-48">Time</TableHead>
      </TableRow></TableHeader>
      {loading ? <TableBody>{Array.from({ length: 9 }, (_, index) => <TableRow key={index} variant="static" data-slot="request-log-skeleton-row">
        <TableCell><div aria-hidden="true" className="flex flex-col gap-2"><Skeleton motion="respect-preference" className="h-4 w-40" /><Skeleton motion="respect-preference" className="h-4 w-48" /><Skeleton motion="respect-preference" className="h-4 w-48" /><Skeleton motion="respect-preference" className="h-3 w-32" /></div></TableCell>
        <TableCell><RequestLogMetadataSkeleton /></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-4 w-24" /></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" shape="pill" className="h-5 w-24" /></TableCell>
        <TableCell><div aria-hidden="true" className="flex flex-col gap-2"><Skeleton motion="respect-preference" className="h-4 w-14" /><Skeleton motion="respect-preference" className="h-3 w-48" /></div></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-5 w-20" /></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-5 w-16" /></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-5 w-40" /></TableCell>
      </TableRow>)}</TableBody> : children}
    </Table>
  </div>
}
