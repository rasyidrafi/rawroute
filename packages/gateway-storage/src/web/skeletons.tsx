import type { ReactNode } from "react"
import { DatabaseIcon, KeyRoundIcon, PlugIcon } from "lucide-react"
import { Button } from "@rawroute/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { LoadingCard, LoadingTable } from "@rawroute/ui/loading-layout"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Skeleton } from "@rawroute/ui/skeleton"
import { storagePages } from "../contracts/pages"

type StoragePage = keyof typeof storagePages

const resourceContent = {
  storageConnections: <LoadingCard title="Connections" description="Manage the S3-compatible services that store your workspace objects." action={<Button disabled><PlugIcon />Add connection</Button>}><LoadingTable columns={["Connection", "Endpoint", "Capabilities", ""]} actionColumn /></LoadingCard>,
  storageBuckets: <LoadingCard title="Buckets" description="Make existing upstream buckets available under workspace-specific names." action={<Button disabled><DatabaseIcon />Attach bucket</Button>}><LoadingTable columns={["Gateway bucket", "Upstream bucket", "Connection", "Status", ""]} actionColumn /></LoadingCard>,
  storageKeys: <LoadingCard title="Client keys" description="Issue and manage credentials with access limited to selected buckets and actions." action={<Button disabled><KeyRoundIcon />Create key</Button>}><LoadingTable columns={["Client key", "Access key ID", "Buckets", "Actions", "Status", ""]} actionColumn /></LoadingCard>,
} satisfies Partial<Record<StoragePage, ReactNode>>

function OverviewSkeleton() {
  return <DashboardPage spacing="normal" aria-busy="true" aria-label="Loading Storage Gateway" data-slot="dashboard-content-skeleton" data-variant="storage-overview">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold tracking-tight">Storage Gateway</h2><p className="mt-1 text-sm text-muted-foreground">Workspace storage access, client keys, and recovery.</p></div><Button variant="outline" disabled>Refresh</Button></div>
    <div className="grid gap-4 sm:grid-cols-3">{["Connections", "Attached buckets", "Active client keys"].map(label => <Card key={label}><CardHeader><CardDescription>{label}</CardDescription><CardTitle variant="metric"><Skeleton className="h-9 w-16" /></CardTitle></CardHeader></Card>)}</div>
    <LoadingCard title="Connect an S3 client" description="Use the Storage S3 endpoint configured for this deployment, separate from the dashboard address."><Skeleton className="h-16 w-full" /></LoadingCard>
    <LoadingCard title="Manage storage" description="Configure connections, buckets, and client access for this workspace."><div className="grid gap-3 sm:grid-cols-3">{[{ id: "connections", Icon: PlugIcon }, { id: "buckets", Icon: DatabaseIcon }, { id: "keys", Icon: KeyRoundIcon }].map(({ id, Icon }) => <div key={id} className="rounded-lg border p-4"><Icon className="size-4" /><Skeleton className="mt-3 h-4 w-28" /><Skeleton className="mt-2 h-3 w-36" /></div>)}</div></LoadingCard>
    <LoadingCard title="Multipart recovery" description="Resolve uploads that need review before detaching their mappings."><LoadingTable columns={["Bucket", "Object key", "Connection / key", "Status", ""]} actionColumn rows={2} /></LoadingCard>
  </DashboardPage>
}

export function StorageRouteSkeleton({ page }: { page: StoragePage }) {
  if (page === "storageOverview") return <OverviewSkeleton />
  return <DashboardPage aria-busy="true" aria-label={`Loading ${storagePages[page].title.toLowerCase()}`} data-slot="dashboard-content-skeleton" data-variant="storage">
    {resourceContent[page]}
  </DashboardPage>
}

export const storageSkeletons = Object.fromEntries(Object.keys(storagePages).map(page => [page, <StorageRouteSkeleton key={page} page={page as StoragePage} />]))
