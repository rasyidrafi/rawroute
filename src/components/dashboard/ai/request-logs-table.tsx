import type { ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getAppTimeZone } from "@/lib/timezone"

/** Keep loading and recorded rows in the same columns and horizontal scroll container. */
export function RequestLogsTable({ loading = false, children }: { loading?: boolean; children?: ReactNode }) {
  return <div role={loading ? "status" : undefined} aria-label={loading ? "Loading request logs" : undefined} aria-busy={loading || undefined}>
    <Table>
      <TableHeader><TableRow>
        <TableHead className="min-w-56">Request / model</TableHead>
        <TableHead className="min-w-32">Status</TableHead>
        <TableHead className="min-w-56">Tokens</TableHead>
        <TableHead className="min-w-28">Cost</TableHead>
        <TableHead className="min-w-24">Duration</TableHead>
        <TableHead className="min-w-48">Time ({getAppTimeZone()})</TableHead>
      </TableRow></TableHeader>
      {loading ? <TableBody>{Array.from({ length: 9 }, (_, index) => <TableRow key={index} variant="static" data-slot="request-log-skeleton-row">
        <TableCell><div aria-hidden="true" className="flex flex-col gap-2"><Skeleton motion="respect-preference" className="h-4 w-40" /><Skeleton motion="respect-preference" className="h-3 w-48" /></div></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" shape="pill" className="h-5 w-24" /></TableCell>
        <TableCell><div aria-hidden="true" className="flex flex-col gap-2"><Skeleton motion="respect-preference" className="h-4 w-14" /><Skeleton motion="respect-preference" className="h-3 w-48" /></div></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-5 w-20" /></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-5 w-16" /></TableCell>
        <TableCell><Skeleton aria-hidden="true" motion="respect-preference" className="h-5 w-40" /></TableCell>
      </TableRow>)}</TableBody> : children}
    </Table>
  </div>
}
