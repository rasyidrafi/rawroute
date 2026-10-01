import { Label } from "@/components/ui/label"
import type { ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableColumns, TableRow } from "@/components/ui/table"

export function LoadingCard({ title, description, action = false, children, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <Card className={className}><CardHeader><CardTitle variant={typeof title === "string" ? "default" : "icon"}>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}{action && <CardAction>{action === true ? <Skeleton className="h-8 w-28" /> : action}</CardAction>}</CardHeader><CardContent spacing="stack">{children}</CardContent></Card>
}

export function TableSkeletonRows({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return <>{Array.from({ length: rows }, (_, row) => <TableRow key={row} aria-hidden="true">{Array.from({ length: columns }, (_, column) => <TableCell key={column}><Skeleton className={column === 0 ? "my-2 h-4 w-32 max-w-full" : "my-2 h-4 w-20 max-w-full"} /></TableCell>)}</TableRow>)}</>
}

export function LoadingTable({ columns, rows = 3 }: { columns: string[]; rows?: number }) {
  return <Table><TableColumns columns={columns.map((label, index) => ({ id: String(index), label }))} /><TableBody><TableSkeletonRows columns={columns.length} rows={rows} /></TableBody></Table>
}

export function FormSkeleton({ labels }: { labels: string[] }) {
  return <div className="flex flex-col gap-5">{labels.map(label => <div key={label} className="flex flex-col gap-2"><Label>{label}</Label><Skeleton className="h-8 w-full" /></div>)}<Skeleton className="h-8 w-32" /></div>
}

export function LogLinesSkeleton() {
  return <div aria-busy="true" aria-label="Loading log entries" className="space-y-2">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className={index % 3 === 0 ? "h-4 w-2/3" : "h-4 w-full"} />)}</div>
}
