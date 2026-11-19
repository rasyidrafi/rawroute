import { Badge } from "./badge"
import { Label } from "./label"
import type { ReactNode } from "react"
import { LoadingSpinner } from "./loading-spinner"
import { Skeleton } from "./skeleton"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Table, TableBody, TableCell, TableColumns, TableRow } from "./table"

/** Marks retained data as stale during a user-initiated refetch. The parent card must be positioned; background polling must not render this. */
export function RefreshScrim({ label = "Refreshing data..." }: { label?: string }) {
  return <div className="pointer-events-none absolute inset-0 z-20 flex items-start justify-end rounded-inherit bg-background/40 p-3 backdrop-blur-scrim"><Badge variant="refreshing"><LoadingSpinner className="size-3.5" />{label}</Badge></div>
}

export function LoadingCard({ title, description, action = false, children, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <Card className={className}><CardHeader><CardTitle variant={typeof title === "string" ? "default" : "icon"}>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}{action && <CardAction>{action === true ? <Skeleton className="h-8 w-28" /> : action}</CardAction>}</CardHeader><CardContent spacing="stack">{children}</CardContent></Card>
}

export function TableSkeletonRows({ columns, rows = 3, actionColumn = false }: { columns: number; rows?: number; actionColumn?: boolean }) {
  return <>{Array.from({ length: rows }, (_, row) => <TableRow key={row} aria-hidden="true">{Array.from({ length: columns }, (_, column) => actionColumn && column === columns - 1 ? <TableCell key={column} variant="sticky-action"><div className="flex justify-center"><Skeleton className="size-7" /></div></TableCell> : <TableCell key={column}><Skeleton className={column === 0 ? "my-2 h-4 w-32 max-w-full" : "my-2 h-4 w-20 max-w-full"} /></TableCell>)}</TableRow>)}</>
}

export function LoadingTable({ columns, rows = 3, actionColumn = false, scrollable = true }: { columns: string[]; rows?: number; actionColumn?: boolean; scrollable?: boolean }) {
  return <Table scrollable={scrollable}><TableColumns columns={columns.map((label, index) => ({ id: String(index), label, variant: actionColumn && index === columns.length - 1 ? "sticky-action" : "default" }))} /><TableBody><TableSkeletonRows columns={columns.length} rows={rows} actionColumn={actionColumn} /></TableBody></Table>
}

export function FormSkeleton({ labels }: { labels: string[] }) {
  return <div className="flex flex-col gap-5">{labels.map(label => <div key={label} className="flex flex-col gap-2"><Label>{label}</Label><Skeleton className="h-8 w-full" /></div>)}<Skeleton className="h-8 w-32" /></div>
}

export function LogLinesSkeleton() {
  return <div aria-busy="true" aria-label="Loading log entries" className="flex flex-col gap-2">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className={index % 3 === 0 ? "h-4 w-2/3" : "h-4 w-full"} />)}</div>
}
